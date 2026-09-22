const { requestUrl } = require("obsidian");
const {
  consumeServerSentEvents,
  isSuccessfulResponse,
  openStreamingResponse,
  readFetchResponse
} = require("../StreamingTransport");
const {
  DEFAULT_ANTHROPIC_API_VERSION,
  DEFAULT_ANTHROPIC_BASE_ENDPOINT,
  DEFAULT_ANTHROPIC_MAX_OUTPUT_TOKENS
} = require("../../constants");

const SAFE_RESPONSE_HEADER_NAMES = new Set([
  "request-id",
  "retry-after"
]);
const SAFE_ANTHROPIC_EVENT_TYPES = new Set([
  "content_block_delta",
  "content_block_start",
  "content_block_stop",
  "error",
  "message_delta",
  "message_start",
  "message_stop",
  "ping"
]);
const SAFE_ANTHROPIC_CONTENT_BLOCK_TYPES = new Set([
  "redacted_thinking",
  "text",
  "thinking",
  "tool_use"
]);
const SAFE_ANTHROPIC_STOP_REASONS = new Set([
  "end_turn",
  "max_tokens",
  "model_context_window_exceeded",
  "pause_turn",
  "refusal",
  "stop_sequence",
  "tool_use"
]);
const SAFE_ANTHROPIC_SERVICE_TIERS = new Set([
  "auto",
  "batch",
  "priority",
  "standard",
  "standard_only"
]);

class AnthropicClient {
  constructor(baseUrl, apiKeyResolver = "", options = {}) {
    this.baseUrl = String(baseUrl || DEFAULT_ANTHROPIC_BASE_ENDPOINT).replace(/\/$/, "");
    this.apiKeyResolver = typeof apiKeyResolver === "function"
      ? apiKeyResolver
      : () => apiKeyResolver;
    this.apiVersion = options.apiVersion || DEFAULT_ANTHROPIC_API_VERSION;
    this.maxOutputTokens = Number.isInteger(options.maxOutputTokens) && options.maxOutputTokens > 0
      ? options.maxOutputTokens
      : DEFAULT_ANTHROPIC_MAX_OUTPUT_TOKENS;
    this.promptCaching = options.promptCaching !== false;
    this.promptCacheTtl = options.promptCacheTtl === "1h" ? "1h" : "5m";
    this.diagnostics = options.diagnostics ?? null;
    this.fetch = options.fetch;
  }

  async createHeaders(extraHeaders = {}) {
    const headers = {
      Accept: "application/json",
      "anthropic-version": this.apiVersion,
      ...extraHeaders
    };
    const apiKey = String((await Promise.resolve(this.apiKeyResolver())) ?? "").trim();
    if (apiKey) {
      headers["x-api-key"] = apiKey;
    }
    return headers;
  }

  async listModels() {
    const models = [];
    let afterId = "";

    for (let page = 0; page < 10; page += 1) {
      const query = new URLSearchParams({ limit: "1000" });
      if (afterId) {
        query.set("after_id", afterId);
      }
      const response = await this.sendRequest({
        url: `${this.baseUrl}/v1/models?${query.toString()}`,
        method: "GET",
        headers: await this.createHeaders()
      }, "provider.anthropic.models.request.failed");
      const jsonRead = readResponseJson(response);
      if (response.status < 200 || response.status >= 300) {
        throw createAnthropicHttpError("Model list request", response, jsonRead);
      }

      const data = jsonRead.hasJson ? jsonRead.value : null;
      if (!Array.isArray(data?.data)) {
        throw new Error("Anthropic returned an invalid model list response.");
      }
      models.push(...data.data
        .map((model) => typeof model?.id === "string" ? model.id.trim() : "")
        .filter(Boolean));

      if (data.has_more !== true || typeof data.last_id !== "string" || !data.last_id.trim()) {
        break;
      }
      afterId = data.last_id.trim();
    }

    return Array.from(new Set(models));
  }

  async testConnection() {
    const models = await this.listModels();
    return {
      modelCount: models.length,
      models
    };
  }

  async createMessage(model, messages, signal = null, options = {}) {
    const modelId = String(model ?? "").trim();
    if (!modelId) {
      throw new Error("Select an Anthropic model before sending a message.");
    }

    const requestedNativeTools = normalizeNativeTools(options.nativeTools);
    const mapped = createAnthropicRequestMessages(
      messages,
      options.providerContext,
      options.toolResults,
      options.continuationMessages
    );
    const retainedNativeTools = normalizeNativeTools(mapped.retainedNativeTools);
    const suppressNativeToolCalls = requestedNativeTools.length === 0 && retainedNativeTools.length > 0;
    const nativeTools = requestedNativeTools.length > 0 ? requestedNativeTools : retainedNativeTools;
    const body = {
      model: modelId,
      max_tokens: this.maxOutputTokens,
      messages: mapped.messages,
      stream: true
    };
    if (mapped.system.length > 0) {
      body.system = mapped.system;
    }
    if (nativeTools.length > 0) {
      body.tools = createAnthropicToolDeclarations(nativeTools);
      body.tool_choice = { type: suppressNativeToolCalls ? "none" : "auto" };
    }
    if (this.promptCaching) {
      body.cache_control = {
        type: "ephemeral",
        ...(this.promptCacheTtl === "1h" ? { ttl: "1h" } : {})
      };
    }

    const request = {
      url: `${this.baseUrl}/v1/messages`,
      method: "POST",
      headers: await this.createHeaders({
        Accept: "text/event-stream",
        "Content-Type": "application/json"
      }),
      body: JSON.stringify(body),
      ...(signal ? { signal } : {})
    };
    let response;
    let parsed;
    let streamEventCount = null;
    if (typeof options.onProgress === "function") {
      const streamed = await this.sendStreamingRequest(request, modelId, nativeTools, options.onProgress);
      response = streamed.response;
      parsed = streamed.parsed;
      streamEventCount = streamed.eventCount;
    } else {
      response = await this.sendRequest(
        request,
        "provider.anthropic.chat.request.failed",
        modelId
      );
    }
    const jsonRead = readResponseJson(response);

    if (response.status < 200 || response.status >= 300) {
      await this.logDiagnostic("provider.anthropic.chat.response.failed", {
        endpoint: summarizeEndpoint(this.baseUrl),
        model: modelId,
        response: createAnthropicErrorSummary(response, jsonRead)
      });
      throw createAnthropicHttpError("Anthropic Messages request", response, jsonRead);
    }

    parsed = parsed ?? parseAnthropicStream(readResponseText(response), nativeTools);
    const metadata = createAnthropicResponseMetadata(parsed);
    await this.logDiagnostic("provider.anthropic.chat.response.received", {
      endpoint: summarizeEndpoint(this.baseUrl),
      model: modelId,
      response: {
        ...createAnthropicResponseSummary(response, parsed),
        ...(Number.isInteger(streamEventCount) ? { eventCount: streamEventCount } : {})
      }
    });

    if (parsed.stopReason === "refusal") {
      throw createAnthropicRefusalError(metadata);
    }
    if (suppressNativeToolCalls && parsed.toolCalls.length > 0) {
      throw new Error("Anthropic returned native tool use while tool calls were disabled for this retry.");
    }
    const priorProviderCallIds = collectAnthropicToolUseIds(mapped.messages);
    if (parsed.toolCalls.some((toolCall) => priorProviderCallIds.has(toolCall.providerCallId))) {
      throw new Error("Anthropic returned a duplicate native tool identifier across message turns.");
    }

    const providerContext = {
      type: "anthropic-messages",
      system: cloneJson(mapped.system),
      nativeTools: cloneJson(nativeTools),
      messages: cloneJson([
        ...mapped.messages,
        {
          role: "assistant",
          content: parsed.contentBlocks
        }
      ])
    };
    return {
      content: parsed.content,
      reasoning: parsed.contentBlocks
        .filter((block) => block?.type === "thinking" && typeof block.thinking === "string")
        .map((block) => block.thinking)
        .join(""),
      toolCalls: parsed.toolCalls,
      providerContext,
      providerContextCharacters: estimateJsonCharacters(providerContext),
      ...(metadata ? { metadata } : {})
    };
  }

