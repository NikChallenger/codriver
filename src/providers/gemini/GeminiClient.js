const { requestUrl } = require("obsidian");
const {
  consumeServerSentEvents,
  isSuccessfulResponse,
  openStreamingResponse,
  readFetchResponse
} = require("../StreamingTransport");
const {
  DEFAULT_GEMINI_API_VERSION,
  DEFAULT_GEMINI_BASE_ENDPOINT
} = require("../../constants");

const MAX_NATIVE_TOOL_DIAGNOSTIC_NAMES = 40;
const GEMINI_GROUNDING_MAX_ATTEMPTS = 2;
const GEMINI_GROUNDING_RETRY_BASE_DELAY_MS = 1000;
const GEMINI_GROUNDING_RETRY_JITTER_MS = 250;
const GEMINI_GROUNDED_TOOL_CONTEXT_TYPE = "gemini-generate-content-grounded-tools";
const GEMINI_INVALID_GROUNDED_TOOL_CONTEXT_MESSAGE = "Gemini returned invalid grounded custom tool context. Disable Custom tools and try again.";
const GEMINI_INVALID_GROUNDED_TOOL_CONTINUATION_MESSAGE = "Gemini grounded custom tool continuation is no longer valid. Disable Custom tools and try again.";
const GEMINI_MALFORMED_TOOL_FINISH_REASONS = new Set([
  "MALFORMED_FUNCTION_CALL",
  "UNEXPECTED_TOOL_CALL",
  "TOO_MANY_TOOL_CALLS",
  "MISSING_THOUGHT_SIGNATURE",
  "MALFORMED_RESPONSE"
]);
const SAFE_GEMINI_FINISH_REASONS = new Set([
  "STOP",
  "MAX_TOKENS",
  "SAFETY",
  "RECITATION",
  "LANGUAGE",
  "OTHER",
  "BLOCKLIST",
  "PROHIBITED_CONTENT",
  "SPII",
  "MALFORMED_FUNCTION_CALL",
  "IMAGE_SAFETY",
  "IMAGE_PROHIBITED_CONTENT",
  "IMAGE_OTHER",
  "NO_IMAGE",
  "IMAGE_RECITATION",
  "UNEXPECTED_TOOL_CALL",
  "TOO_MANY_TOOL_CALLS",
  "MISSING_THOUGHT_SIGNATURE",
  "MALFORMED_RESPONSE"
]);
const SUPPORTED_LOCAL_SCHEMA_KEYS = new Set([
  "$comment",
  "$defs",
  "$id",
  "$ref",
  "$schema",
  "additionalProperties",
  "allOf",
  "anyOf",
  "const",
  "default",
  "definitions",
  "deprecated",
  "description",
  "enum",
  "examples",
  "exclusiveMaximum",
  "exclusiveMinimum",
  "format",
  "items",
  "maxItems",
  "maxLength",
  "maxProperties",
  "maximum",
  "minItems",
  "minLength",
  "minProperties",
  "minimum",
  "multipleOf",
  "not",
  "oneOf",
  "pattern",
  "patternProperties",
  "prefixItems",
  "properties",
  "readOnly",
  "required",
  "title",
  "type",
  "uniqueItems",
  "writeOnly"
]);
const SAFE_RESPONSE_HEADER_NAMES = new Set([
  "openai-request-id",
  "request-id",
  "retry-after",
  "x-goog-request-id",
  "x-request-id"
]);

class GeminiClient {
  constructor(baseEndpoint = DEFAULT_GEMINI_BASE_ENDPOINT, apiVersion = DEFAULT_GEMINI_API_VERSION, apiKeyResolver = "", options = {}) {
    this.baseEndpoint = String(baseEndpoint || DEFAULT_GEMINI_BASE_ENDPOINT).replace(/\/+$/, "");
    this.apiVersion = String(apiVersion || DEFAULT_GEMINI_API_VERSION).replace(/^\/+|\/+$/g, "");
    this.apiKeyResolver = typeof apiKeyResolver === "function"
      ? apiKeyResolver
      : () => apiKeyResolver;
    this.generationConfig = normalizeGenerationConfig(options.generationConfig);
    this.enableGoogleSearch = options.enableGoogleSearch === true;
    this.enableGroundedCustomTools = options.enableGroundedCustomTools === true;
    this.diagnostics = options.diagnostics ?? null;
    this.retryDelay = typeof options.retryDelay === "function" ? options.retryDelay : waitForRetry;
    this.retryRandom = typeof options.retryRandom === "function" ? options.retryRandom : Math.random;
    this.fetch = options.fetch;
  }

  async createHeaders(extraHeaders = {}) {
    const apiKey = String((await Promise.resolve(this.apiKeyResolver())) ?? "").trim();
    if (!apiKey) {
      throw new Error("Set a Gemini API key secret before using this provider.");
    }

    return {
      Accept: "application/json",
      "x-goog-api-key": apiKey,
      ...extraHeaders
    };
  }

  createUrl(path) {
    const cleanPath = String(path ?? "").replace(/^\/+/, "");
    return `${this.baseEndpoint}/${this.apiVersion}/${cleanPath}`;
  }

