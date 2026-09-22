const { OPENAI_COMPATIBLE_PROVIDER_TYPE } = require("../../constants");
const { OpenAiCompatibleClient } = require("./OpenAiCompatibleClient");
const { OpenAiCompatibleTranscriptionAdapter } = require("./OpenAiCompatibleTranscriptionAdapter");

class OpenAiCompatibleProvider {
  constructor(settings, options = {}) {
    this.id = settings.id;
    this.name = settings.name;
    this.type = OPENAI_COMPATIBLE_PROVIDER_TYPE;
    this.supportsStreaming = true;
    this.defaultModel = settings.model;
    this.models = Array.isArray(settings.models) ? settings.models : [];
    this.hiddenModels = Array.isArray(settings.hiddenModels) ? settings.hiddenModels : [];
    this.apiKeySecretName = settings.apiKeySecretName;
    this.endpoint = settings.endpoint;
    this.secretStorage = options.secretStorage;
    this.diagnostics = options.diagnostics ?? null;
    this.continuationBinding = JSON.stringify({
      id: this.id,
      endpoint: settings.endpoint,
      apiKeySecretName: this.apiKeySecretName,
      temperature: settings.temperature,
      topP: settings.topP,
      topK: settings.topK,
      reasoningEffort: settings.reasoningEffort
    });
    this.client = new OpenAiCompatibleClient(settings.endpoint, () => this.resolveApiKey(), {
      diagnostics: this.diagnostics,
      fetch: options.fetch,
      requestOptions: {
        temperature: parseOptionalNumber(settings.temperature),
        top_p: parseOptionalNumber(settings.topP),
        top_k: parseOptionalInteger(settings.topK),
        reasoning_effort: resolveReasoningEffort(settings)
      }
    });
  }

  resolveApiKey() {
    if (!this.apiKeySecretName || !this.secretStorage?.getSecret) {
      return "";
    }

    return this.secretStorage.getSecret(this.apiKeySecretName) ?? "";
  }

  async sendMessage(request) {
    return this.client.createChatCompletion(request.model, request.messages, request.signal, {
      nativeTools: request.nativeTools,
      providerContext: request.providerContext,
      continuationMessages: request.continuationMessages,
      toolResults: request.toolResults,
      onProgress: request.onProgress
    });
  }

  getContinuationBinding() {
    const apiKey = this.resolveApiKey();
    const keyFingerprint = typeof apiKey === "string" ? fingerprintSecret(apiKey) : "async-secret";
    return `${this.continuationBinding}:${keyFingerprint}`;
  }

  async testConnection() {
    return this.client.testConnection();
  }

  async listModels() {
    return this.client.listModels();
  }

  createAudioTranscriptionAdapter() {
    return new OpenAiCompatibleTranscriptionAdapter(
      this.endpoint,
      () => this.resolveApiKey(),
      {
        authenticationRequired: Boolean(String(this.apiKeySecretName || "").trim())
      }
    );
  }

}

function parseOptionalNumber(value) {
  if (value === null || value === undefined || value === "") {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseOptionalInteger(value) {
  if (value === null || value === undefined || value === "") {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parseOptionalString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function resolveReasoningEffort(settings) {
  return parseOptionalString(settings?.reasoningEffort);
}

function fingerprintSecret(value) {
  let hash = 2166136261;
  const text = String(value ?? "");
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

module.exports = {
  OpenAiCompatibleProvider
};