  async sendStreamingRequest(request, model, nativeTools, onProgress) {
    let response;
    try {
      response = await openStreamingResponse({
        ...request,
        headers: {
          ...request.headers,
          "anthropic-dangerous-direct-browser-access": "true"
        }
      }, { fetch: this.fetch });
    } catch (error) {
      await this.logDiagnostic("provider.anthropic.chat.request.failed", {
        endpoint: summarizeEndpoint(this.baseUrl),
        model,
        error: {
          name: error instanceof Error ? error.name : "",
          status: readErrorStatus(error),
          aborted: error?.name === "AbortError"
        }
      });
      throw error;
    }
    if (!isSuccessfulResponse(response)) {
      const snapshot = await readFetchResponse(response);
      const jsonRead = createFetchJsonRead(snapshot);
      await this.logDiagnostic("provider.anthropic.chat.response.failed", {
        endpoint: summarizeEndpoint(this.baseUrl),
        model,
        response: createAnthropicErrorSummary(snapshot, jsonRead)
      });
      throw createAnthropicHttpError("Anthropic Messages request", snapshot, jsonRead);
    }

    const frames = [];
    const streamSummary = await consumeServerSentEvents(response, async (event) => {
      frames.push(`event: ${event.event}\ndata: ${event.data}\n\n`);
      let data;
      try {
        data = JSON.parse(event.data);
      } catch {
        throw new Error("Anthropic returned malformed JSON in the event stream.");
      }
      if (data?.type === "error") {
        throw createAnthropicStreamError(data);
      }
      if (data?.type !== "content_block_delta") {
        return;
      }
      if (data.delta?.type === "thinking_delta" && typeof data.delta.thinking === "string") {
        await Promise.resolve(onProgress({
          type: "reasoning-delta",
          delta: data.delta.thinking
        }));
      } else if (data.delta?.type === "text_delta" && typeof data.delta.text === "string") {
        await Promise.resolve(onProgress({
          type: "text-delta",
          delta: data.delta.text
        }));
      }
    });
    const parsed = parseAnthropicStream(frames.join(""), nativeTools);
    return {
      response: {
        status: response.status,
        headers: response.headers,
        text: "",
        json: null
      },
      parsed,
      eventCount: streamSummary.eventCount
    };
  }

  async sendRequest(request, failureEvent, model = "") {
    try {
      return await requestUrl({
        ...request,
        throw: false
      });
    } catch (error) {
      await this.logDiagnostic(failureEvent, {
        endpoint: summarizeEndpoint(this.baseUrl),
        model,
        error: {
          name: error instanceof Error ? error.name : "",
          status: readErrorStatus(error),
          aborted: error?.name === "AbortError"
        }
      });
      throw error;
    }
  }

  async logDiagnostic(event, detail) {
    if (this.diagnostics && typeof this.diagnostics.debug === "function") {
      await this.diagnostics.debug(event, detail);
    }
  }
}

function createFetchJsonRead(snapshot) {
  return snapshot?.json && typeof snapshot.json === "object"
    ? { hasJson: true, value: snapshot.json, error: "" }
    : { hasJson: false, value: null, error: "" };
}

function createAnthropicRequestMessages(messages, providerContext, toolResults, continuationMessages) {
  const context = normalizeProviderContext(providerContext);
  if (context) {
    const pendingToolUses = getLastAssistantToolUses(context.messages);
    const resultBlocks = pendingToolUses.length > 0
      ? createAnthropicToolResultBlocks(context.messages, toolResults)
      : [];
    const continuationBlocks = createAnthropicContinuationBlocks(continuationMessages);
    if (resultBlocks.length === 0 && continuationBlocks.length === 0) {
      throw new Error("Anthropic continuation is missing tool results or a follow-up message.");
    }
    return {
      system: context.system,
      retainedNativeTools: context.nativeTools,
      messages: [
        ...context.messages,
        {
          role: "user",
          content: [...resultBlocks, ...continuationBlocks]
        }
      ]
    };
  }

  const system = [];
  const conversation = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message?.role === "system" || message?.role === "developer") {
      const text = extractTextContent(message.content);
      if (text) {
        system.push({ type: "text", text });
      }
      continue;
    }
    if (message?.role !== "user" && message?.role !== "assistant") {
      continue;
    }
    const content = createAnthropicContentBlocks(message.content, message.role);
    if (content.length === 0) {
      continue;
    }
    const previous = conversation.at(-1);
    if (previous?.role === message.role) {
      previous.content.push(...content);
    } else {
      conversation.push({ role: message.role, content });
    }
  }
  return { system, messages: conversation, retainedNativeTools: [] };
}

function createAnthropicContinuationBlocks(messages) {
  const blocks = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message?.role === "user") {
      blocks.push(...createAnthropicContentBlocks(message.content, "user"));
    }
  }
  return blocks;
}

function createAnthropicContentBlocks(content, role) {
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content }] : [];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  return content.map((part) => {
    if (typeof part === "string") {
      return part ? { type: "text", text: part } : null;
    }
    if (part?.type === "text" && typeof part.text === "string" && part.text) {
      return { type: "text", text: part.text };
    }
    if (role === "user" && part?.type === "image_url" && typeof part?.image_url?.url === "string") {
      return createAnthropicImageBlock(part.image_url.url);
    }
    return null;
  }).filter(Boolean);
}

function createAnthropicImageBlock(dataUrl) {
  const match = dataUrl.match(/^data:(image\/(?:jpeg|png|gif|webp));base64,([A-Za-z0-9+/=]+)$/i);
  if (!match) {
    return null;
  }
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: match[1].toLowerCase(),
      data: match[2]
    }
  };
}