  async listModels() {
    const response = await requestUrl({
      url: this.createUrl("models?pageSize=1000"),
      method: "GET",
      headers: await this.createHeaders()
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Gemini model list request failed with status ${response.status}.`);
    }

    const data = response.json ?? {};
    if (!Array.isArray(data.models)) {
      throw new Error("Gemini responded, but not with a model list.");
    }

    return Array.from(new Set(
      data.models
        .filter((model) => supportsGenerateContent(model))
        .map((model) => getGeminiModelId(model))
        .filter(Boolean)
    ));
  }

  async testConnection() {
    const models = await this.listModels();

    return {
      modelCount: models.length,
      models
    };
  }

  async createChatCompletion(model, messages, signal = null, options = {}) {
    const requestedNativeTools = normalizeNativeTools(options.nativeTools);
    const enableGoogleSearch = this.enableGoogleSearch && options.enableGoogleSearch !== false;
    const groundedCustomToolsRequested = this.enableGroundedCustomTools && enableGoogleSearch;
    const providerContext = options.providerContext;
    if (providerContext && !groundedCustomToolsRequested) {
      throw new Error(GEMINI_INVALID_GROUNDED_TOOL_CONTINUATION_MESSAGE);
    }

    const mapped = this.createGenerateContentRequest(messages, requestedNativeTools, model, enableGoogleSearch, {
      providerContext,
      continuationMessages: options.continuationMessages,
      toolResults: options.toolResults,
      groundedCustomToolsRequested
    });
    const nativeTools = mapped.nativeTools;
    const omitNativeToolsForGoogleSearch = shouldOmitNativeToolsForGoogleSearch(
      enableGoogleSearch,
      nativeTools,
      groundedCustomToolsRequested
    );
    const effectiveNativeTools = omitNativeToolsForGoogleSearch ? [] : nativeTools;
    if (omitNativeToolsForGoogleSearch) {
      await this.logDiagnostic("provider.gemini.google_search.native_tools_omitted", {
        endpoint: summarizeEndpoint(this.baseEndpoint),
        apiVersion: this.apiVersion,
        model,
        omittedNativeToolCount: nativeTools.length,
        reason: "Grounded custom tools are not enabled for this provider."
      });
    }

    const requestBody = mapped.request;
    const groundingConfiguration = createGeminiGroundingConfigurationSummary(
      requestBody,
      requestedNativeTools,
      effectiveNativeTools,
      omitNativeToolsForGoogleSearch,
      mapped.groundedCustomToolsActive,
      mapped.suppressNativeToolCalls
    );
    if (typeof options.onProgress === "function") {
      return await this.createStreamingChatCompletion({
        model,
        requestBody,
        nativeTools,
        effectiveNativeTools,
        mapped,
        signal,
        onProgress: options.onProgress,
        enableGoogleSearch,
        groundingConfiguration
      });
    }
    const request = {
      url: this.createUrl(`${normalizeModelPath(model)}:generateContent`),
      method: "POST",
      headers: await this.createHeaders({
        "Content-Type": "application/json"
      }),
      body: JSON.stringify(requestBody)
    };

    if (signal) {
      request.signal = signal;
    }

    const failureDiagnostic = {
      event: "provider.gemini.chat.request.failed",
      endpoint: summarizeEndpoint(this.baseEndpoint),
      apiVersion: this.apiVersion,
      model,
      groundingConfiguration,
      enableGoogleSearch
    };
    let response;
    try {
      response = enableGoogleSearch
        ? await this.sendGroundedRequest(request, failureDiagnostic, signal)
        : await this.sendRequest(request, failureDiagnostic);
    } catch (error) {
      if (mapped.groundedCustomToolsActive && !isAbortError(error, signal)) {
        throw new Error(createGeminiGroundedCustomToolsHttpErrorMessage({
          status: readErrorStatus(error)
        }));
      }
      throw error;
    }
    const jsonRead = readResponseJson(response);

    await this.logDiagnostic("provider.gemini.chat.response.received", {
      endpoint: summarizeEndpoint(this.baseEndpoint),
      apiVersion: this.apiVersion,
      model,
      response: createGeminiResponseSummary(response, jsonRead, {
        includeProviderErrorDetails: !enableGoogleSearch
      })
    });

    if (response.status < 200 || response.status >= 300) {
      await this.logDiagnostic("provider.gemini.chat.response.failed", {
        status: "failed",
        endpoint: summarizeEndpoint(this.baseEndpoint),
        apiVersion: this.apiVersion,
        model,
        response: createProviderHttpErrorSummary(response, jsonRead, {
          includeProviderErrorDetails: !enableGoogleSearch
        })
      });
      if (mapped.groundedCustomToolsActive) {
        throw new Error(createGeminiGroundedCustomToolsHttpErrorMessage(response));
      }
      throw new Error(createProviderHttpErrorMessage("Gemini generation request", response, jsonRead));
    }

    const data = jsonRead.hasJson ? jsonRead.value : {};
    const candidate = data?.candidates?.[0];
    const parts = candidate?.content?.parts;
    if (!Array.isArray(parts)) {
      throw new Error("Gemini responded, but not with generated content.");
    }

    if (mapped.groundedCustomToolsActive) {
      const validationReason = validateGeminiGroundedToolResponse(candidate, nativeTools, requestBody.contents, {
        suppressNativeToolCalls: mapped.suppressNativeToolCalls
      });
      if (validationReason) {
        await this.logDiagnostic("provider.gemini.grounded_custom_tools.context.invalid", {
          status: "failed",
          endpoint: summarizeEndpoint(this.baseEndpoint),
          apiVersion: this.apiVersion,
          model,
          reason: validationReason,
          finishReason: createSafeGeminiFinishReason(candidate?.finishReason),
          partCount: parts.length,
          nativeToolCallCount: countGeminiFunctionCalls(parts)
        });
        throw new Error(GEMINI_INVALID_GROUNDED_TOOL_CONTEXT_MESSAGE);
      }
    }

    const metadata = createGeminiResponseMetadata(data, candidate);
    const result = {
      content: parts
        .filter((part) => part?.thought !== true)
        .map((part) => part?.text)
        .filter((text) => typeof text === "string")
        .join(""),
      toolCalls: await this.createGeminiToolCalls(parts, effectiveNativeTools, model, {
        requireProviderCallId: mapped.groundedCustomToolsActive
      }),
      ...(metadata ? { metadata } : {})
    };
    if (mapped.groundedCustomToolsActive) {
      const nextProviderContext = createGeminiGroundedToolContext(
        requestBody,
        candidate.content,
        nativeTools
      );
      result.providerContext = nextProviderContext;
      result.providerContextCharacters = estimateJsonCharacters(nextProviderContext);
    }

    return result;
  }

  async createStreamingChatCompletion(options) {
    const {
      model,
      requestBody,
      nativeTools,
      effectiveNativeTools,
      mapped,
      signal,
      onProgress,
      enableGoogleSearch,
      groundingConfiguration
    } = options;
    const streamingBody = cloneJson(requestBody);
    streamingBody.generationConfig = isPlainObject(streamingBody.generationConfig)
      ? streamingBody.generationConfig
      : {};
    streamingBody.generationConfig.thinkingConfig = isPlainObject(streamingBody.generationConfig.thinkingConfig)
      ? streamingBody.generationConfig.thinkingConfig
      : {};
    streamingBody.generationConfig.thinkingConfig.includeThoughts = true;
    const request = {
      url: this.createUrl(`${normalizeModelPath(model)}:streamGenerateContent?alt=sse`),
      method: "POST",
      headers: await this.createHeaders({
        Accept: "text/event-stream",
        "Content-Type": "application/json"
      }),
      body: JSON.stringify(streamingBody),
      ...(signal ? { signal } : {})
    };
    let response;
    try {
      response = await openStreamingResponse(request, { fetch: this.fetch });
    } catch (error) {
      await this.logDiagnostic("provider.gemini.chat.request.failed", {
        endpoint: summarizeEndpoint(this.baseEndpoint),
        apiVersion: this.apiVersion,
        model,
        groundingConfiguration,
        enableGoogleSearch,
        error: createProviderRequestErrorSummary(error, {
          includeMessageDetails: !enableGoogleSearch
        })
      });
      throw error;
    }

    if (!isSuccessfulResponse(response)) {
      const snapshot = await readFetchResponse(response);
      const jsonRead = createFetchJsonRead(snapshot);
      await this.logDiagnostic("provider.gemini.chat.response.failed", {
        status: "failed",
        endpoint: summarizeEndpoint(this.baseEndpoint),
        apiVersion: this.apiVersion,
        model,
        response: createProviderHttpErrorSummary(snapshot, jsonRead, {
          includeProviderErrorDetails: !enableGoogleSearch
        })
      });
      if (mapped.groundedCustomToolsActive) {
        throw new Error(createGeminiGroundedCustomToolsHttpErrorMessage(snapshot));
      }
      throw new Error(createProviderHttpErrorMessage("Gemini generation request", snapshot, jsonRead));
    }

    const state = createGeminiStreamState();
    const streamSummary = await consumeServerSentEvents(response, async (event) => {
      let data;
      try {
        data = JSON.parse(event.data);
      } catch {
        throw new Error("Gemini returned malformed JSON in the generation event stream.");
      }
      if (data?.error) {
        const snapshot = {
          status: response.status,
          headers: {},
          text: "",
          json: data
        };
        throw new Error(createProviderHttpErrorMessage(
          "Gemini generation stream",
          snapshot,
          { hasJson: true, value: data, error: "" }
        ));
      }
      await applyGeminiStreamChunk(state, data, onProgress);
    });
    if (!state.seenCandidate || !state.finishReason) {
      throw new Error("Gemini returned an incomplete generation event stream.");
    }

    const candidate = {
      content: {
        role: "model",
        parts: state.parts
      },
      finishReason: state.finishReason
    };
    if (mapped.groundedCustomToolsActive) {
      const validationReason = validateGeminiGroundedToolResponse(candidate, nativeTools, streamingBody.contents, {
        suppressNativeToolCalls: mapped.suppressNativeToolCalls
      });
      if (validationReason) {
        throw new Error(GEMINI_INVALID_GROUNDED_TOOL_CONTEXT_MESSAGE);
      }
    }
    const metadataSource = state.usageMetadata ? { usageMetadata: state.usageMetadata } : {};
    const metadata = createGeminiResponseMetadata(metadataSource, candidate);
    const result = {
      content: state.content,
      reasoning: state.reasoning,
      toolCalls: await this.createGeminiToolCalls(state.parts, effectiveNativeTools, model, {
        requireProviderCallId: mapped.groundedCustomToolsActive
      }),
      ...(metadata ? { metadata } : {})
    };
    if (mapped.groundedCustomToolsActive) {
      const nextProviderContext = createGeminiGroundedToolContext(
        streamingBody,
        candidate.content,
        nativeTools
      );
      result.providerContext = nextProviderContext;
      result.providerContextCharacters = estimateJsonCharacters(nextProviderContext);
    }
    await this.logDiagnostic("provider.gemini.chat.response.received", {
      endpoint: summarizeEndpoint(this.baseEndpoint),
      apiVersion: this.apiVersion,
      model,
      response: {
        status: response.status,
        eventCount: streamSummary.eventCount,
        finishReason: createSafeGeminiFinishReason(state.finishReason),
        contentLength: state.content.length,
        reasoningLength: state.reasoning.length,
        partCount: state.parts.length,
        nativeToolCallCount: countGeminiFunctionCalls(state.parts),
        usage: createGeminiUsageSummary(metadataSource)
      }
    });
    return result;
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
        apiVersion: failureDiagnostic.apiVersion,
        model: failureDiagnostic.model,
        error: createProviderRequestErrorSummary(error, {
          includeMessageDetails: !failureDiagnostic.enableGoogleSearch
        })
      });
      throw error;
    }
  }

  async sendGroundedRequest(request, failureDiagnostic, signal) {
    for (let attempt = 1; attempt <= GEMINI_GROUNDING_MAX_ATTEMPTS; attempt += 1) {
      if (signal?.aborted) {
        throw createAbortError();
      }

      let response;
      try {
        response = await requestUrl({
          ...request,
          throw: false
        });
      } catch (error) {
        const status = readErrorStatus(error);
        await this.logDiagnostic("provider.gemini.google_search.request.attempt", {
          endpoint: failureDiagnostic.endpoint,
          apiVersion: failureDiagnostic.apiVersion,
          model: failureDiagnostic.model,
          attempt,
          maxAttempts: GEMINI_GROUNDING_MAX_ATTEMPTS,
          status,
          requestId: readSafeRequestId(error?.response),
          groundingConfiguration: failureDiagnostic.groundingConfiguration,
          error: createProviderRequestErrorSummary(error, { includeMessageDetails: false })
        });

        if (isAbortError(error, signal) || !isRetryableGeminiGroundingStatus(status) || attempt === GEMINI_GROUNDING_MAX_ATTEMPTS) {
          await this.logDiagnostic(failureDiagnostic.event, {
            endpoint: failureDiagnostic.endpoint,
            apiVersion: failureDiagnostic.apiVersion,
            model: failureDiagnostic.model,
            error: createProviderRequestErrorSummary(error, { includeMessageDetails: false })
          });
          throw error;
        }

        await this.waitForGroundingRetry(failureDiagnostic, attempt, signal);
        continue;
      }

      const status = Number.isInteger(response?.status) ? response.status : null;
      await this.logDiagnostic("provider.gemini.google_search.request.attempt", {
        endpoint: failureDiagnostic.endpoint,
        apiVersion: failureDiagnostic.apiVersion,
        model: failureDiagnostic.model,
        attempt,
        maxAttempts: GEMINI_GROUNDING_MAX_ATTEMPTS,
        status,
        requestId: readSafeRequestId(response),
        groundingConfiguration: failureDiagnostic.groundingConfiguration
      });

      if (!isRetryableGeminiGroundingStatus(status) || attempt === GEMINI_GROUNDING_MAX_ATTEMPTS) {
        return response;
      }

      await this.waitForGroundingRetry(failureDiagnostic, attempt, signal);
    }

    throw new Error("Gemini grounding request failed.");
  }

  async waitForGroundingRetry(failureDiagnostic, attempt, signal) {
    const delayMs = GEMINI_GROUNDING_RETRY_BASE_DELAY_MS + Math.floor(
      Math.max(0, Math.min(1, Number(this.retryRandom()) || 0)) * GEMINI_GROUNDING_RETRY_JITTER_MS
    );
    await this.logDiagnostic("provider.gemini.google_search.request.retry", {
      endpoint: failureDiagnostic.endpoint,
      apiVersion: failureDiagnostic.apiVersion,
      model: failureDiagnostic.model,
      attempt,
      nextAttempt: attempt + 1,
      maxAttempts: GEMINI_GROUNDING_MAX_ATTEMPTS,
      delayMs,
      groundingConfiguration: failureDiagnostic.groundingConfiguration
    });
    await this.retryDelay(delayMs, signal);
  }

  async createGeminiToolCalls(parts, nativeTools, model, options = {}) {
    const toolCalls = normalizeGeminiFunctionCalls(parts, nativeTools, options);
    const unmappedToolCallSummary = createGeminiUnmappedToolCallSummary(parts, nativeTools);
    if (unmappedToolCallSummary) {
      await this.logDiagnostic("provider.gemini.native_tool_call.mapping.failed", {
        endpoint: summarizeEndpoint(this.baseEndpoint),
        model,
        ...unmappedToolCallSummary
      });
    }

    return toolCalls;
  }

  createGenerateContentRequest(messages, nativeTools = [], model = "", enableGoogleSearch = this.enableGoogleSearch, options = {}) {
    const context = options.providerContext
      ? normalizeGeminiGroundedToolContext(options.providerContext)
      : null;
    if (options.providerContext && !context) {
      throw new Error(GEMINI_INVALID_GROUNDED_TOOL_CONTINUATION_MESSAGE);
    }

    if (context) {
      const retainedNativeTools = normalizeNativeTools(context.nativeTools);
      if (
        retainedNativeTools.length === 0 ||
        !nativeToolDeclarationsMatch(nativeTools, retainedNativeTools) ||
        validateGeminiGroundedToolHistory(context, retainedNativeTools)
      ) {
        throw new Error(GEMINI_INVALID_GROUNDED_TOOL_CONTINUATION_MESSAGE);
      }
      const suppressNativeToolCalls = nativeTools.length === 0;
      const continuationParts = createGeminiContinuationParts(
        context,
        options.toolResults,
        options.continuationMessages,
        retainedNativeTools
      );
      const request = {
        contents: [
          ...cloneJson(context.contents),
          {
            role: "user",
            parts: continuationParts
          }
        ]
      };
      if (context.systemInstruction) {
        request.systemInstruction = cloneJson(context.systemInstruction);
      }
      if (Object.keys(this.generationConfig).length > 0) {
        request.generationConfig = this.generationConfig;
      }
      applyGeminiTools(request, retainedNativeTools, true, {
        groundedCustomToolsActive: true,
        suppressNativeToolCalls
      });
      return {
        request,
        nativeTools: retainedNativeTools,
        groundedCustomToolsActive: true,
        suppressNativeToolCalls
      };
    }

    const systemText = [];
    const contents = [];

    for (const message of Array.isArray(messages) ? messages : []) {
      if (message?.role === "system") {
        systemText.push(extractTextContent(message.content));
        continue;
      }

      const parts = createGeminiParts(message?.content);
      if (parts.length === 0) {
        continue;
      }

      contents.push({
        role: message?.role === "assistant" ? "model" : "user",
        parts
      });
    }

    const request = {
      contents
    };

    const joinedSystemText = systemText.filter(Boolean).join("\n\n");
    if (joinedSystemText) {
      request.systemInstruction = {
        parts: [{ text: joinedSystemText }]
      };
    }

    if (Object.keys(this.generationConfig).length > 0) {
      request.generationConfig = this.generationConfig;
    }

    const groundedCustomToolsActive = options.groundedCustomToolsRequested === true && nativeTools.length > 0;
    applyGeminiTools(request, nativeTools, enableGoogleSearch, {
      groundedCustomToolsActive,
      suppressNativeToolCalls: false
    });

    return {
      request,
      nativeTools,
      groundedCustomToolsActive,
      suppressNativeToolCalls: false
    };
  }
}

function createGeminiStreamState() {
  return {
    content: "",
    reasoning: "",
    parts: [],
    usageMetadata: null,
    finishReason: "",
    seenCandidate: false
  };
}

async function applyGeminiStreamChunk(state, data, onProgress) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Gemini returned an invalid generation stream event.");
  }
  if (isPlainObject(data.usageMetadata)) {
    state.usageMetadata = cloneJson(data.usageMetadata);
  }
  for (const candidate of Array.isArray(data.candidates) ? data.candidates : []) {
    state.seenCandidate = true;
    if (typeof candidate?.finishReason === "string" && candidate.finishReason) {
      state.finishReason = candidate.finishReason;
    }
    for (const part of Array.isArray(candidate?.content?.parts) ? candidate.content.parts : []) {
      const clonedPart = cloneJson(part);
      state.parts.push(clonedPart);
      if (typeof part?.text !== "string" || !part.text) {
        continue;
      }
      if (part.thought === true) {
        state.reasoning += part.text;
        await Promise.resolve(onProgress({
          type: "reasoning-delta",
          delta: part.text
        }));
      } else {
        state.content += part.text;
        await Promise.resolve(onProgress({
          type: "text-delta",
          delta: part.text
        }));
      }
    }
  }
}

function createFetchJsonRead(snapshot) {
  return snapshot?.json && typeof snapshot.json === "object"
    ? { hasJson: true, value: snapshot.json, error: "" }
    : { hasJson: false, value: null, error: "" };
}

function applyGeminiTools(request, nativeTools, enableGoogleSearch, options = {}) {
  const tools = [];
  if (options.groundedCustomToolsActive === true) {
    tools.push({ googleSearch: {} });
    tools.push({
      functionDeclarations: nativeTools.map(createGeminiFunctionDeclaration)
    });
    request.toolConfig = {
      includeServerSideToolInvocations: true,
      functionCallingConfig: {
        mode: options.suppressNativeToolCalls === true ? "NONE" : "VALIDATED"
      }
    };
  } else {
    const includeNativeTools = nativeTools.length > 0 && !shouldOmitNativeToolsForGoogleSearch(
      enableGoogleSearch,
      nativeTools,
      false
    );
    if (includeNativeTools) {
      tools.push({
        functionDeclarations: nativeTools.map(createGeminiFunctionDeclaration)
      });
    }
    if (enableGoogleSearch) {
      tools.push({ google_search: {} });
    }
  }

  if (tools.length > 0) {
    request.tools = tools;
  }
}

function normalizeGeminiGroundedToolContext(context) {
  if (
    context?.type !== GEMINI_GROUNDED_TOOL_CONTEXT_TYPE ||
    !Array.isArray(context.contents) ||
    !Array.isArray(context.nativeTools) ||
    !context.contents.every((content) => isPlainObject(content) && Array.isArray(content.parts))
  ) {
    return null;
  }

  if (context.systemInstruction !== null && context.systemInstruction !== undefined && !isPlainObject(context.systemInstruction)) {
    return null;
  }

  return {
    type: GEMINI_GROUNDED_TOOL_CONTEXT_TYPE,
    systemInstruction: context.systemInstruction ? cloneJson(context.systemInstruction) : null,
    contents: cloneJson(context.contents),
    nativeTools: cloneJson(context.nativeTools)
  };
}

function createGeminiGroundedToolContext(requestBody, candidateContent, nativeTools) {
  return {
    type: GEMINI_GROUNDED_TOOL_CONTEXT_TYPE,
    systemInstruction: requestBody.systemInstruction ? cloneJson(requestBody.systemInstruction) : null,
    contents: cloneJson([
      ...requestBody.contents,
      candidateContent
    ]),
    nativeTools: cloneJson(nativeTools)
  };
}

function createGeminiContinuationParts(context, toolResults, continuationMessages, nativeTools) {
  const lastModelContent = [...context.contents]
    .reverse()
    .find((content) => content?.role === "model");
  const pendingFunctionCalls = Array.isArray(lastModelContent?.parts)
    ? lastModelContent.parts
      .map((part) => part?.functionCall)
      .filter((functionCall) => isPlainObject(functionCall))
    : [];
  const parts = pendingFunctionCalls.length > 0
    ? createGeminiFunctionResponseParts(pendingFunctionCalls, toolResults, nativeTools)
    : [];

  for (const message of Array.isArray(continuationMessages) ? continuationMessages : []) {
    if (message?.role === "user") {
      parts.push(...createGeminiParts(message.content));
    }
  }

  if (parts.length === 0) {
    throw new Error(GEMINI_INVALID_GROUNDED_TOOL_CONTINUATION_MESSAGE);
  }
  return parts;
}

function createGeminiFunctionResponseParts(functionCalls, toolResults, nativeTools) {
  const resultsById = new Map();
  const duplicateIds = new Set();
  for (const result of Array.isArray(toolResults) ? toolResults : []) {
    const id = readExactNonEmptyString(result?.providerCallId);
    if (!id) {
      continue;
    }
    if (resultsById.has(id)) {
      duplicateIds.add(id);
    }
    resultsById.set(id, result);
  }

  const nativeByName = new Map(nativeTools.map((tool) => [tool.name, tool]));
  return functionCalls.map((functionCall) => {
    const id = readExactNonEmptyString(functionCall.id);
    const name = readExactNonEmptyString(functionCall.name);
    const nativeTool = nativeByName.get(name);
    const result = id ? resultsById.get(id) : null;
    if (
      !id ||
      !name ||
      !nativeTool ||
      !result ||
      duplicateIds.has(id) ||
      result.serverId !== nativeTool.target.serverId ||
      result.toolName !== nativeTool.target.toolName
    ) {
      throw new Error(GEMINI_INVALID_GROUNDED_TOOL_CONTINUATION_MESSAGE);
    }

    const succeeded = result.status === "complete";
    return {
      functionResponse: {
        name,
        id,
        response: succeeded
          ? { result: result.output || "(empty)" }
          : { error: result.error || "Tool execution failed." }
      }
    };
  });
}

function nativeToolDeclarationsMatch(requestedNativeTools, retainedNativeTools) {
  if (requestedNativeTools.length === 0) {
    return true;
  }
  return JSON.stringify(requestedNativeTools) === JSON.stringify(retainedNativeTools);
}

function shouldOmitNativeToolsForGoogleSearch(enableGoogleSearch, nativeTools = [], groundedCustomToolsRequested = false) {
  return enableGoogleSearch === true &&
    groundedCustomToolsRequested !== true &&
    Array.isArray(nativeTools) &&
    nativeTools.length > 0;
}

function supportsGenerateContent(model) {
  const methods = model?.supportedGenerationMethods;
  return !Array.isArray(methods) || methods.includes("generateContent");
}

function getGeminiModelId(model) {
  if (typeof model?.baseModelId === "string" && model.baseModelId.trim()) {
    return model.baseModelId.trim();
  }

  if (typeof model?.name === "string" && model.name.trim()) {
    return model.name.trim().replace(/^models\//, "");
  }

  return "";
}

function normalizeModelPath(model) {
  const modelId = String(model ?? "").trim();
  if (!modelId) {
    throw new Error("Select a Gemini model before sending a message.");
  }

  if (modelId.startsWith("models/") || modelId.startsWith("tunedModels/")) {
    return modelId;
  }

  return `models/${modelId}`;
}

function createGeminiParts(content) {
  if (typeof content === "string") {
    return content ? [{ text: content }] : [];
  }

  if (!Array.isArray(content)) {
    return [];
  }

  return content
    .map((part) => {
      if (part?.type === "text" && typeof part.text === "string") {
        return { text: part.text };
      }

      if (part?.type === "image_url" && typeof part?.image_url?.url === "string") {
        return createInlineImagePart(part.image_url.url);
      }

      return null;
    })
    .filter(Boolean);
}

function createInlineImagePart(dataUrl) {
  const match = dataUrl.match(/^data:([^;,]+);base64,(.+)$/);
  if (!match) {
    return null;
  }

  return {
    inlineData: {
      mimeType: match[1],
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
    .map((part) => part?.type === "text" && typeof part.text === "string" ? part.text : "")
    .filter(Boolean)
    .join("\n");
}

function normalizeGenerationConfig(config) {
  const normalized = {};

  if (typeof config?.temperature === "number" && Number.isFinite(config.temperature)) {
    normalized.temperature = config.temperature;
  }

  if (typeof config?.topP === "number" && Number.isFinite(config.topP)) {
    normalized.topP = config.topP;
  }

  if (Number.isInteger(config?.topK) && config.topK > 0) {
    normalized.topK = config.topK;
  }

  if (Number.isInteger(config?.maxOutputTokens) && config.maxOutputTokens > 0) {
    normalized.maxOutputTokens = config.maxOutputTokens;
  }

  const thinkingConfig = normalizeThinkingConfig(config?.thinkingConfig);
  if (Object.keys(thinkingConfig).length > 0) {
    normalized.thinkingConfig = thinkingConfig;
  }

  return normalized;
}

function normalizeThinkingConfig(config) {
  const normalized = {};

  if (Number.isInteger(config?.thinkingBudget) && config.thinkingBudget >= 0) {
    normalized.thinkingBudget = config.thinkingBudget;
  }

  if (typeof config?.thinkingLevel === "string" && config.thinkingLevel.trim()) {
    normalized.thinkingLevel = config.thinkingLevel.trim();
  }

  if (typeof config?.includeThoughts === "boolean") {
    normalized.includeThoughts = config.includeThoughts;
  }

  return normalized;
}

function normalizeGeminiFunctionCalls(parts, nativeTools = [], options = {}) {
  const nativeToolMap = createNativeToolMap(nativeTools);
  if (nativeToolMap.size === 0) {
    return [];
  }

  return parts
    .map((part) => part?.functionCall)
    .filter((functionCall) => functionCall && typeof functionCall.name === "string")
    .map((functionCall) => {
      const nativeName = functionCall.name.trim();
      const target = nativeToolMap.get(nativeName);
      if (!target) {
        return null;
      }

      return {
        serverId: target.serverId,
        toolName: target.toolName,
        arguments: functionCall.args && typeof functionCall.args === "object" && !Array.isArray(functionCall.args)
          ? JSON.parse(JSON.stringify(functionCall.args))
          : {},
        reason: "Provider returned a native Gemini function call.",
        exactToolName: true,
        ...(options.requireProviderCallId === true ? { providerCallId: functionCall.id } : {})
      };
    })
    .filter((toolCall) => toolCall && toolCall.toolName);
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
        description: typeof tool.description === "string" ? tool.description.trim() : "",
        parameters: normalizeGeminiToolParameters(tool.parameters ?? tool.inputSchema),
        inputSchema: normalizeLocalToolSchema(tool.inputSchema ?? tool.parameters),
        target: {
          serverId: typeof tool.target.serverId === "string" ? tool.target.serverId.trim() : "",
          toolName: targetToolName
        }
      };
    })
    .filter(Boolean);
}

function createGeminiFunctionDeclaration(tool) {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters
  };
}

function createNativeToolMap(nativeTools) {
  const map = new Map();
  const exactToolNameCounts = new Map();

  for (const tool of nativeTools) {
    const exactToolName = tool?.target?.toolName;
    if (!exactToolName) {
      continue;
    }

    exactToolNameCounts.set(exactToolName, (exactToolNameCounts.get(exactToolName) ?? 0) + 1);
  }

  for (const tool of nativeTools) {
    map.set(tool.name, tool.target);
  }

  for (const tool of nativeTools) {
    const exactToolName = tool?.target?.toolName;
    if (exactToolName && exactToolNameCounts.get(exactToolName) === 1 && !map.has(exactToolName)) {
      map.set(exactToolName, tool.target);
    }
  }

  return map;
}

function createGeminiUnmappedToolCallSummary(parts, nativeTools = []) {
  if (!Array.isArray(parts) || parts.length === 0 || !Array.isArray(nativeTools) || nativeTools.length === 0) {
    return null;
  }

  const nativeToolMap = createNativeToolMap(nativeTools);
  if (nativeToolMap.size === 0) {
    return null;
  }

  const rawToolNames = parts
    .map((part) => part?.functionCall)
    .filter((functionCall) => functionCall && typeof functionCall.name === "string")
    .map((functionCall) => functionCall.name.trim())
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

function normalizeGeminiToolParameters(parameters) {
  const schema = parameters && typeof parameters === "object" && !Array.isArray(parameters)
    ? JSON.parse(JSON.stringify(parameters))
    : {
        type: "object",
        properties: {},
        additionalProperties: false
      };

  return normalizeGeminiSchemaTypes(schema);
}

function normalizeLocalToolSchema(parameters) {
  return isPlainObject(parameters)
    ? cloneJson(parameters)
    : {
        type: "object",
        properties: {},
        additionalProperties: false
      };
}

function normalizeGeminiSchemaTypes(value) {
  if (!value || typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(normalizeGeminiSchemaTypes);
  }

  const normalized = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "$schema" || key === "additionalProperties") {
      continue;
    }

    normalized[key] = key === "type" && typeof entry === "string"
      ? entry.toUpperCase()
      : normalizeGeminiSchemaTypes(entry);
  }

  return normalized;
}

function validateGeminiGroundedToolResponse(candidate, nativeTools, priorContents, options = {}) {
  const finishReason = typeof candidate?.finishReason === "string" ? candidate.finishReason : "";
  if (GEMINI_MALFORMED_TOOL_FINISH_REASONS.has(finishReason)) {
    return "provider-finish-reason";
  }
  if (candidate?.content?.role !== "model" || !Array.isArray(candidate?.content?.parts)) {
    return "invalid-model-content";
  }

  const priorCallIds = collectGeminiInitiatedToolIds(priorContents);
  if (!priorCallIds) {
    return "invalid-prior-call-identifiers";
  }
  const currentCallIds = new Set();
  const nativeByName = new Map(nativeTools.map((tool) => [tool.name, tool]));
  const serverCalls = new Map();
  const serverResponses = new Map();
  let functionCallCount = 0;

  for (const part of candidate.content.parts) {
    if (!isPlainObject(part)) {
      return "invalid-part";
    }
    const payloadFieldCount = [
      "text",
      "inlineData",
      "functionCall",
      "functionResponse",
      "fileData",
      "executableCode",
      "codeExecutionResult",
      "toolCall",
      "toolResponse"
    ].filter((key) => Object.prototype.hasOwnProperty.call(part, key)).length;
    if (payloadFieldCount > 1 || part.functionResponse !== undefined) {
      return "ambiguous-part-payload";
    }
    if (
      Object.prototype.hasOwnProperty.call(part, "thoughtSignature") &&
      !readExactNonEmptyString(part.thoughtSignature)
    ) {
      return "invalid-thought-signature";
    }

    if (part.functionCall !== undefined) {
      functionCallCount += 1;
      const functionCall = part.functionCall;
      const id = readExactNonEmptyString(functionCall?.id);
      const name = readExactNonEmptyString(functionCall?.name);
      const nativeTool = name ? nativeByName.get(name) : null;
      if (
        options.suppressNativeToolCalls === true ||
        !isPlainObject(functionCall) ||
        !id ||
        !name ||
        !nativeTool ||
        !isPlainObject(functionCall.args) ||
        priorCallIds.has(id) ||
        currentCallIds.has(id)
      ) {
        return "invalid-function-call";
      }
      if (functionCallCount === 1 && !readExactNonEmptyString(part.thoughtSignature)) {
        return "missing-function-thought-signature";
      }
      currentCallIds.add(id);
    }

    if (part.toolCall !== undefined) {
      const toolCall = part.toolCall;
      const id = readExactNonEmptyString(toolCall?.id);
      const toolType = readExactNonEmptyString(toolCall?.toolType);
      if (
        !isPlainObject(toolCall) ||
        !id ||
        !toolType ||
        !isPlainObject(toolCall.args) ||
        !readExactNonEmptyString(part.thoughtSignature) ||
        priorCallIds.has(id) ||
        currentCallIds.has(id) ||
        serverCalls.has(id)
      ) {
        return "invalid-server-tool-call";
      }
      currentCallIds.add(id);
      serverCalls.set(id, toolType);
    }

    if (part.toolResponse !== undefined) {
      const toolResponse = part.toolResponse;
      const id = readExactNonEmptyString(toolResponse?.id);
      const toolType = readExactNonEmptyString(toolResponse?.toolType);
      if (
        !isPlainObject(toolResponse) ||
        !id ||
        !toolType ||
        !isPlainObject(toolResponse.response) ||
        !readExactNonEmptyString(part.thoughtSignature) ||
        serverResponses.has(id)
      ) {
        return "invalid-server-tool-response";
      }
      serverResponses.set(id, toolType);
    }
  }

  if (serverCalls.size !== serverResponses.size) {
    return "unpaired-server-tool-parts";
  }
  for (const [id, toolType] of serverCalls) {
    if (serverResponses.get(id) !== toolType) {
      return "mismatched-server-tool-parts";
    }
  }
  for (const id of serverResponses.keys()) {
    if (!serverCalls.has(id)) {
      return "unpaired-server-tool-parts";
    }
  }

  return "";
}

function validateGeminiGroundedToolHistory(context, nativeTools) {
  const priorContents = [];
  for (let index = 0; index < context.contents.length; index += 1) {
    const content = context.contents[index];
    if (content.role !== "user" && content.role !== "model") {
      return "invalid-content-role";
    }
    if (content.role === "model") {
      const responseReason = validateGeminiGroundedToolResponse(
        { content },
        nativeTools,
        priorContents
      );
      if (responseReason) {
        return responseReason;
      }

      const functionCalls = content.parts
        .map((part) => part?.functionCall)
        .filter((functionCall) => isPlainObject(functionCall));
      const nextContent = context.contents[index + 1];
      if (nextContent) {
        const responseParts = Array.isArray(nextContent.parts)
          ? nextContent.parts.filter((part) => part?.functionResponse !== undefined)
          : [];
        if (functionCalls.length > 0) {
          if (nextContent.role !== "user" || !functionResponsesMatchCalls(functionCalls, responseParts)) {
            return "invalid-function-response-history";
          }
        } else if (responseParts.length > 0) {
          return "unexpected-function-response-history";
        }
      }
    }
    priorContents.push(content);
  }
  return "";
}

function functionResponsesMatchCalls(functionCalls, responseParts) {
  if (functionCalls.length !== responseParts.length) {
    return false;
  }
  const callsById = new Map(functionCalls.map((call) => [call.id, call]));
  const seen = new Set();
  for (const part of responseParts) {
    const response = part?.functionResponse;
    const id = readExactNonEmptyString(response?.id);
    const name = readExactNonEmptyString(response?.name);
    const call = id ? callsById.get(id) : null;
    if (!id || !name || !call || call.name !== name || !isPlainObject(response.response) || seen.has(id)) {
      return false;
    }
    seen.add(id);
  }
  return seen.size === functionCalls.length;
}

function collectGeminiInitiatedToolIds(contents) {
  const ids = new Set();
  for (const content of Array.isArray(contents) ? contents : []) {
    for (const part of Array.isArray(content?.parts) ? content.parts : []) {
      const initiated = part?.functionCall ?? part?.toolCall;
      if (!initiated) {
        continue;
      }
      const id = readExactNonEmptyString(initiated.id);
      if (!id || ids.has(id)) {
        return null;
      }
      ids.add(id);
    }
  }
  return ids;
}

function isSupportedLocalJsonSchema(schema, budget = { steps: 0 }, depth = 0) {
  budget.steps += 1;
  if (budget.steps > 4000 || depth > 64) {
    return false;
  }
  if (typeof schema === "boolean") {
    return true;
  }
  if (!isPlainObject(schema)) {
    return false;
  }
  if (Object.keys(schema).some((key) => !SUPPORTED_LOCAL_SCHEMA_KEYS.has(key))) {
    return false;
  }
  if (schema.$ref !== undefined && (
    typeof schema.$ref !== "string" ||
    (schema.$ref !== "#" && !schema.$ref.startsWith("#/"))
  )) {
    return false;
  }

  const types = schema.type === undefined
    ? []
    : (Array.isArray(schema.type) ? schema.type : [schema.type]);
  const supportedTypes = new Set(["array", "boolean", "integer", "null", "number", "object", "string"]);
  if (
    (Array.isArray(schema.type) && types.length === 0) ||
    types.some((type) => typeof type !== "string" || !supportedTypes.has(type.toLowerCase()))
  ) {
    return false;
  }
  if (schema.required !== undefined && (
    !Array.isArray(schema.required) ||
    schema.required.some((key) => typeof key !== "string")
  )) {
    return false;
  }
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length === 0)) {
    return false;
  }
  if (schema.pattern !== undefined) {
    if (typeof schema.pattern !== "string") {
      return false;
    }
    try {
      new RegExp(schema.pattern);
    } catch {
      return false;
    }
  }

  for (const key of [
    "minItems",
    "maxItems",
    "minLength",
    "maxLength",
    "minProperties",
    "maxProperties"
  ]) {
    if (schema[key] !== undefined && (!Number.isInteger(schema[key]) || schema[key] < 0)) {
      return false;
    }
  }
  for (const key of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"]) {
    if (schema[key] !== undefined && (typeof schema[key] !== "number" || !Number.isFinite(schema[key]))) {
      return false;
    }
  }
  if (schema.multipleOf !== undefined && schema.multipleOf <= 0) {
    return false;
  }
  if (schema.uniqueItems !== undefined && typeof schema.uniqueItems !== "boolean") {
    return false;
  }

  for (const key of ["properties", "patternProperties", "$defs", "definitions"]) {
    if (schema[key] === undefined) {
      continue;
    }
    if (!isPlainObject(schema[key])) {
      return false;
    }
    if (key === "patternProperties") {
      try {
        Object.keys(schema[key]).forEach((pattern) => new RegExp(pattern));
      } catch {
        return false;
      }
    }
    for (const child of Object.values(schema[key])) {
      if (!isSupportedLocalJsonSchema(child, budget, depth + 1)) {
        return false;
      }
    }
  }
  for (const key of ["allOf", "anyOf", "oneOf", "prefixItems"]) {
    if (schema[key] === undefined) {
      continue;
    }
    if (!Array.isArray(schema[key]) || schema[key].length === 0) {
      return false;
    }
    for (const child of schema[key]) {
      if (!isSupportedLocalJsonSchema(child, budget, depth + 1)) {
        return false;
      }
    }
  }
  for (const key of ["additionalProperties", "items", "not"]) {
    if (schema[key] !== undefined && !isSupportedLocalJsonSchema(schema[key], budget, depth + 1)) {
      return false;
    }
  }
  return true;
}

function validateLocalJsonSchema(value, schema, rootSchema = schema, budget = { steps: 0 }, depth = 0) {
  budget.steps += 1;
  if (budget.steps > 10000 || depth > 64) {
    return false;
  }
  if (schema === true || schema === undefined) {
    return true;
  }
  if (schema === false || !isPlainObject(schema)) {
    return false;
  }

  if (typeof schema.$ref === "string") {
    const referenced = resolveLocalSchemaReference(rootSchema, schema.$ref);
    if (referenced === null || !validateLocalJsonSchema(value, referenced, rootSchema, budget, depth + 1)) {
      return false;
    }
  }
  if (Array.isArray(schema.allOf) && !schema.allOf.every((entry) => validateLocalJsonSchema(value, entry, rootSchema, budget, depth + 1))) {
    return false;
  }
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some((entry) => validateLocalJsonSchema(value, entry, rootSchema, budget, depth + 1))) {
    return false;
  }
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter((entry) => validateLocalJsonSchema(value, entry, rootSchema, budget, depth + 1)).length;
    if (matches !== 1) {
      return false;
    }
  }
  if (schema.not !== undefined && validateLocalJsonSchema(value, schema.not, rootSchema, budget, depth + 1)) {
    return false;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => jsonValuesEqual(value, entry))) {
    return false;
  }
  if (Object.prototype.hasOwnProperty.call(schema, "const") && !jsonValuesEqual(value, schema.const)) {
    return false;
  }

  const allowedTypes = normalizeJsonSchemaTypes(schema.type);
  if (allowedTypes.length > 0 && !allowedTypes.some((type) => jsonValueMatchesType(value, type))) {
    return false;
  }

  if (isPlainObject(value)) {
    const required = Array.isArray(schema.required) ? schema.required : [];
    if (required.some((key) => typeof key !== "string" || !Object.prototype.hasOwnProperty.call(value, key))) {
      return false;
    }
    const properties = isPlainObject(schema.properties) ? schema.properties : {};
    const patternProperties = isPlainObject(schema.patternProperties) ? schema.patternProperties : {};
    for (const [key, child] of Object.entries(value)) {
      const candidates = [];
      if (Object.prototype.hasOwnProperty.call(properties, key)) {
        candidates.push(properties[key]);
      }
      for (const [pattern, childSchema] of Object.entries(patternProperties)) {
        try {
          if (new RegExp(pattern).test(key)) {
            candidates.push(childSchema);
          }
        } catch {
          return false;
        }
      }
      if (candidates.length === 0) {
        if (schema.additionalProperties === false) {
          return false;
        }
        if (isPlainObject(schema.additionalProperties) || typeof schema.additionalProperties === "boolean") {
          candidates.push(schema.additionalProperties);
        }
      }
      if (!candidates.every((childSchema) => validateLocalJsonSchema(child, childSchema, rootSchema, budget, depth + 1))) {
        return false;
      }
    }
    const keyCount = Object.keys(value).length;
    if (Number.isInteger(schema.minProperties) && keyCount < schema.minProperties) return false;
    if (Number.isInteger(schema.maxProperties) && keyCount > schema.maxProperties) return false;
  }

  if (Array.isArray(value)) {
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) return false;
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) return false;
    if (schema.uniqueItems === true && new Set(value.map((entry) => JSON.stringify(entry))).size !== value.length) return false;
    if (Array.isArray(schema.prefixItems)) {
      for (let index = 0; index < Math.min(value.length, schema.prefixItems.length); index += 1) {
        if (!validateLocalJsonSchema(value[index], schema.prefixItems[index], rootSchema, budget, depth + 1)) return false;
      }
    }
    if (isPlainObject(schema.items) || typeof schema.items === "boolean") {
      const start = Array.isArray(schema.prefixItems) ? schema.prefixItems.length : 0;
      for (let index = start; index < value.length; index += 1) {
        if (!validateLocalJsonSchema(value[index], schema.items, rootSchema, budget, depth + 1)) return false;
      }
    }
  }

  if (typeof value === "string") {
    if (Number.isInteger(schema.minLength) && value.length < schema.minLength) return false;
    if (Number.isInteger(schema.maxLength) && value.length > schema.maxLength) return false;
    if (typeof schema.pattern === "string") {
      try {
        if (!new RegExp(schema.pattern).test(value)) return false;
      } catch {
        return false;
      }
    }
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    if (typeof schema.minimum === "number" && value < schema.minimum) return false;
    if (typeof schema.maximum === "number" && value > schema.maximum) return false;
    if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) return false;
    if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) return false;
    if (typeof schema.multipleOf === "number" && schema.multipleOf > 0) {
      const quotient = value / schema.multipleOf;
      if (Math.abs(quotient - Math.round(quotient)) > Number.EPSILON * 16) return false;
    }
  }

  return true;
}

function resolveLocalSchemaReference(rootSchema, reference) {
  if (reference === "#") {
    return rootSchema;
  }
  if (!reference.startsWith("#/")) {
    return null;
  }
  let current = rootSchema;
  for (const rawSegment of reference.slice(2).split("/")) {
    const segment = rawSegment.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!isPlainObject(current) && !Array.isArray(current)) {
      return null;
    }
    current = current[segment];
  }
  return current === undefined ? null : current;
}

function normalizeJsonSchemaTypes(type) {
  const values = Array.isArray(type) ? type : (typeof type === "string" ? [type] : []);
  return values.map((value) => typeof value === "string" ? value.toLowerCase() : "").filter(Boolean);
}

function jsonValueMatchesType(value, type) {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return isPlainObject(value);
  if (type === "string") return typeof value === "string";
  if (type === "boolean") return typeof value === "boolean";
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return false;
}

function jsonValuesEqual(left, right) {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function readExactNonEmptyString(value) {
  if (typeof value !== "string") {
    return "";
  }
  const trimmed = value.trim();
  return trimmed && trimmed === value ? value : "";
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function estimateJsonCharacters(value) {
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
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

function createGeminiGroundingConfigurationSummary(
  requestBody,
  requestedNativeTools,
  effectiveNativeTools,
  omittedNativeTools,
  groundedCustomToolsActive,
  suppressNativeToolCalls
) {
  const tools = Array.isArray(requestBody?.tools) ? requestBody.tools : [];
  return {
    contentCount: Array.isArray(requestBody?.contents) ? requestBody.contents.length : 0,
    hasSystemInstruction: Boolean(requestBody?.systemInstruction),
    hasGenerationConfig: Boolean(requestBody?.generationConfig),
    requestedNativeToolCount: requestedNativeTools.length,
    effectiveNativeToolCount: effectiveNativeTools.length,
    omittedNativeTools: omittedNativeTools === true,
    hasGoogleSearch: tools.some((tool) => Boolean(tool?.google_search) || Boolean(tool?.googleSearch)),
    hasFunctionDeclarations: tools.some((tool) => Array.isArray(tool?.functionDeclarations)),
    groundedCustomToolsActive: groundedCustomToolsActive === true,
    includeServerSideToolInvocations: requestBody?.toolConfig?.includeServerSideToolInvocations === true,
    functionCallingMode: typeof requestBody?.toolConfig?.functionCallingConfig?.mode === "string"
      ? requestBody.toolConfig.functionCallingConfig.mode
      : "",
    suppressNativeToolCalls: suppressNativeToolCalls === true
  };
}

function createGeminiResponseSummary(response, jsonRead, options = {}) {
  const data = jsonRead.hasJson ? jsonRead.value : {};
  const firstCandidate = Array.isArray(data?.candidates) ? data.candidates[0] : null;
  const parts = Array.isArray(firstCandidate?.content?.parts) ? firstCandidate.content.parts : [];

  return {
    status: Number.isInteger(response?.status) ? response.status : null,
    hasJson: jsonRead.hasJson,
    jsonError: jsonRead.error,
    candidateCount: Array.isArray(data?.candidates) ? data.candidates.length : 0,
    finishReason: createSafeGeminiFinishReason(firstCandidate?.finishReason),
    partTypes: parts.map(createGeminiPartTypeSummary).filter(Boolean),
    contentLength: parts
      .filter((part) => part?.thought !== true)
      .map((part) => typeof part?.text === "string" ? part.text.length : 0)
      .reduce((sum, length) => sum + length, 0),
    thoughtPartCount: parts.filter((part) => part?.thought === true).length,
    nativeToolCallCount: countGeminiFunctionCalls(parts),
    usage: createGeminiUsageSummary(data),
    providerError: options.includeProviderErrorDetails === false
      ? createProviderErrorMetadataSummary(data)
      : createProviderErrorSummary(data),
    headers: createSafeResponseHeaderSummary(response)
  };
}

function createGeminiPartTypeSummary(part) {
  if (!isPlainObject(part)) {
    return "invalid";
  }
  const types = [];
  for (const key of [
    "text",
    "inlineData",
    "functionCall",
    "functionResponse",
    "toolCall",
    "toolResponse",
    "executableCode",
    "codeExecutionResult"
  ]) {
    if (Object.prototype.hasOwnProperty.call(part, key)) {
      types.push(key);
    }
  }
  if (Object.prototype.hasOwnProperty.call(part, "thoughtSignature")) {
    types.push("thoughtSignature");
  }
  return types.length > 0 ? types.join("+") : "unknown";
}

function readGeminiUsageFields(data) {
  const usage = data?.usageMetadata && typeof data.usageMetadata === "object" ? data.usageMetadata : null;

  return {
    present: Boolean(usage),
    inputTokens: readFiniteNumber(usage?.promptTokenCount),
    outputTokens: readFiniteNumber(usage?.candidatesTokenCount),
    totalTokens: readFiniteNumber(usage?.totalTokenCount),
    reasoningTokens: readFiniteNumber(usage?.thoughtsTokenCount),
    cachedTokens: readFiniteNumber(usage?.cachedContentTokenCount),
    toolUsePromptTokens: readFiniteNumber(usage?.toolUsePromptTokenCount),
    serviceTier: typeof usage?.serviceTier === "string" ? usage.serviceTier : ""
  };
}

function createGeminiUsageSummary(data) {
  const usage = readGeminiUsageFields(data);
  return {
    present: usage.present,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    reasoningTokens: usage.reasoningTokens,
    cachedTokens: usage.cachedTokens,
    cachedTokensPresent: Number.isFinite(usage.cachedTokens),
    toolUsePromptTokens: usage.toolUsePromptTokens
  };
}

function createGeminiResponseMetadata(data, firstCandidate) {
  const usage = readGeminiUsageFields(data);
  if (!usage.present) {
    return null;
  }

  return {
    usage: {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      reasoningTokens: usage.reasoningTokens,
      cachedTokens: usage.cachedTokens,
      toolUsePromptTokens: usage.toolUsePromptTokens
    },
    serviceTier: usage.serviceTier,
    finishReason: createSafeGeminiFinishReason(firstCandidate?.finishReason)
  };
}

function createSafeGeminiFinishReason(value) {
  if (typeof value !== "string" || !value) {
    return "";
  }
  return SAFE_GEMINI_FINISH_REASONS.has(value) ? value : "UNKNOWN";
}

function readFiniteNumber(value) {
  return Number.isFinite(value) ? value : null;
}

function countGeminiFunctionCalls(parts) {
  return Array.isArray(parts)
    ? parts.filter((part) => part?.functionCall && typeof part.functionCall.name === "string").length
    : 0;
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

function createProviderRequestErrorSummary(error, options = {}) {
  const summary = {
    name: error instanceof Error ? error.name : "",
    status: readErrorStatus(error),
    hasResponse: Boolean(error?.response)
  };

  if (options.includeMessageDetails !== false) {
    summary.message = createSafePreview(error instanceof Error ? error.message : String(error ?? "Unknown request error."));
    summary.responseTextPreview = createSafePreview(readErrorResponseText(error));
  }

  return summary;
}

function createProviderHttpErrorSummary(response, jsonRead, options = {}) {
  const data = jsonRead.hasJson ? jsonRead.value : null;
  return {
    status: Number.isInteger(response?.status) ? response.status : null,
    hasJson: jsonRead.hasJson,
    jsonError: jsonRead.error,
    providerError: options.includeProviderErrorDetails === false
      ? createProviderErrorMetadataSummary(data)
      : createProviderErrorSummary(data),
    headers: createSafeResponseHeaderSummary(response),
    responseTextPreview: options.includeProviderErrorDetails === false
      ? ""
      : createSafePreview(readResponseText(response))
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

function createGeminiGroundedCustomToolsHttpErrorMessage(response) {
  const status = Number.isInteger(response?.status) ? response.status : "unknown";
  return `Gemini grounded custom tools request failed with status ${status}. Disable Custom tools or choose a supported Gemini model and try again.`;
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

function createProviderErrorMetadataSummary(data) {
  const summary = createProviderErrorSummary(data);
  if (!summary) {
    return null;
  }

  return {
    type: summary.type,
    code: summary.code,
    param: summary.param,
    status: summary.status
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

function readSafeRequestId(response) {
  const headers = createSafeResponseHeaderSummary(response);
  return headers["x-goog-request-id"] || headers["x-request-id"] || headers["request-id"] || headers["openai-request-id"] || "";
}

function isRetryableGeminiGroundingStatus(status) {
  return Number.isInteger(status) && status >= 500 && status <= 599;
}

function isAbortError(error, signal) {
  return signal?.aborted === true || error?.name === "AbortError";
}

function createAbortError() {
  const error = new Error("The request was cancelled.");
  error.name = "AbortError";
  return error;
}

function waitForRetry(delayMs, signal) {
  return new Promise((resolve, reject) => {
    let timeoutId = null;
    const handleAbort = () => {
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
      }
      signal?.removeEventListener?.("abort", handleAbort);
      reject(createAbortError());
    };

    timeoutId = setTimeout(() => {
      signal?.removeEventListener?.("abort", handleAbort);
      resolve();
    }, delayMs);

    if (signal?.addEventListener) {
      signal.addEventListener("abort", handleAbort, { once: true });
      if (signal.aborted === true) {
        handleAbort();
      }
    }
  });
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
  GeminiClient
};
