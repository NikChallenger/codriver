const { requestUrl } = require("obsidian");
const { DEFAULT_OPENAI_COMPATIBLE_BASE_URL } = require("../../constants");
const {
  consumeServerSentEvents,
  isSuccessfulResponse,
  openStreamingResponse,
  readFetchResponse
} = require("../StreamingTransport");

const MAX_NATIVE_TOOL_DIAGNOSTIC_NAMES = 40;
const SAFE_RESPONSE_HEADER_NAMES = new Set([
  "openai-request-id",
  "request-id",
  "retry-after",
  "x-request-id"
]);

function endpointGuidance(baseUrl) {
  if (/\/api\/?$/.test(baseUrl)) {
    return `The endpoint ends with /api. Use an OpenAI-compatible /v1 base URL, for example ${DEFAULT_OPENAI_COMPATIBLE_BASE_URL}.`;
  }

  return `Use an OpenAI-compatible base URL, for example ${DEFAULT_OPENAI_COMPATIBLE_BASE_URL}.`;
}

class OpenAiCompatibleClient {
  constructor(baseUrl, apiKeyResolver = "", options = {}) {
    this.baseUrl = String(baseUrl ?? "").replace(/\/$/, "");
    this.apiKeyResolver = typeof apiKeyResolver === "function"
      ? apiKeyResolver
      : () => apiKeyResolver;
    this.requestOptions = normalizeRequestOptions(options.requestOptions);
    this.diagnostics = options.diagnostics ?? null;
    this.fetch = options.fetch;
  }