function extractTextContent(content) {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => typeof part === "string"
      ? part
      : (part?.type === "text" && typeof part.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
}

function normalizeProviderContext(context) {
  if (context?.type !== "anthropic-messages" || !Array.isArray(context.messages)) {
    return null;
  }
  return {
    system: Array.isArray(context.system) ? cloneJson(context.system) : [],
    nativeTools: Array.isArray(context.nativeTools) ? cloneJson(context.nativeTools) : [],
    messages: cloneJson(context.messages)
  };
}

function createAnthropicToolResultBlocks(messages, toolResults) {
  const toolUses = getLastAssistantToolUses(messages);
  const byProviderCallId = new Map((Array.isArray(toolResults) ? toolResults : [])
    .filter((result) => typeof result?.providerCallId === "string" && result.providerCallId)
    .map((result) => [result.providerCallId, result]));

  const blocks = toolUses.map((toolUse) => {
    const result = byProviderCallId.get(toolUse.id);
    if (!result) {
      return null;
    }
    const isError = result.status === "error";
    return {
      type: "tool_result",
      tool_use_id: toolUse.id,
      content: isError ? (result.error || "Tool execution failed.") : (result.output || "(empty)"),
      ...(isError ? { is_error: true } : {})
    };
  }).filter(Boolean);
  if (blocks.length !== toolUses.length) {
    throw new Error("Anthropic tool continuation is missing matching tool results.");
  }
  return blocks;
}

function getLastAssistantToolUses(messages) {
  const lastAssistant = [...(Array.isArray(messages) ? messages : [])]
    .reverse()
    .find((message) => message?.role === "assistant");
  return Array.isArray(lastAssistant?.content)
    ? lastAssistant.content.filter((block) => block?.type === "tool_use" && typeof block.id === "string")
    : [];
}

function normalizeNativeTools(tools) {
  if (!Array.isArray(tools)) {
    return [];
  }
  return tools.map((tool) => {
    const name = typeof tool?.name === "string" ? tool.name.trim() : "";
    const targetToolName = typeof tool?.target?.toolName === "string" ? tool.target.toolName.trim() : "";
    if (!name || !targetToolName) {
      return null;
    }
    return {
      name,
      aliases: Array.isArray(tool.aliases)
        ? tool.aliases.map((alias) => typeof alias === "string" ? alias.trim() : "").filter(Boolean)
        : [],
      description: typeof tool.description === "string" ? tool.description.trim() : "",
      inputSchema: isPlainObject(tool.parameters)
        ? cloneJson(tool.parameters)
        : (isPlainObject(tool.inputSchema) ? cloneJson(tool.inputSchema) : emptyObjectSchema()),
      target: {
        serverId: typeof tool.target.serverId === "string" ? tool.target.serverId.trim() : "",
        toolName: targetToolName
      }
    };
  }).filter(Boolean);
}

const MAX_ANTHROPIC_STRICT_TOOLS = 20;
const MAX_ANTHROPIC_STRICT_OPTIONAL_PARAMETERS = 24;
const MAX_ANTHROPIC_STRICT_UNION_PARAMETERS = 16;
const ANTHROPIC_STRICT_SCHEMA_KEYWORDS = new Set([
  "$defs",
  "$ref",
  "additionalProperties",
  "anyOf",
  "const",
  "description",
  "enum",
  "items",
  "properties",
  "required",
  "title",
  "type"
]);
const MAX_ANTHROPIC_TOOL_SCHEMA_CHARACTERS = 131072;
const MAX_ANTHROPIC_TOOL_ARGUMENT_CHARACTERS = 262144;
const MAX_ANTHROPIC_VALIDATION_NODES = 8192;
const MAX_ANTHROPIC_VALIDATION_DEPTH = 32;
const MAX_ANTHROPIC_VALIDATION_STEPS = 20000;
const MAX_ANTHROPIC_UNIQUE_ITEMS = 256;
const MAX_ANTHROPIC_PATTERN_CHARACTERS = 256;
const MAX_ANTHROPIC_FIXED_PATTERN_REPETITION = 64;
const MAX_ANTHROPIC_PATTERN_PROPERTIES = 64;
const MAX_ANTHROPIC_PATTERN_SUBJECT_CHARACTERS = 2048;

function createAnthropicToolDeclarations(tools) {
  let strictToolCount = 0;
  let optionalParameterCount = 0;
  let unionParameterCount = 0;

  return tools.map((tool) => {
    const stats = isJsonWithinValidationLimits(tool.inputSchema, MAX_ANTHROPIC_TOOL_SCHEMA_CHARACTERS)
      ? inspectAnthropicStrictSchema(tool.inputSchema)
      : null;
    const useStrict = Boolean(
      stats &&
      strictToolCount < MAX_ANTHROPIC_STRICT_TOOLS &&
      optionalParameterCount + stats.optionalParameters <= MAX_ANTHROPIC_STRICT_OPTIONAL_PARAMETERS &&
      unionParameterCount + stats.unionParameters <= MAX_ANTHROPIC_STRICT_UNION_PARAMETERS
    );
    if (useStrict) {
      strictToolCount += 1;
      optionalParameterCount += stats.optionalParameters;
      unionParameterCount += stats.unionParameters;
    }
    return createAnthropicToolDeclaration(tool, useStrict);
  });
}

function createAnthropicToolDeclaration(tool, useStrict) {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
    ...(useStrict ? { strict: true } : {})
  };
}

function inspectAnthropicStrictSchema(schema, seen = new Set()) {
  if (!isPlainObject(schema) || seen.has(schema)) {
    return null;
  }
  seen.add(schema);

  if (Object.keys(schema).some((key) => !ANTHROPIC_STRICT_SCHEMA_KEYWORDS.has(key))) {
    return null;
  }
  const types = Array.isArray(schema.type) ? schema.type : [schema.type].filter(Boolean);
  if (types.some((type) => typeof type !== "string")) {
    return null;
  }
  if (types.includes("object") && schema.additionalProperties !== false) {
    return null;
  }
  if (schema.$ref !== undefined && (typeof schema.$ref !== "string" || !schema.$ref.startsWith("#"))) {
    return null;
  }
  if (schema.required !== undefined && (
    !Array.isArray(schema.required) ||
    schema.required.some((key) => typeof key !== "string")
  )) {
    return null;
  }
  if (schema.anyOf !== undefined && (!Array.isArray(schema.anyOf) || schema.anyOf.length === 0)) {
    return null;
  }

  let optionalParameters = 0;
  let unionParameters = types.length > 1 || Array.isArray(schema.anyOf) ? 1 : 0;
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  if (schema.properties !== undefined) {
    if (!isPlainObject(schema.properties)) {
      return null;
    }
    optionalParameters += Object.keys(schema.properties).filter((key) => !required.has(key)).length;
  }

  const childSchemas = [];
  if (isPlainObject(schema.properties)) {
    childSchemas.push(...Object.values(schema.properties));
  }
  if (isPlainObject(schema.$defs)) {
    childSchemas.push(...Object.values(schema.$defs));
  } else if (schema.$defs !== undefined) {
    return null;
  }
  if (Array.isArray(schema.anyOf)) {
    childSchemas.push(...schema.anyOf);
  }
  if (schema.items !== undefined) {
    childSchemas.push(schema.items);
  }

  for (const child of childSchemas) {
    const childStats = inspectAnthropicStrictSchema(child, seen);
    if (!childStats) {
      return null;
    }
    optionalParameters += childStats.optionalParameters;
    unionParameters += childStats.unionParameters;
  }

  return { optionalParameters, unionParameters };
}

function createNativeToolMap(nativeTools) {
  const map = new Map();
  const targetCounts = new Map();
  const aliasCounts = new Map();
  for (const tool of nativeTools) {
    targetCounts.set(tool.target.toolName, (targetCounts.get(tool.target.toolName) ?? 0) + 1);
    for (const alias of tool.aliases) {
      aliasCounts.set(alias, (aliasCounts.get(alias) ?? 0) + 1);
    }
  }
  for (const tool of nativeTools) {
    map.set(tool.name, tool);
  }
  for (const tool of nativeTools) {
    if (targetCounts.get(tool.target.toolName) === 1 && !map.has(tool.target.toolName)) {
      map.set(tool.target.toolName, tool);
    }
    for (const alias of tool.aliases) {
      if (aliasCounts.get(alias) === 1 && !map.has(alias)) {
        map.set(alias, tool);
      }
    }
  }
  return map;
}

function parseAnthropicStream(text, nativeTools) {
  const events = parseServerSentEvents(text);
  const blocks = new Map();
  const eventTypes = [];
  let usage = {};
  let stopReason = "";
  let serviceTier = "";
  let messageStarted = false;
  let messageStopped = false;
  let messageDeltaStarted = false;

  for (const event of events) {
    const data = event.data;
    if (!data || typeof data !== "object") {
      continue;
    }
    const type = typeof data.type === "string" ? data.type : event.event;
    if (type) {
      eventTypes.push(safeAnthropicCategory(type, SAFE_ANTHROPIC_EVENT_TYPES));
    }
    if (type === "error") {
      throw createAnthropicStreamError(data);
    }
    if (type === "message_start") {
      if (messageStarted || messageStopped) {
        throw new Error("Anthropic returned an invalid message lifecycle in the event stream.");
      }
      messageStarted = true;
      usage = mergeUsage(usage, data.message?.usage);
      serviceTier = typeof data.message?.usage?.service_tier === "string" ? data.message.usage.service_tier : serviceTier;
      continue;
    }
    if (type === "content_block_start") {
      if (!messageStarted || messageStopped || messageDeltaStarted) {
        throw new Error("Anthropic returned a content block outside the message lifecycle.");
      }
      const index = Number(data.index);
      if (!Number.isInteger(index) || !isPlainObject(data.content_block) || blocks.has(index)) {
        throw new Error("Anthropic returned an invalid content block start in the event stream.");
      }
      blocks.set(index, {
        block: cloneJson(data.content_block),
        partialJson: "",
        stopped: false
      });
      continue;
    }
    if (type === "content_block_delta") {
      const state = blocks.get(Number(data.index));
      if (!messageStarted || messageStopped || messageDeltaStarted || !state || state.stopped) {
        throw new Error("Anthropic returned an invalid content block delta in the event stream.");
      }
      applyContentBlockDelta(state, data.delta);
      continue;
    }
    if (type === "content_block_stop") {
      const state = blocks.get(Number(data.index));
      if (!messageStarted || messageStopped || messageDeltaStarted || !state || state.stopped) {
        throw new Error("Anthropic returned an invalid content block stop in the event stream.");
      }
      state.stopped = true;
      continue;
    }
    if (type === "message_delta") {
      if (!messageStarted || messageStopped || [...blocks.values()].some((state) => !state.stopped)) {
        throw new Error("Anthropic returned an invalid message delta in the event stream.");
      }
      usage = mergeUsage(usage, data.usage);
      stopReason = typeof data.delta?.stop_reason === "string" ? data.delta.stop_reason : stopReason;
      serviceTier = typeof data.usage?.service_tier === "string" ? data.usage.service_tier : serviceTier;
      messageDeltaStarted = true;
      continue;
    }
    if (type === "message_stop") {
      if (!messageStarted || messageStopped || [...blocks.values()].some((state) => !state.stopped)) {
        throw new Error("Anthropic returned an invalid message stop in the event stream.");
      }
      messageStopped = true;
    }
  }

  if (!messageStarted || !messageStopped) {
    throw new Error("Anthropic returned an incomplete event stream.");
  }
  if (!stopReason) {
    throw new Error("Anthropic returned an event stream without a final stop reason.");
  }
  if ([...blocks.values()].some((state) => state.stopped !== true)) {
    throw new Error("Anthropic returned an incomplete content block in the event stream.");
  }

  if (stopReason === "refusal") {
    return {
      content: "",
      contentBlocks: [],
      toolCalls: [],
      usage,
      stopReason,
      serviceTier,
      eventTypes
    };
  }
  if (stopReason === "max_tokens" || stopReason === "model_context_window_exceeded") {
    const contentBlocks = [...blocks.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, state]) => state.block?.type === "text" ? cloneJson(state.block) : null)
      .filter(Boolean);
    return {
      content: contentBlocks.map((block) => block.text ?? "").join(""),
      contentBlocks,
      toolCalls: [],
      usage,
      stopReason,
      serviceTier,
      eventTypes
    };
  }

  const contentBlocks = [...blocks.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, state]) => finalizeContentBlock(state));
  const toolUseBlocks = contentBlocks.filter((block) => block?.type === "tool_use");
  if (toolUseBlocks.length > 0 && stopReason !== "tool_use") {
    throw new Error("Anthropic returned native tool use without a completed tool-use stop reason.");
  }
  const providerCallIds = toolUseBlocks.map((block) => (
    typeof block.id === "string" ? block.id.trim() : ""
  ));
  if (
    toolUseBlocks.some((block, index) => block.id !== providerCallIds[index]) ||
    providerCallIds.some((id) => !id) ||
    new Set(providerCallIds).size !== providerCallIds.length
  ) {
    throw new Error("Anthropic returned invalid native tool identifiers.");
  }
  const toolMap = createNativeToolMap(nativeTools);
  const toolCalls = toolUseBlocks
    .map((block) => createAnthropicToolCall(block, toolMap))
    .filter(Boolean);
  return {
    content: contentBlocks
      .filter((block) => block?.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join(""),
    contentBlocks,
    toolCalls,
    usage,
    stopReason,
    serviceTier,
    eventTypes
  };
}

function parseServerSentEvents(text) {
  const source = String(text ?? "").replace(/\r\n/g, "\n");
  if (!source.trim()) {
    throw new Error("Anthropic returned an empty event stream.");
  }
  const events = [];
  for (const frame of source.split(/\n\n+/)) {
    let event = "";
    const dataLines = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith("event:")) {
        event = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
    if (dataLines.length === 0) {
      continue;
    }
    try {
      events.push({ event, data: JSON.parse(dataLines.join("\n")) });
    } catch {
      throw new Error("Anthropic returned malformed JSON in the event stream.");
    }
  }
  if (events.length === 0) {
    throw new Error("Anthropic returned an invalid event stream.");
  }
  return events;
}

function applyContentBlockDelta(state, delta) {
  if (!state || !delta || typeof delta !== "object") {
    throw new Error("Anthropic returned an invalid content block delta.");
  }
  const blockType = state.block?.type;
  if (blockType === "text" && delta.type === "text_delta" && typeof delta.text === "string") {
    state.block.text = `${state.block.text ?? ""}${delta.text}`;
    return;
  }
  if (blockType === "tool_use" && delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
    state.partialJson += delta.partial_json;
    if (state.partialJson.length > MAX_ANTHROPIC_TOOL_ARGUMENT_CHARACTERS) {
      throw new Error("Anthropic returned native tool arguments that exceed the local validation limit.");
    }
    return;
  }
  if (blockType === "thinking" && delta.type === "thinking_delta" && typeof delta.thinking === "string") {
    state.block.thinking = `${state.block.thinking ?? ""}${delta.thinking}`;
    return;
  }
  if (blockType === "thinking" && delta.type === "signature_delta" && typeof delta.signature === "string") {
    state.block.signature = `${state.block.signature ?? ""}${delta.signature}`;
    return;
  }
  throw new Error("Anthropic returned an unsupported or mismatched content block delta.");
}

function finalizeContentBlock(state) {
  const block = cloneJson(state.block);
  if (block.type === "tool_use") {
    if (state.partialJson) {
      try {
        block.input = JSON.parse(state.partialJson);
      } catch {
        throw new Error("Anthropic returned malformed native tool arguments.");
      }
    }
    if (!isPlainObject(block.input)) {
      throw new Error("Anthropic returned non-object native tool arguments.");
    }
  }
  return block;
}

function createAnthropicToolCall(block, toolMap) {
  const rawToolName = typeof block.name === "string" ? block.name : "";
  const toolName = rawToolName.trim();
  if (!toolName || rawToolName !== toolName) {
    throw new Error("Anthropic returned an invalid native tool name.");
  }
  const tool = toolMap.get(toolName);
  if (!tool) {
    throw new Error("Anthropic returned an unknown native tool.");
  }
  const rawProviderCallId = typeof block.id === "string" ? block.id : "";
  const providerCallId = rawProviderCallId.trim();
  if (!providerCallId || rawProviderCallId !== providerCallId) {
    throw new Error("Anthropic returned a native tool without an identifier.");
  }
  return {
    serverId: tool.target.serverId,
    toolName: tool.target.toolName,
    arguments: cloneJson(block.input),
    reason: "Anthropic returned a native tool use block.",
    exactToolName: true,
    providerCallId
  };
}

const JSON_SCHEMA_ANNOTATION_KEYWORDS = new Set([
  "$anchor",
  "$comment",
  "$id",
  "$schema",
  "default",
  "deprecated",
  "description",
  "examples",
  "format",
  "readOnly",
  "title",
  "writeOnly"
]);