  async createHeaders(extraHeaders = {}) {
    const headers = {
      Accept: "application/json",
      ...extraHeaders
    };
    const apiKey = String((await Promise.resolve(this.apiKeyResolver())) ?? "").trim();

    if (apiKey.length > 0) {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    return headers;
  }

  async listModels() {
    const response = await requestUrl({
      url: `${this.baseUrl}/models`,
      method: "GET",
      headers: await this.createHeaders()
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Model list request failed with status ${response.status}.`);
    }

    const data = response.json ?? {};
    if (!Array.isArray(data?.data)) {
      throw new Error(`The provider responded, but not with an OpenAI-compatible model list. ${endpointGuidance(this.baseUrl)}`);
    }

    return data.data
      .map((model) => model?.id ?? model?.name)
      .filter((modelId) => typeof modelId === "string" && modelId.trim().length > 0);
  }

  async testConnection() {
    const models = await this.listModels();

    return {
      modelCount: models.length,
      models
    };
  }

  async createChatCompletion(model, messages, signal = null, options = {}) {
    const nativeTools = normalizeNativeTools(options.nativeTools);
    const requestMessages = createOpenAiRequestMessages(messages, {
      providerContext: options.providerContext,
      toolResults: options.toolResults,
      continuationMessages: options.continuationMessages
    });
    const body = {
      model,
      messages: requestMessages,
      ...this.requestOptions,
      stream: false
    };
    if (nativeTools.length > 0) {
      body.tools = nativeTools.map(createOpenAiToolDeclaration);
      body.tool_choice = "auto";
      body.parallel_tool_calls = false;
    }

    if (typeof options.onProgress === "function") {
      return await this.createStreamingChatCompletion(model, body, nativeTools, signal, options.onProgress);
    }

    const request = {
      url: `${this.baseUrl}/chat/completions`,
      method: "POST",
      headers: await this.createHeaders({
        "Content-Type": "application/json"
      }),
      body: JSON.stringify(body)
    };

    if (signal) {
      request.signal = signal;
    }

    const response = await this.sendRequest(request, {
      event: "provider.openai.chat.request.failed",
      endpoint: summarizeEndpoint(this.baseUrl),
      model
    });
    const jsonRead = readResponseJson(response);

    await this.logDiagnostic("provider.openai.chat.response.received", {
      endpoint: summarizeEndpoint(this.baseUrl),
      model,
      response: createChatResponseSummary(response, jsonRead)
    });

    if (response.status < 200 || response.status >= 300) {
      await this.logDiagnostic("provider.openai.chat.response.failed", {
        status: "failed",
        endpoint: summarizeEndpoint(this.baseUrl),
        model,
        response: createProviderHttpErrorSummary(response, jsonRead)
      });
      throw new Error(createProviderHttpErrorMessage("Chat completion request", response, jsonRead));
    }

    const data = jsonRead.hasJson ? jsonRead.value : {};
    if (!Array.isArray(data?.choices)) {
      await this.logDiagnostic("provider.openai.chat.response.rejected", {
        status: "failed",
        endpoint: summarizeEndpoint(this.baseUrl),
        model,
        response: createRejectedChatResponseSummary(response, jsonRead)
      });
      throw new Error(`The provider responded, but not with an OpenAI-compatible chat response. ${endpointGuidance(this.baseUrl)}`);
    }

    const firstChoice = Array.isArray(data?.choices) ? data.choices[0] : null;
    const message = firstChoice?.message ?? {};
    const content = normalizeOpenAiMessageContent(message.content);
    const toolCalls = normalizeOpenAiToolCalls(message.tool_calls, nativeTools);
    const recoveredToolCallSummary = createOpenAiRecoveredToolCallSummary(message.tool_calls, nativeTools);
    if (recoveredToolCallSummary) {
      await this.logDiagnostic("provider.openai.native_tool_call.mapping.recovered", {
        endpoint: summarizeEndpoint(this.baseUrl),
        model,
        ...recoveredToolCallSummary
      });
    }
    const unmappedToolCallSummary = createOpenAiUnmappedToolCallSummary(message.tool_calls, nativeTools);
    if (unmappedToolCallSummary) {
      await this.logDiagnostic("provider.openai.native_tool_call.mapping.failed", {
        endpoint: summarizeEndpoint(this.baseUrl),
        model,
        ...unmappedToolCallSummary
      });
    }

    const metadata = createOpenAiResponseMetadata(data, firstChoice);
    const providerContext = createOpenAiProviderContext(body.messages, message, message.tool_calls, toolCalls);
    return {
      content,
      toolCalls,
      ...(providerContext ? {
        providerContext,
        providerContextCharacters: estimateJsonCharacters(providerContext)
      } : {}),
      ...(metadata ? { metadata } : {})
    };
  }

  async createStreamingChatCompletion(model, body, nativeTools, signal, onProgress) {
    const request = {
      url: `${this.baseUrl}/chat/completions`,
      method: "POST",
      headers: await this.createHeaders({
        Accept: "text/event-stream",
        "Content-Type": "application/json"
      }),
      body: JSON.stringify({
        ...body,
        stream: true
      }),
      ...(signal ? { signal } : {})
    };
    let response;
    try {
      response = await openStreamingResponse(request, { fetch: this.fetch });
    } catch (error) {
      await this.logDiagnostic("provider.openai.chat.request.failed", {
        endpoint: summarizeEndpoint(this.baseUrl),
        model,
        error: createProviderRequestErrorSummary(error)
      });
      throw error;
    }

    if (!isSuccessfulResponse(response)) {
      const snapshot = await readFetchResponse(response);
      const jsonRead = createFetchJsonRead(snapshot);
      await this.logDiagnostic("provider.openai.chat.response.failed", {
        status: "failed",
        endpoint: summarizeEndpoint(this.baseUrl),
        model,
        response: createProviderHttpErrorSummary(snapshot, jsonRead)
      });
      throw new Error(createProviderHttpErrorMessage("Chat completion request", snapshot, jsonRead));
    }

    const state = createOpenAiStreamState();
    const streamSummary = await consumeServerSentEvents(response, async (event) => {
      if (event.data === "[DONE]") {
        state.done = true;
        return;
      }
      let data;
      try {
        data = JSON.parse(event.data);
      } catch {
        throw new Error("The provider returned malformed JSON in the Chat Completions event stream.");
      }
      if (data?.error) {
        const snapshot = {
          status: Number.isInteger(response.status) ? response.status : 200,
          headers: {},
          text: "",
          json: data
        };
        throw new Error(createProviderHttpErrorMessage(
          "Chat completion stream",
          snapshot,
          { hasJson: true, value: data, error: "" }
        ));
      }
      await applyOpenAiStreamChunk(state, data, nativeTools, onProgress);
    });

    if (!state.done) {
      throw new Error("The provider returned an incomplete Chat Completions event stream.");
    }
    const rawToolCalls = [...state.toolCalls.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, toolCall]) => toolCall);
    const toolCalls = normalizeOpenAiToolCalls(rawToolCalls, nativeTools);
    const assistantMessage = createStreamingOpenAiAssistantMessage(state, rawToolCalls);
    const providerContext = createOpenAiProviderContext(body.messages, assistantMessage, rawToolCalls, toolCalls);
    const metadataSource = {
      ...state.metadata,
      ...(state.usage ? { usage: state.usage } : {})
    };
    const metadata = createOpenAiResponseMetadata(metadataSource, {
      finish_reason: state.finishReason
    });
    await this.logDiagnostic("provider.openai.chat.response.received", {
      endpoint: summarizeEndpoint(this.baseUrl),
      model,
      response: {
        status: response.status,
        eventCount: streamSummary.eventCount,
        finishReason: state.finishReason,
        contentLength: state.content.length,
        reasoningLength: state.reasoning.length,
        nativeToolCallCount: rawToolCalls.length,
        usage: createOpenAiUsageSummary(metadataSource)
      }
    });

    return {
      content: state.content,
      toolCalls,
      reasoning: state.reasoning,
      ...(providerContext ? {
        providerContext,
        providerContextCharacters: estimateJsonCharacters(providerContext)
      } : {}),
      ...(metadata ? { metadata } : {})
    };
  }

  async logDiagnostic(event, detail) {
    if (!this.diagnostics || typeof this.diagnostics.debug !== "function") {
      return;
    }

    await this.diagnostics.debug(event, detail);
  }

  async sendRequest(request, failureDiagnostic) {
    try {
      return await requestUrl({
        ...request,
        throw: false
      });
    } catch (error) {
      await this.logDiagnostic(failureDiagnostic.event, {
        endpoint: failureDiagnostic.endpoint,
        model: failureDiagnostic.model,
        error: createProviderRequestErrorSummary(error)
      });
      throw error;
    }
  }
}

function createOpenAiStreamState() {
  return {
    content: "",
    reasoning: "",
    reasoningContent: "",
    reasoningText: "",
    reasoningDetails: [],
    reasoningDetailIndexes: new Map(),
    toolCalls: new Map(),
    usage: null,
    metadata: {},
    finishReason: "",
    done: false
  };
}

function captureOpenAiReasoningContext(state, delta) {
  if (typeof delta.reasoning_content === "string") {
    state.reasoningContent += delta.reasoning_content;
  }
  if (typeof delta.reasoning === "string") {
    state.reasoningText += delta.reasoning;
  }
  if (!Array.isArray(delta.reasoning_details)) {
    return;
  }
  for (let index = 0; index < delta.reasoning_details.length; index += 1) {
    const detail = delta.reasoning_details[index];
    if (!detail || typeof detail !== "object" || Array.isArray(detail)) {
      continue;
    }
    const key = createOpenAiReasoningDetailKey(detail, index);
    const existingIndex = state.reasoningDetailIndexes.get(key);
    if (!Number.isInteger(existingIndex)) {
      state.reasoningDetailIndexes.set(key, state.reasoningDetails.length);
      state.reasoningDetails.push(cloneJsonValue(detail));
      continue;
    }
    const existing = state.reasoningDetails[existingIndex];
    appendOpenAiReasoningDetailField(existing, detail, "text");
    appendOpenAiReasoningDetailField(existing, detail, "summary");
    appendOpenAiReasoningDetailField(existing, detail, "data");
    if (typeof detail.signature === "string" && detail.signature) {
      existing.signature = detail.signature;
    }
  }
}

function createOpenAiReasoningDetailKey(detail, fallbackIndex) {
  const index = Number.isInteger(detail.index) ? detail.index : fallbackIndex;
  const id = typeof detail.id === "string" ? detail.id : "";
  const type = typeof detail.type === "string" ? detail.type : "";
  const format = typeof detail.format === "string" ? detail.format : "";
  return `${index}:${id}:${type}:${format}`;
}

function appendOpenAiReasoningDetailField(target, source, field) {
  if (typeof source[field] !== "string") {
    return;
  }
  target[field] = `${typeof target[field] === "string" ? target[field] : ""}${source[field]}`;
}

function createStreamingOpenAiAssistantMessage(state, rawToolCalls) {
  return {
    role: "assistant",
    content: state.content || null,
    ...(state.reasoningContent ? { reasoning_content: state.reasoningContent } : {}),
    ...(state.reasoningText ? { reasoning: state.reasoningText } : {}),
    ...(state.reasoningDetails.length > 0 ? { reasoning_details: cloneJsonValue(state.reasoningDetails) } : {}),
    tool_calls: cloneJsonValue(rawToolCalls)
  };
}

async function applyOpenAiStreamChunk(state, data, nativeTools, onProgress) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("The provider returned an invalid Chat Completions stream event.");
  }
  if (data.usage && typeof data.usage === "object") {
    state.usage = data.usage;
  }
  if (typeof data.service_tier === "string") {
    state.metadata.service_tier = data.service_tier;
  }
  const choices = Array.isArray(data.choices) ? data.choices : [];
  for (const choice of choices) {
    const choiceIndex = Number.isInteger(choice?.index) ? choice.index : 0;
    const delta = choice?.delta && typeof choice.delta === "object" ? choice.delta : {};
    captureOpenAiReasoningContext(state, delta);
    for (const reasoningDelta of readOpenAiReasoningDeltas(delta)) {
      state.reasoning += reasoningDelta;
      await emitProviderProgress(onProgress, {
        type: "reasoning-delta",
        delta: reasoningDelta
      });
    }
    const content = normalizeOpenAiMessageContent(delta.content);
    if (content) {
      state.content += content;
      await emitProviderProgress(onProgress, {
        type: "text-delta",
        delta: content
      });
    }
    accumulateOpenAiToolCallDeltas(state.toolCalls, delta.tool_calls, choiceIndex, nativeTools);
    if (typeof choice?.finish_reason === "string" && choice.finish_reason) {
      state.finishReason = choice.finish_reason;
    }
  }
}

function readOpenAiReasoningDeltas(delta) {
  const values = [];
  const direct = typeof delta.reasoning_content === "string"
    ? delta.reasoning_content
    : (typeof delta.reasoning === "string" ? delta.reasoning : "");
  if (direct) {
    values.push(direct);
  }
  if (Array.isArray(delta.reasoning_details)) {
    for (const detail of delta.reasoning_details) {
      const type = typeof detail?.type === "string" ? detail.type : "";
      const text = type === "reasoning.text" && typeof detail.text === "string"
        ? detail.text
        : (type === "reasoning.summary" && typeof detail.summary === "string" ? detail.summary : "");
      if (text && !values.includes(text)) {
        values.push(text);
      }
    }
  }
  return values;
}

function accumulateOpenAiToolCallDeltas(toolCalls, deltas, choiceIndex) {
  if (!Array.isArray(deltas)) {
    return;
  }
  for (const delta of deltas) {
    const index = Number.isInteger(delta?.index) ? delta.index : toolCalls.size;
    const key = (choiceIndex * 100000) + index;
    const current = toolCalls.get(key) ?? {
      id: "",
      type: "function",
      function: {
        name: "",
        arguments: ""
      }
    };
    if (typeof delta?.id === "string" && delta.id) {
      current.id = delta.id;
    }
    if (typeof delta?.type === "string" && delta.type) {
      current.type = delta.type;
    }
    if (typeof delta?.function?.name === "string") {
      current.function.name += delta.function.name;
    }
    if (typeof delta?.function?.arguments === "string") {
      current.function.arguments += delta.function.arguments;
    }
    toolCalls.set(key, current);
  }
}

async function emitProviderProgress(onProgress, event) {
  await Promise.resolve(onProgress(event));
}

function createFetchJsonRead(snapshot) {
  return snapshot?.json && typeof snapshot.json === "object"
    ? { hasJson: true, value: snapshot.json, error: "" }
    : { hasJson: false, value: null, error: "" };
}

function normalizeRequestOptions(options) {
  const normalized = {};

  if (typeof options?.temperature === "number" && Number.isFinite(options.temperature)) {
    normalized.temperature = options.temperature;
  }

  if (typeof options?.top_p === "number" && Number.isFinite(options.top_p)) {
    normalized.top_p = options.top_p;
  }

  if (Number.isInteger(options?.top_k) && options.top_k > 0) {
    normalized.top_k = options.top_k;
  }

  if (typeof options?.reasoning_effort === "string" && options.reasoning_effort.trim()) {
    normalized.reasoning_effort = options.reasoning_effort.trim();
  }

  return normalized;
}

function normalizeOpenAiMessageContent(content) {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }

      if (part?.type === "text" && typeof part.text === "string") {
        return part.text;
      }

      return "";
    })
    .filter(Boolean)
    .join("");
}

function createOpenAiRequestMessages(messages, options = {}) {
  if (!options.providerContext) {
    return cloneJsonValue(Array.isArray(messages) ? messages : []);
  }
  const context = normalizeOpenAiProviderContext(options.providerContext);
  const toolResults = normalizeOpenAiToolResults(options.toolResults, context.assistantMessage.tool_calls);
  const continuationMessages = normalizeOpenAiContinuationMessages(options.continuationMessages);
  return [
    ...cloneJsonValue(context.messages),
    cloneJsonValue(context.assistantMessage),
    ...toolResults,
    ...continuationMessages
  ];
}

function normalizeOpenAiProviderContext(value) {
  if (
    !value ||
    value.type !== "openai-chat-completions" ||
    !Array.isArray(value.messages) ||
    !value.assistantMessage ||
    value.assistantMessage.role !== "assistant" ||
    !Array.isArray(value.assistantMessage.tool_calls) ||
    value.assistantMessage.tool_calls.length === 0
  ) {
    throw new Error("OpenAI-compatible native tool continuation context is invalid.");
  }
  const toolCallIds = new Set();
  for (const toolCall of value.assistantMessage.tool_calls) {
    const rawId = typeof toolCall?.id === "string" ? toolCall.id : "";
    const id = rawId.trim();
    if (!id || rawId !== id || toolCallIds.has(id)) {
      throw new Error("OpenAI-compatible native tool continuation context is invalid.");
    }
    toolCallIds.add(id);
  }
  return cloneJsonValue(value);
}

function normalizeOpenAiToolResults(results, toolCalls) {
  const expectedIds = toolCalls.map((toolCall) => toolCall.id);
  const expectedIdSet = new Set(expectedIds);
  const resultById = new Map();
  for (const result of Array.isArray(results) ? results : []) {
    const providerCallId = typeof result?.providerCallId === "string" ? result.providerCallId.trim() : "";
    if (!providerCallId || !expectedIdSet.has(providerCallId)) {
      continue;
    }
    if (resultById.has(providerCallId)) {
      throw new Error("OpenAI-compatible native tool results are invalid.");
    }
    resultById.set(providerCallId, result);
  }
  if (resultById.size !== expectedIds.length || expectedIds.some((id) => !resultById.has(id))) {
    throw new Error("OpenAI-compatible native tool results do not match the pending tool calls.");
  }
  return expectedIds.map((id) => {
    const result = resultById.get(id);
    const output = typeof result.output === "string" && result.output
      ? result.output
      : (typeof result.error === "string" && result.error ? result.error : "Tool returned no content.");
    return {
      role: "tool",
      tool_call_id: id,
      content: output
    };
  });
}

function normalizeOpenAiContinuationMessages(messages) {
  return (Array.isArray(messages) ? messages : [])
    .map((message) => {
      const content = typeof message?.content === "string" ? message.content : "";
      return content ? { role: "user", content } : null;
    })
    .filter(Boolean);
}

function createOpenAiProviderContext(messages, assistantMessage, rawToolCalls, normalizedToolCalls) {
  if (
    !Array.isArray(rawToolCalls) ||
    rawToolCalls.length === 0 ||
    rawToolCalls.length !== normalizedToolCalls.length ||
    rawToolCalls.some((toolCall) => (
      typeof toolCall?.id !== "string" || !toolCall.id.trim() || toolCall.id !== toolCall.id.trim()
    ))
  ) {
    return null;
  }
  const normalizedAssistantMessage = {
    role: "assistant",
    content: assistantMessage?.content ?? null,
    ...(typeof assistantMessage?.reasoning_content === "string" ? {
      reasoning_content: assistantMessage.reasoning_content
    } : {}),
    ...(typeof assistantMessage?.reasoning === "string" ? {
      reasoning: assistantMessage.reasoning
    } : {}),
    ...(Array.isArray(assistantMessage?.reasoning_details) ? {
      reasoning_details: cloneJsonValue(assistantMessage.reasoning_details)
    } : {}),
    tool_calls: cloneJsonValue(rawToolCalls)
  };
  return {
    type: "openai-chat-completions",
    messages: cloneJsonValue(messages),
    assistantMessage: normalizedAssistantMessage
  };
}

function cloneJsonValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function estimateJsonCharacters(value) {
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
}

function normalizeOpenAiToolCalls(toolCalls, nativeTools = []) {
  if (!Array.isArray(toolCalls)) {
    return [];
  }

  const nativeToolMap = createNativeToolMap(nativeTools);
  if (nativeToolMap.size === 0) {
    return [];
  }

  return toolCalls
    .map((toolCall) => {
      const fn = toolCall?.function ?? {};
      const toolName = typeof fn.name === "string" ? fn.name.trim() : "";
      if (!toolName) {
        return null;
      }

      const match = nativeToolMap.get(toolName);
      if (!match) {
        return null;
      }

      const providerCallId = typeof toolCall?.id === "string" ? toolCall.id.trim() : "";
      return {
        serverId: match.target.serverId,
        toolName: match.target.toolName,
        arguments: parseToolArguments(fn.arguments),
        reason: "Provider returned a native OpenAI-compatible tool call.",
        exactToolName: true,
        ...(providerCallId ? { providerCallId } : {})
      };
    })
    .filter(Boolean);
}

function normalizeNativeTools(tools) {
  if (!Array.isArray(tools)) {
    return [];
  }

  return tools
    .map((tool) => {
      const name = typeof tool?.name === "string" ? tool.name.trim() : "";
      const targetToolName = typeof tool?.target?.toolName === "string" ? tool.target.toolName.trim() : "";
      if (!name || !targetToolName) {
        return null;
      }

      return {
        name,
        aliases: normalizeNativeToolAliases(tool.aliases, name),
        description: typeof tool.description === "string" ? tool.description.trim() : "",
        parameters: normalizeToolParameters(tool.parameters),
        target: {
          serverId: typeof tool.target.serverId === "string" ? tool.target.serverId.trim() : "",
          toolName: targetToolName
        }
      };
    })
    .filter(Boolean);
}

function normalizeToolParameters(parameters) {
  if (parameters && typeof parameters === "object" && !Array.isArray(parameters)) {
    return JSON.parse(JSON.stringify(parameters));
  }

  return {
    type: "object",
    properties: {},
    additionalProperties: false
  };
}

function createOpenAiToolDeclaration(tool) {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    }
  };
}

function createNativeToolMap(nativeTools) {
  const map = new Map();
  const exactToolNameCounts = new Map();
  const aliasCounts = new Map();

  for (const tool of nativeTools) {
    const exactToolName = tool?.target?.toolName;
    if (!exactToolName) {
      continue;
    }

    exactToolNameCounts.set(exactToolName, (exactToolNameCounts.get(exactToolName) ?? 0) + 1);
    for (const alias of tool.aliases ?? []) {
      aliasCounts.set(alias, (aliasCounts.get(alias) ?? 0) + 1);
    }
  }

  for (const tool of nativeTools) {
    map.set(tool.name, {
      target: tool.target,
      matchType: "declared"
    });
  }

  for (const tool of nativeTools) {
    const exactToolName = tool?.target?.toolName;
    if (exactToolName && exactToolNameCounts.get(exactToolName) === 1 && !map.has(exactToolName)) {
      map.set(exactToolName, {
        target: tool.target,
        matchType: "target"
      });
    }
  }

  for (const tool of nativeTools) {
    for (const alias of tool.aliases ?? []) {
      if (aliasCounts.get(alias) === 1 && !map.has(alias)) {
        map.set(alias, {
          target: tool.target,
          matchType: "alias"
        });
      }
    }
  }

  return map;
}

function createOpenAiRecoveredToolCallSummary(toolCalls, nativeTools = []) {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0 || !Array.isArray(nativeTools) || nativeTools.length === 0) {
    return null;
  }

  const nativeToolMap = createNativeToolMap(nativeTools);
  const recoveredToolNames = toolCalls
    .map((toolCall) => {
      const fn = toolCall?.function ?? {};
      const toolName = typeof fn.name === "string" ? fn.name.trim() : "";
      return nativeToolMap.get(toolName)?.matchType === "alias" ? toolName : "";
    })
    .filter(Boolean);
  if (recoveredToolNames.length === 0) {
    return null;
  }

  return {
    status: "recovered",
    recoveredToolCallCount: recoveredToolNames.length,
    recoveredToolNames: uniqueDiagnosticNames(recoveredToolNames)
  };
}

function normalizeNativeToolAliases(aliases, declaredName) {
  if (!Array.isArray(aliases)) {
    return [];
  }

  return Array.from(new Set(
    aliases
      .map((alias) => typeof alias === "string" ? alias.trim() : "")
      .filter((alias) => alias && alias !== declaredName)
  ));
}

function createOpenAiUnmappedToolCallSummary(toolCalls, nativeTools = []) {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0 || !Array.isArray(nativeTools) || nativeTools.length === 0) {
    return null;
  }

  const nativeToolMap = createNativeToolMap(nativeTools);
  if (nativeToolMap.size === 0) {
    return null;
  }

  const rawToolNames = toolCalls
    .map((toolCall) => {
      const fn = toolCall?.function ?? {};
      return typeof fn.name === "string" ? fn.name.trim() : "";
    })
    .filter(Boolean);
  const unmappedToolNames = rawToolNames.filter((toolName) => !nativeToolMap.has(toolName));
  if (unmappedToolNames.length === 0) {
    return null;
  }

  const declaredNativeToolNames = nativeTools
    .map((tool) => typeof tool?.name === "string" ? tool.name.trim() : "")
    .filter(Boolean);
  const declaredTargetToolNames = nativeTools
    .map((tool) => typeof tool?.target?.toolName === "string" ? tool.target.toolName.trim() : "")
    .filter(Boolean);

  return {
    status: "failed",
    rawToolCallCount: rawToolNames.length,
    mappedToolCallCount: rawToolNames.length - unmappedToolNames.length,
    unmappedToolCallCount: unmappedToolNames.length,
    unmappedToolNames: uniqueDiagnosticNames(unmappedToolNames),
    declaredNativeToolCount: declaredNativeToolNames.length,
    declaredNativeToolNames: uniqueDiagnosticNames(declaredNativeToolNames),
    declaredTargetToolNames: uniqueDiagnosticNames(declaredTargetToolNames)
  };
}

function uniqueDiagnosticNames(values) {
  return Array.from(new Set(
    values
      .map((value) => createSafePreview(value))
      .filter(Boolean)
  )).slice(0, MAX_NATIVE_TOOL_DIAGNOSTIC_NAMES);
}

function parseToolArguments(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return JSON.parse(JSON.stringify(value));
  }

  if (typeof value !== "string" || !value.trim()) {
    return {};
  }

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function readResponseJson(response) {
  try {
    const value = response?.json;
    if (value && typeof value === "object") {
      return {
        hasJson: true,
        value,
        error: ""
      };
    }
  } catch (error) {
    return {
      hasJson: false,
      value: null,
      error: error instanceof Error ? error.message : String(error ?? "Unknown JSON error.")
    };
  }

  return {
    hasJson: false,
    value: null,
    error: ""
  };
}

function createChatResponseSummary(response, jsonRead) {
  const data = jsonRead.hasJson ? jsonRead.value : {};
  const firstChoice = Array.isArray(data?.choices) ? data.choices[0] : null;
  const message = firstChoice?.message ?? {};
  const content = normalizeOpenAiMessageContent(message.content);

  return {
    status: Number.isInteger(response?.status) ? response.status : null,
    hasJson: jsonRead.hasJson,
    jsonError: jsonRead.error,
    choiceCount: Array.isArray(data?.choices) ? data.choices.length : 0,
    finishReason: typeof firstChoice?.finish_reason === "string" ? firstChoice.finish_reason : "",
    messageKeys: Object.keys(message).sort(),
    contentLength: content.length,
    nativeToolCallCount: Array.isArray(message.tool_calls) ? message.tool_calls.length : 0,
    usage: createOpenAiUsageSummary(data),
    providerError: createProviderErrorSummary(data),
    headers: createSafeResponseHeaderSummary(response)
  };
}

function createRejectedChatResponseSummary(response, jsonRead) {
  const data = jsonRead.hasJson ? jsonRead.value : null;

  return {
    status: Number.isInteger(response?.status) ? response.status : null,
    hasJson: jsonRead.hasJson,
    hasJsonReadError: Boolean(jsonRead.error),
    headers: createSafeResponseHeaderSummary(response),
    shape: createOpenAiResponseShapeSummary(data)
  };
}

function createOpenAiResponseShapeSummary(data) {
  const isRecord = Boolean(data) && typeof data === "object" && !Array.isArray(data);
  const fieldNames = isRecord ? Object.keys(data) : [];

  return {
    rootType: createDiagnosticValueType(data),
    topLevelFieldCount: Math.min(fieldNames.length, 40),
    topLevelFieldCountTruncated: fieldNames.length > 40,
    choicesType: createDiagnosticRecordFieldType(data, "choices"),
    dataType: createDiagnosticRecordFieldType(data, "data"),
    errorType: createDiagnosticRecordFieldType(data, "error"),
    messageType: createDiagnosticRecordFieldType(data, "message"),
    responseType: createDiagnosticRecordFieldType(data, "response")
  };
}

function createDiagnosticRecordFieldType(data, fieldName) {
  if (!data || typeof data !== "object" || Array.isArray(data) || !Object.prototype.hasOwnProperty.call(data, fieldName)) {
    return "missing";
  }

  return createDiagnosticValueType(data[fieldName]);
}

function createDiagnosticValueType(value) {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }

  return typeof value;
}

function readOpenAiUsageFields(data) {
  const usage = data?.usage && typeof data.usage === "object" ? data.usage : {};
  const hasUsage = data?.usage && typeof data.usage === "object";
  const completionDetails = usage.completion_tokens_details && typeof usage.completion_tokens_details === "object"
    ? usage.completion_tokens_details
    : {};
  const promptDetails = usage.prompt_tokens_details && typeof usage.prompt_tokens_details === "object"
    ? usage.prompt_tokens_details
    : {};

  return {
    present: Boolean(hasUsage),
    inputTokens: readFiniteNumber(usage.prompt_tokens),
    outputTokens: readFiniteNumber(usage.completion_tokens),
    totalTokens: readFiniteNumber(usage.total_tokens),
    reasoningTokens: readFiniteNumber(completionDetails.reasoning_tokens),
    cachedTokens: readFiniteNumber(promptDetails.cached_tokens)
  };
}

function createOpenAiUsageSummary(data) {
  const usage = readOpenAiUsageFields(data);
  return {
    present: usage.present,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    reasoningTokens: usage.reasoningTokens,
    cachedTokens: usage.cachedTokens,
    cachedTokensPresent: Number.isFinite(usage.cachedTokens)
  };
}

function createOpenAiResponseMetadata(data, firstChoice) {
  const usage = readOpenAiUsageFields(data);
  const metadata = {
    usage: {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      reasoningTokens: usage.reasoningTokens,
      cachedTokens: usage.cachedTokens
    },
    serviceTier: typeof data?.service_tier === "string" ? data.service_tier : "",
    finishReason: typeof firstChoice?.finish_reason === "string" ? firstChoice.finish_reason : ""
  };

  return usage.present || metadata.serviceTier ? metadata : null;
}

function readFiniteNumber(value) {
  return Number.isFinite(value) ? value : null;
}

function summarizeEndpoint(endpoint) {
  const value = String(endpoint ?? "").trim();
  if (!value) {
    return {
      present: false,
      protocol: "",
      host: "",
      path: "",
      hasQuery: false
    };
  }

  try {
    const parsed = new URL(value);
    return {
      present: true,
      protocol: parsed.protocol.replace(/:$/, ""),
      host: parsed.host,
      path: parsed.pathname,
      hasQuery: Boolean(parsed.search)
    };
  } catch {
    return {
      present: true,
      protocol: "",
      host: "",
      path: "",
      hasQuery: value.includes("?")
    };
  }
}

function createProviderRequestErrorSummary(error) {
  return {
    name: error instanceof Error ? error.name : "",
    message: createSafePreview(error instanceof Error ? error.message : String(error ?? "Unknown request error.")),
    status: readErrorStatus(error),
    hasResponse: Boolean(error?.response),
    responseTextPreview: createSafePreview(readErrorResponseText(error))
  };
}

function createProviderHttpErrorSummary(response, jsonRead) {
  return {
    status: Number.isInteger(response?.status) ? response.status : null,
    hasJson: jsonRead.hasJson,
    jsonError: jsonRead.error,
    providerError: createProviderErrorSummary(jsonRead.hasJson ? jsonRead.value : null),
    headers: createSafeResponseHeaderSummary(response),
    responseTextPreview: createSafePreview(readResponseText(response))
  };
}

function createProviderHttpErrorMessage(label, response, jsonRead) {
  const status = Number.isInteger(response?.status) ? response.status : "unknown";
  const details = createProviderErrorDisplayText(response, jsonRead);
  if (details) {
    return `${label} failed with status ${status}: ${details}`;
  }

  return `${label} failed with status ${status}.`;
}

function createProviderErrorDisplayText(response, jsonRead) {
  const providerError = createProviderErrorSummary(jsonRead.hasJson ? jsonRead.value : null) ?? {};
  const detailParts = [];
  if (providerError.message) {
    detailParts.push(providerError.message);
  }

  const attributes = [];
  if (providerError.type) {
    attributes.push(`type: ${providerError.type}`);
  }
  if (providerError.code) {
    attributes.push(`code: ${providerError.code}`);
  }
  if (providerError.status) {
    attributes.push(`status: ${providerError.status}`);
  }
  if (attributes.length > 0) {
    detailParts.push(`(${attributes.join(", ")})`);
  }

  if (detailParts.length > 0) {
    return detailParts.join(" ");
  }

  return createSafePreview(readResponseText(response));
}

function createProviderErrorSummary(data) {
  const error = data?.error && typeof data.error === "object" ? data.error : null;
  if (!error) {
    return null;
  }

  return {
    message: createSafePreview(error.message),
    type: createSafePreview(error.type),
    code: createSafePreview(error.code),
    param: createSafePreview(error.param),
    status: createSafePreview(error.status)
  };
}

function createSafeResponseHeaderSummary(response) {
  const headers = response?.headers && typeof response.headers === "object" ? response.headers : {};
  const summary = {};

  for (const [headerName, headerValue] of Object.entries(headers)) {
    const normalizedName = String(headerName ?? "").trim().toLowerCase();
    if (!isSafeResponseHeaderName(normalizedName)) {
      continue;
    }

    const value = createSafePreview(headerValue).slice(0, 160);
    if (value) {
      summary[normalizedName] = value;
    }
  }

  return summary;
}

function isSafeResponseHeaderName(headerName) {
  return SAFE_RESPONSE_HEADER_NAMES.has(headerName) || headerName.startsWith("x-ratelimit-");
}

function readErrorStatus(error) {
  const candidates = [
    error?.status,
    error?.statusCode,
    error?.response?.status,
    error?.response?.statusCode
  ];

  for (const candidate of candidates) {
    const value = Number(candidate);
    if (Number.isInteger(value)) {
      return value;
    }
  }

  return null;
}

function readErrorResponseText(error) {
  const candidates = [
    error?.text,
    error?.body,
    error?.responseText,
    error?.response?.text,
    error?.response?.body
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate;
    }
  }

  return "";
}

function readResponseText(response) {
  const candidates = [
    response?.text,
    response?.body,
    response?.responseText
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate;
    }
  }

  return "";
}

function createSafePreview(value) {
  const text = redactSensitiveText(String(value ?? "").replace(/\s+/g, " ").trim());
  return text.slice(0, 360);
}

function redactSensitiveText(value) {
  return String(value ?? "")
    .replace(/Authorization\s*:\s*Bearer\s+[^\s,;]+/gi, "Authorization: Bearer [REDACTED]")
    .replace(/Authorization\s*:\s*(?!Bearer\b)[^\s,;]+/gi, "Authorization: [REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]+/g, "sk-[REDACTED]")
    .replace(/(api[_-]?key\s*[=:]\s*)[^\s,;]+/gi, "$1[REDACTED]");
}

module.exports = {
  OpenAiCompatibleClient
};