const JSON_SCHEMA_VALIDATION_KEYWORDS = new Set([
  "$defs",
  "$ref",
  "additionalItems",
  "additionalProperties",
  "allOf",
  "anyOf",
  "const",
  "contains",
  "definitions",
  "dependencies",
  "dependentRequired",
  "dependentSchemas",
  "else",
  "enum",
  "exclusiveMaximum",
  "exclusiveMinimum",
  "if",
  "items",
  "maxContains",
  "maximum",
  "maxItems",
  "maxLength",
  "maxProperties",
  "minContains",
  "minimum",
  "minItems",
  "minLength",
  "minProperties",
  "multipleOf",
  "not",
  "oneOf",
  "pattern",
  "patternProperties",
  "prefixItems",
  "properties",
  "propertyNames",
  "required",
  "then",
  "type",
  "uniqueItems"
]);

function validateSupportedJsonSchema(schema, seen = new Set()) {
  if (schema === true || schema === false) {
    return "";
  }
  if (!isPlainObject(schema)) {
    return "the tool schema is invalid.";
  }
  if (seen.has(schema)) {
    return "";
  }
  seen.add(schema);

  for (const key of Object.keys(schema)) {
    if (!JSON_SCHEMA_ANNOTATION_KEYWORDS.has(key) && !JSON_SCHEMA_VALIDATION_KEYWORDS.has(key)) {
      return `the tool schema uses unsupported keyword ${JSON.stringify(key)}.`;
    }
  }

  if (Object.prototype.hasOwnProperty.call(schema, "type") && (
    (typeof schema.type !== "string" && !Array.isArray(schema.type)) ||
    (Array.isArray(schema.type) && schema.type.length === 0)
  )) {
    return "the tool schema has an invalid type declaration.";
  }
  const declaredTypes = Array.isArray(schema.type) ? schema.type : [schema.type].filter(Boolean);
  const supportedTypes = new Set(["array", "boolean", "integer", "null", "number", "object", "string"]);
  if (declaredTypes.some((type) => typeof type !== "string" || !supportedTypes.has(type))) {
    return "the tool schema declares an unsupported type.";
  }
  if (new Set(declaredTypes).size !== declaredTypes.length) {
    return "the tool schema has duplicate type declarations.";
  }
  if (schema.$ref !== undefined && (typeof schema.$ref !== "string" || !schema.$ref.startsWith("#"))) {
    return "the tool schema uses an unsupported non-local $ref.";
  }

  for (const key of ["allOf", "anyOf", "oneOf", "prefixItems"]) {
    if (schema[key] !== undefined && (!Array.isArray(schema[key]) || schema[key].length === 0)) {
      return `the tool schema has an invalid ${key}.`;
    }
  }
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length === 0)) {
    return "the tool schema has an invalid enum.";
  }
  if (Array.isArray(schema.enum)) {
    for (let left = 0; left < schema.enum.length; left += 1) {
      for (let right = left + 1; right < schema.enum.length; right += 1) {
        if (jsonValuesEqual(schema.enum[left], schema.enum[right])) {
          return "the tool schema has duplicate enum values.";
        }
      }
    }
  }
  if (schema.required !== undefined && (
    !Array.isArray(schema.required) ||
    schema.required.some((key) => typeof key !== "string") ||
    new Set(schema.required).size !== schema.required.length
  )) {
    return "the tool schema has an invalid required declaration.";
  }
  if (schema.uniqueItems !== undefined && typeof schema.uniqueItems !== "boolean") {
    return "the tool schema has an invalid uniqueItems constraint.";
  }
  for (const key of [
    "maxContains",
    "maxItems",
    "maxLength",
    "maxProperties",
    "minContains",
    "minItems",
    "minLength",
    "minProperties"
  ]) {
    if (schema[key] !== undefined && (!Number.isInteger(schema[key]) || schema[key] < 0)) {
      return `the tool schema has an invalid ${key} constraint.`;
    }
  }
  for (const key of ["maximum", "minimum"]) {
    if (schema[key] !== undefined && (typeof schema[key] !== "number" || !Number.isFinite(schema[key]))) {
      return `the tool schema has an invalid ${key} constraint.`;
    }
  }
  for (const key of ["exclusiveMaximum", "exclusiveMinimum"]) {
    if (schema[key] !== undefined && (
      typeof schema[key] !== "boolean" &&
      (typeof schema[key] !== "number" || !Number.isFinite(schema[key]))
    )) {
      return `the tool schema has an invalid ${key} constraint.`;
    }
  }
  if (schema.exclusiveMinimum === true && typeof schema.minimum !== "number") {
    return "the tool schema has exclusiveMinimum without a numeric minimum.";
  }
  if (schema.exclusiveMaximum === true && typeof schema.maximum !== "number") {
    return "the tool schema has exclusiveMaximum without a numeric maximum.";
  }
  if (schema.multipleOf !== undefined && (
    typeof schema.multipleOf !== "number" ||
    !Number.isFinite(schema.multipleOf) ||
    schema.multipleOf <= 0
  )) {
    return "the tool schema has an invalid multipleOf constraint.";
  }
  if (schema.pattern !== undefined && typeof schema.pattern !== "string") {
    return "the tool schema has an invalid pattern.";
  }
  if (schema.format !== undefined && typeof schema.format !== "string") {
    return "the tool schema has an invalid format annotation.";
  }
  if (schema.dependentRequired !== undefined) {
    if (!isPlainObject(schema.dependentRequired)) {
      return "the tool schema has invalid dependentRequired constraints.";
    }
    for (const dependency of Object.values(schema.dependentRequired)) {
      if (
        !Array.isArray(dependency) ||
        dependency.length === 0 ||
        dependency.some((key) => typeof key !== "string") ||
        new Set(dependency).size !== dependency.length
      ) {
        return "the tool schema has invalid dependentRequired constraints.";
      }
    }
  }
  if (Array.isArray(schema.items) && schema.items.length === 0) {
    return "the tool schema has an invalid items declaration.";
  }
  if ((schema.minContains !== undefined || schema.maxContains !== undefined) && schema.contains === undefined) {
    return "the tool schema has contains bounds without a contains schema.";
  }

  const schemaMaps = ["$defs", "definitions", "dependentSchemas", "patternProperties", "properties"];
  for (const key of schemaMaps) {
    if (schema[key] === undefined) continue;
    if (!isPlainObject(schema[key])) return `the tool schema has an invalid ${key}.`;
    for (const child of Object.values(schema[key])) {
      const error = validateSupportedJsonSchema(child, seen);
      if (error) return error;
    }
  }
  for (const key of ["allOf", "anyOf", "oneOf", "prefixItems"]) {
    if (schema[key] === undefined) continue;
    if (!Array.isArray(schema[key])) return `the tool schema has an invalid ${key}.`;
    for (const child of schema[key]) {
      const error = validateSupportedJsonSchema(child, seen);
      if (error) return error;
    }
  }
  for (const key of [
    "additionalItems",
    "additionalProperties",
    "contains",
    "else",
    "if",
    "not",
    "propertyNames",
    "then"
  ]) {
    if (schema[key] === undefined) continue;
    const error = validateSupportedJsonSchema(schema[key], seen);
    if (error) return error;
  }
  if (schema.items !== undefined) {
    const itemSchemas = Array.isArray(schema.items) ? schema.items : [schema.items];
    for (const child of itemSchemas) {
      const error = validateSupportedJsonSchema(child, seen);
      if (error) return error;
    }
  }
  if (schema.dependencies !== undefined) {
    if (!isPlainObject(schema.dependencies)) return "the tool schema has invalid dependencies.";
    for (const dependency of Object.values(schema.dependencies)) {
      if (Array.isArray(dependency)) {
        if (dependency.some((key) => typeof key !== "string")) {
          return "the tool schema has invalid dependencies.";
        }
        continue;
      }
      const error = validateSupportedJsonSchema(dependency, seen);
      if (error) return error;
    }
  }
  if (schema.pattern !== undefined) {
    if (!isSafeJsonSchemaPattern(schema.pattern)) {
      return "the tool schema has an invalid pattern.";
    }
  }
  if (isPlainObject(schema.patternProperties)) {
    if (Object.keys(schema.patternProperties).length > MAX_ANTHROPIC_PATTERN_PROPERTIES) {
      return "the tool schema has too many patternProperties entries.";
    }
    for (const pattern of Object.keys(schema.patternProperties)) {
      if (!isSafeJsonSchemaPattern(pattern)) {
        return "the tool schema has an invalid patternProperties pattern.";
      }
    }
  }
  return "";
}

function isJsonWithinValidationLimits(value, maximumCharacters) {
  try {
    if (JSON.stringify(value).length > maximumCharacters) {
      return false;
    }
  } catch {
    return false;
  }

  const stack = [{ value, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    nodes += 1;
    if (nodes > MAX_ANTHROPIC_VALIDATION_NODES || current.depth > MAX_ANTHROPIC_VALIDATION_DEPTH) {
      return false;
    }
    if (Array.isArray(current.value)) {
      for (const child of current.value) {
        stack.push({ value: child, depth: current.depth + 1 });
      }
    } else if (isPlainObject(current.value)) {
      for (const child of Object.values(current.value)) {
        stack.push({ value: child, depth: current.depth + 1 });
      }
    }
  }
  return true;
}

function isSafeJsonSchemaPattern(pattern) {
  if (typeof pattern !== "string" || pattern.length > MAX_ANTHROPIC_PATTERN_CHARACTERS) {
    return false;
  }
  if (/\\(?:[1-9]|k<)/.test(pattern) || pattern.includes("(?")) {
    return false;
  }
  let escaped = false;
  let inCharacterClass = false;
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === "[") {
      inCharacterClass = true;
      continue;
    }
    if (character === "]" && inCharacterClass) {
      inCharacterClass = false;
      continue;
    }
    if (inCharacterClass) {
      continue;
    }
    if (character === "(" || character === ")" || character === "|") {
      return false;
    }
    if (character === "*" || character === "+" || character === "?") {
      return false;
    }
    if (character === "{") {
      const match = pattern.slice(index).match(/^\{(\d+)\}/);
      if (!match || Number(match[1]) > MAX_ANTHROPIC_FIXED_PATTERN_REPETITION) {
        return false;
      }
      index += match[0].length - 1;
    }
  }
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

function validateJsonSchema(value, schema, path = "arguments", rootSchema = schema, refStack = new Set(), budget = { steps: 0 }) {
  budget.steps += 1;
  if (budget.steps > MAX_ANTHROPIC_VALIDATION_STEPS) {
    return "the tool arguments exceed the local validation work limit.";
  }
  if (schema === false) {
    return `${path} is not allowed by the tool schema.`;
  }
  if (schema === true) {
    return "";
  }
  if (!isPlainObject(schema)) {
    return "the tool schema is invalid.";
  }
  if (typeof schema.$ref === "string") {
    if (refStack.has(schema.$ref)) {
      return "the tool schema contains a recursive $ref that cannot be validated safely.";
    }
    const referenced = resolveLocalJsonSchemaRef(rootSchema, schema.$ref);
    if (referenced === undefined) {
      return `the tool schema contains unresolved reference ${JSON.stringify(schema.$ref)}.`;
    }
    const nextStack = new Set(refStack);
    nextStack.add(schema.$ref);
    const error = validateJsonSchema(value, referenced, path, rootSchema, nextStack, budget);
    if (error) return error;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => jsonValuesEqual(item, value))) {
    return `${path} is not one of the allowed values.`;
  }
  if (Object.prototype.hasOwnProperty.call(schema, "const") && !jsonValuesEqual(value, schema.const)) {
    return `${path} must match the required constant value.`;
  }
  if (Array.isArray(schema.allOf)) {
    for (const candidate of schema.allOf) {
      const error = validateJsonSchema(value, candidate, path, rootSchema, refStack, budget);
      if (error) return error;
    }
  }
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some((candidate) => !validateJsonSchema(value, candidate, path, rootSchema, refStack, budget))) {
    return `${path} does not match any allowed schema.`;
  }
  if (Array.isArray(schema.oneOf)) {
    const matchCount = schema.oneOf.filter((candidate) => !validateJsonSchema(value, candidate, path, rootSchema, refStack, budget)).length;
    if (matchCount !== 1) return `${path} must match exactly one allowed schema.`;
  }
  if (schema.not !== undefined && !validateJsonSchema(value, schema.not, path, rootSchema, refStack, budget)) {
    return `${path} matches a disallowed schema.`;
  }
  if (schema.if !== undefined) {
    const conditionMatches = !validateJsonSchema(value, schema.if, path, rootSchema, refStack, budget);
    const branch = conditionMatches ? schema.then : schema.else;
    if (branch !== undefined) {
      const error = validateJsonSchema(value, branch, path, rootSchema, refStack, budget);
      if (error) return error;
    }
  }
  const types = Array.isArray(schema.type) ? schema.type : [schema.type].filter(Boolean);
  if (types.length > 0 && !types.some((type) => matchesJsonType(value, type))) {
    return `${path} must be ${types.join(" or ")}.`;
  }
  if (typeof value === "string") {
    const length = Array.from(value).length;
    if (Number.isInteger(schema.minLength) && length < schema.minLength) return `${path} is too short.`;
    if (Number.isInteger(schema.maxLength) && length > schema.maxLength) return `${path} is too long.`;
    if (typeof schema.pattern === "string") {
      const patternError = testBoundedJsonSchemaPattern(value, schema.pattern, budget);
      if (patternError) {
        return patternError === "mismatch"
          ? `${path} does not match the required pattern.`
          : "the tool arguments exceed the local pattern validation limit.";
      }
    }
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    if (typeof schema.minimum === "number" && value < schema.minimum) return `${path} is below the minimum.`;
    if (typeof schema.maximum === "number" && value > schema.maximum) return `${path} is above the maximum.`;
    const exclusiveMinimum = typeof schema.exclusiveMinimum === "number"
      ? schema.exclusiveMinimum
      : (schema.exclusiveMinimum === true ? schema.minimum : undefined);
    const exclusiveMaximum = typeof schema.exclusiveMaximum === "number"
      ? schema.exclusiveMaximum
      : (schema.exclusiveMaximum === true ? schema.maximum : undefined);
    if (typeof exclusiveMinimum === "number" && value <= exclusiveMinimum) return `${path} must exceed the exclusive minimum.`;
    if (typeof exclusiveMaximum === "number" && value >= exclusiveMaximum) return `${path} must be below the exclusive maximum.`;
    if (typeof schema.multipleOf === "number" && schema.multipleOf > 0) {
      const quotient = value / schema.multipleOf;
      if (Math.abs(quotient - Math.round(quotient)) > Number.EPSILON * Math.max(1, Math.abs(quotient)) * 8) {
        return `${path} is not a multiple of the required value.`;
      }
    }
  }
  if (isPlainObject(value)) {
    const properties = isPlainObject(schema.properties) ? schema.properties : {};
    const propertyCount = Object.keys(value).length;
    if (Number.isInteger(schema.minProperties) && propertyCount < schema.minProperties) return `${path} has too few properties.`;
    if (Number.isInteger(schema.maxProperties) && propertyCount > schema.maxProperties) return `${path} has too many properties.`;
    for (const required of Array.isArray(schema.required) ? schema.required : []) {
      if (!Object.prototype.hasOwnProperty.call(value, required)) {
        return `${path}.${required} is required.`;
      }
    }
    const patternProperties = isPlainObject(schema.patternProperties) ? schema.patternProperties : {};
    const compiledPatternProperties = [];
    for (const [pattern, childSchema] of Object.entries(patternProperties)) {
      compiledPatternProperties.push([pattern, new RegExp(pattern), childSchema]);
    }
    for (const [key, child] of Object.entries(value)) {
      const propertySchemas = [];
      if (properties[key] !== undefined) propertySchemas.push(properties[key]);
      for (const [pattern, compiledPattern, childSchema] of compiledPatternProperties) {
        const patternError = testBoundedJsonSchemaPattern(key, pattern, budget, compiledPattern);
        if (patternError === "limit") {
          return "the tool arguments exceed the local pattern validation limit.";
        }
        if (!patternError) {
          propertySchemas.push(childSchema);
        }
      }
      if (propertySchemas.length === 0) {
        if (schema.additionalProperties === false) return `${path}.${key} is not allowed.`;
        if (isPlainObject(schema.additionalProperties) || typeof schema.additionalProperties === "boolean") {
          propertySchemas.push(schema.additionalProperties);
        }
      }
      for (const childSchema of propertySchemas) {
        const error = validateJsonSchema(child, childSchema, `${path}.${key}`, rootSchema, refStack, budget);
        if (error) return error;
      }
    }
    if (schema.propertyNames !== undefined) {
      for (const key of Object.keys(value)) {
        const error = validateJsonSchema(key, schema.propertyNames, `${path} property name`, rootSchema, refStack, budget);
        if (error) return error;
      }
    }
    for (const [key, requiredKeys] of Object.entries(isPlainObject(schema.dependentRequired) ? schema.dependentRequired : {})) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      for (const requiredKey of Array.isArray(requiredKeys) ? requiredKeys : []) {
        if (!Object.prototype.hasOwnProperty.call(value, requiredKey)) return `${path}.${requiredKey} is required when ${path}.${key} is present.`;
      }
    }
    for (const [key, dependency] of Object.entries(isPlainObject(schema.dependencies) ? schema.dependencies : {})) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      if (Array.isArray(dependency)) {
        for (const requiredKey of dependency) {
          if (!Object.prototype.hasOwnProperty.call(value, requiredKey)) return `${path}.${requiredKey} is required when ${path}.${key} is present.`;
        }
      } else {
        const error = validateJsonSchema(value, dependency, path, rootSchema, refStack, budget);
        if (error) return error;
      }
    }
    for (const [key, dependency] of Object.entries(isPlainObject(schema.dependentSchemas) ? schema.dependentSchemas : {})) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        const error = validateJsonSchema(value, dependency, path, rootSchema, refStack, budget);
        if (error) return error;
      }
    }
  }
  if (Array.isArray(value)) {
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) return `${path} has too few items.`;
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) return `${path} has too many items.`;
    if (schema.uniqueItems === true) {
      if (value.length > MAX_ANTHROPIC_UNIQUE_ITEMS) {
        return `${path} exceeds the local unique-items validation limit.`;
      }
      for (let left = 0; left < value.length; left += 1) {
        for (let right = left + 1; right < value.length; right += 1) {
          if (jsonValuesEqual(value[left], value[right])) return `${path} must contain unique items.`;
        }
      }
    }
    const prefixItems = Array.isArray(schema.prefixItems)
      ? schema.prefixItems
      : (Array.isArray(schema.items) ? schema.items : []);
    for (let index = 0; index < Math.min(value.length, prefixItems.length); index += 1) {
      const error = validateJsonSchema(value[index], prefixItems[index], `${path}[${index}]`, rootSchema, refStack, budget);
      if (error) return error;
    }
    const remainingSchema = Array.isArray(schema.prefixItems)
      ? schema.items
      : (Array.isArray(schema.items) ? schema.additionalItems : schema.items);
    if (remainingSchema !== undefined) {
      for (let index = prefixItems.length; index < value.length; index += 1) {
        const error = validateJsonSchema(value[index], remainingSchema, `${path}[${index}]`, rootSchema, refStack, budget);
        if (error) return error;
      }
    }
    if (schema.contains !== undefined) {
      const matchCount = value.filter((item, index) => !validateJsonSchema(item, schema.contains, `${path}[${index}]`, rootSchema, refStack, budget)).length;
      const minimum = Number.isInteger(schema.minContains) ? schema.minContains : 1;
      const maximum = Number.isInteger(schema.maxContains) ? schema.maxContains : Infinity;
      if (matchCount < minimum || matchCount > maximum) return `${path} does not contain the required matching items.`;
    }
  }
  return "";
}

function resolveLocalJsonSchemaRef(rootSchema, reference) {
  if (reference === "#") return rootSchema;
  if (!reference.startsWith("#/")) return undefined;
  return reference.slice(2).split("/").reduce((current, segment) => {
    if (current === undefined || current === null) return undefined;
    const key = segment.replace(/~1/g, "/").replace(/~0/g, "~");
    return Object.prototype.hasOwnProperty.call(current, key) ? current[key] : undefined;
  }, rootSchema);
}

function jsonValuesEqual(left, right) {
  if (left === right) {
    return true;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => jsonValuesEqual(item, right[index]));
  }
  if (isPlainObject(left) || isPlainObject(right)) {
    if (!isPlainObject(left) || !isPlainObject(right)) {
      return false;
    }
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return leftKeys.length === rightKeys.length &&
      leftKeys.every((key, index) => (
        key === rightKeys[index] && jsonValuesEqual(left[key], right[key])
      ));
  }
  return false;
}

function matchesJsonType(value, type) {
  if (type === "object") return isPlainObject(value);
  if (type === "array") return Array.isArray(value);
  if (type === "string") return typeof value === "string";
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "integer") return Number.isInteger(value);
  if (type === "boolean") return typeof value === "boolean";
  if (type === "null") return value === null;
  return false;
}

function mergeUsage(current, next) {
  if (!next || typeof next !== "object") {
    return current;
  }
  const merged = { ...current };
  for (const key of [
    "input_tokens",
    "output_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens"
  ]) {
    if (Number.isFinite(next[key])) {
      merged[key] = next[key];
    }
  }
  if (isPlainObject(next.cache_creation)) {
    merged.cache_creation = cloneJson(next.cache_creation);
  }
  if (isPlainObject(next.output_tokens_details)) {
    merged.output_tokens_details = cloneJson(next.output_tokens_details);
  }
  if (typeof next.service_tier === "string") {
    merged.service_tier = next.service_tier;
  }
  return merged;
}

function createAnthropicResponseMetadata(parsed) {
  const usage = parsed.usage ?? {};
  const input = readFiniteNumber(usage.input_tokens);
  const output = readFiniteNumber(usage.output_tokens);
  const cacheCreation = readFiniteNumber(usage.cache_creation_input_tokens);
  const cacheRead = readFiniteNumber(usage.cache_read_input_tokens);
  const hasUsage = [input, output, cacheCreation, cacheRead].some(Number.isFinite);
  if (!hasUsage && !parsed.serviceTier && !parsed.stopReason) {
    return null;
  }
  const totalInput = [input, cacheCreation, cacheRead]
    .filter(Number.isFinite)
    .reduce((sum, value) => sum + value, 0);
  return {
    usage: {
      inputTokens: hasUsage ? totalInput : null,
      outputTokens: output,
      totalTokens: hasUsage && Number.isFinite(output) ? totalInput + output : null,
      reasoningTokens: readFiniteNumber(usage.output_tokens_details?.thinking_tokens),
      cachedTokens: null,
      cacheCreationTokens: cacheCreation,
      cacheReadTokens: cacheRead,
      cacheCreation5mTokens: readFiniteNumber(usage.cache_creation?.ephemeral_5m_input_tokens),
      cacheCreation1hTokens: readFiniteNumber(usage.cache_creation?.ephemeral_1h_input_tokens)
    },
    serviceTier: safeAnthropicCategory(
      parsed.serviceTier || (typeof usage.service_tier === "string" ? usage.service_tier : ""),
      SAFE_ANTHROPIC_SERVICE_TIERS,
      ""
    ),
    finishReason: safeAnthropicCategory(parsed.stopReason, SAFE_ANTHROPIC_STOP_REASONS, ""),
    outputLimitReached: parsed.stopReason === "max_tokens",
    contextWindowLimitReached: parsed.stopReason === "model_context_window_exceeded"
  };
}

function testBoundedJsonSchemaPattern(value, pattern, budget, compiledPattern = null) {
  if (Array.from(value).length > MAX_ANTHROPIC_PATTERN_SUBJECT_CHARACTERS) {
    return "limit";
  }
  budget.steps += 1 + Math.ceil(value.length / 64) + Math.ceil(pattern.length / 16);
  if (budget.steps > MAX_ANTHROPIC_VALIDATION_STEPS) {
    return "limit";
  }
  return (compiledPattern ?? new RegExp(pattern)).test(value) ? "" : "mismatch";
}

function createAnthropicResponseSummary(response, parsed) {
  const metadata = createAnthropicResponseMetadata(parsed);
  return {
    status: Number.isInteger(response?.status) ? response.status : null,
    eventTypes: Array.from(new Set(parsed.eventTypes.map((type) => (
      safeAnthropicCategory(type, SAFE_ANTHROPIC_EVENT_TYPES)
    )))),
    contentLength: parsed.content.length,
    contentBlockTypes: parsed.contentBlocks
      .map((block) => safeAnthropicCategory(block?.type, SAFE_ANTHROPIC_CONTENT_BLOCK_TYPES))
      .filter(Boolean),
    nativeToolCallCount: parsed.toolCalls.length,
    finishReason: safeAnthropicCategory(parsed.stopReason, SAFE_ANTHROPIC_STOP_REASONS),
    usage: metadata?.usage ?? null,
    serviceTier: safeAnthropicCategory(metadata?.serviceTier, SAFE_ANTHROPIC_SERVICE_TIERS, ""),
    headers: createSafeResponseHeaderSummary(response)
  };
}

function safeAnthropicCategory(value, allowed, emptyValue = "unknown") {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) {
    return emptyValue;
  }
  return allowed.has(normalized) ? normalized : "unknown";
}

function collectAnthropicToolUseIds(messages) {
  const ids = new Set();
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message?.role !== "assistant" || !Array.isArray(message.content)) {
      continue;
    }
    for (const block of message.content) {
      const id = block?.type === "tool_use" && typeof block.id === "string"
        ? block.id.trim()
        : "";
      if (id) {
        ids.add(id);
      }
    }
  }
  return ids;
}

function createAnthropicRefusalError(metadata) {
  const error = new Error(
    "Claude declined to answer this request. Revise the request or select another Anthropic model before trying again."
  );
  error.providerRefusal = true;
  error.providerResponseMetadata = metadata ?? null;
  return error;
}

function createAnthropicErrorSummary(response, jsonRead) {
  const data = jsonRead.hasJson ? jsonRead.value : null;
  return {
    status: Number.isInteger(response?.status) ? response.status : null,
    errorType: safeErrorType(data?.error?.type),
    requestId: safeRequestId(data?.request_id),
    headers: createSafeResponseHeaderSummary(response)
  };
}

function createAnthropicHttpError(label, response, jsonRead) {
  const status = Number.isInteger(response?.status) ? response.status : null;
  const data = jsonRead.hasJson ? jsonRead.value : null;
  const type = safeErrorType(data?.error?.type);
  const retryAfter = createSafeResponseHeaderSummary(response)["retry-after"];
  const requestId = safeRequestId(data?.request_id) || createSafeResponseHeaderSummary(response)["request-id"];
  const detail = createAnthropicErrorDisplayText(type, status, retryAfter, data?.error?.message);
  const suffix = requestId ? ` Request ID: ${requestId}.` : "";
  return new Error(`${label} failed${status ? ` with status ${status}` : ""}. ${detail}${suffix}`.trim());
}

function createAnthropicErrorDisplayText(type, status, retryAfter, providerMessage = "") {
  if (type === "authentication_error" || status === 401) return "Anthropic rejected the API key.";
  if (type === "permission_error" || status === 403) return "The API key does not have permission for this Anthropic resource.";
  if (isAnthropicCreditError(type, status, providerMessage)) return "Anthropic API credits are unavailable or exhausted. Add usage credits in Claude Console and try again.";
  if (type === "rate_limit_error" || status === 429) return `Anthropic rate limit reached.${retryAfter ? ` Retry after ${retryAfter} seconds.` : ""}`;
  if (type === "overloaded_error" || status === 529) return "Anthropic is temporarily overloaded.";
  if (type === "invalid_request_error" || status === 400) return "Anthropic rejected the request as invalid.";
  if (status === 404) return "The selected Anthropic resource was not found.";
  return "Anthropic could not complete the request.";
}

function isAnthropicCreditError(type, status, providerMessage) {
  if (type === "billing_error" || status === 402) {
    return true;
  }
  if (type !== "invalid_request_error" && status !== 400) {
    return false;
  }
  const message = typeof providerMessage === "string" ? providerMessage.toLowerCase() : "";
  return message.includes("credit") && (
    message.includes("balance") ||
    message.includes("billing") ||
    message.includes("purchase") ||
    message.includes("funds")
  );
}

function createAnthropicStreamError(data) {
  const type = safeErrorType(data?.error?.type);
  return new Error(`Anthropic stream failed. ${createAnthropicErrorDisplayText(type, null, "")}`);
}

function readResponseJson(response) {
  try {
    const value = response?.json;
    return value && typeof value === "object"
      ? { hasJson: true, value }
      : { hasJson: false, value: null };
  } catch {
    return { hasJson: false, value: null };
  }
}

function readResponseText(response) {
  for (const candidate of [response?.text, response?.body, response?.responseText]) {
    if (typeof candidate === "string") {
      return candidate;
    }
  }
  return "";
}

function createSafeResponseHeaderSummary(response) {
  const headers = response?.headers && typeof response.headers === "object" ? response.headers : {};
  const summary = {};
  for (const [name, rawValue] of Object.entries(headers)) {
    const normalized = String(name).toLowerCase();
    if (!SAFE_RESPONSE_HEADER_NAMES.has(normalized) && !normalized.startsWith("anthropic-ratelimit-")) {
      continue;
    }
    const value = String(rawValue ?? "").replace(/[^A-Za-z0-9_:.+\-TZ]/g, "").slice(0, 160);
    if (value) summary[normalized] = value;
  }
  return summary;
}

function summarizeEndpoint(endpoint) {
  try {
    const parsed = new URL(String(endpoint ?? ""));
    return {
      present: true,
      protocol: parsed.protocol.replace(/:$/, ""),
      host: parsed.host,
      path: parsed.pathname,
      hasQuery: Boolean(parsed.search)
    };
  } catch {
    return { present: Boolean(endpoint), protocol: "", host: "", path: "", hasQuery: false };
  }
}

function readErrorStatus(error) {
  for (const candidate of [error?.status, error?.statusCode, error?.response?.status]) {
    const value = Number(candidate);
    if (Number.isInteger(value)) return value;
  }
  return null;
}

function readFiniteNumber(value) {
  return Number.isFinite(value) ? value : null;
}

function estimateJsonCharacters(value) {
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
}

function safeErrorType(value) {
  return typeof value === "string" ? value.replace(/[^a-z0-9_-]/gi, "").slice(0, 80) : "";
}

function safeRequestId(value) {
  return typeof value === "string" && /^req_[A-Za-z0-9]+$/.test(value) ? value : "";
}

function safeToolName(value) {
  const name = typeof value === "string" ? value.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80) : "";
  return name || "unknown";
}

function emptyObjectSchema() {
  return { type: "object", properties: {}, additionalProperties: false };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}

module.exports = {
  AnthropicClient
};
