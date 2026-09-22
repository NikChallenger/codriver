const {
  ANTHROPIC_PROVIDER_TYPE,
  DEFAULT_ANTHROPIC_API_VERSION,
  DEFAULT_ANTHROPIC_MAX_OUTPUT_TOKENS
} = require("../../constants");
const { AnthropicClient } = require("./AnthropicClient");

class AnthropicProvider {
  constructor(settings, options = {}) {
    this.id = settings.id;
    this.name = settings.name;
    this.type = ANTHROPIC_PROVIDER_TYPE;
    this.supportsStreaming = true;
    this.defaultModel = settings.model;
    this.models = Array.isArray(settings.models) ? settings.models : [];
    this.hiddenModels = Array.isArray(settings.hiddenModels) ? settings.hiddenModels : [];
    this.apiKeySecretName = settings.apiKeySecretName;
    this.continuationBinding = JSON.stringify({
      id: this.id,
      endpoint: settings.endpoint,
      apiKeySecretName: this.apiKeySecretName,
      maxOutputTokens: settings.maxOutputTokens,
      enablePromptCaching: settings.enablePromptCaching !== false,
      promptCacheTtl: settings.promptCacheTtl === "1h" ? "1h" : "5m"
    });
    this.secretStorage = options.secretStorage;
    this.client = new AnthropicClient(
      settings.endpoint,
      () => this.resolveApiKey(),
      {
        apiVersion: DEFAULT_ANTHROPIC_API_VERSION,
        diagnostics: options.diagnostics ?? null,
        fetch: options.fetch,
        maxOutputTokens: parsePositiveInteger(settings.maxOutputTokens) ?? DEFAULT_ANTHROPIC_MAX_OUTPUT_TOKENS,
        promptCaching: settings.enablePromptCaching !== false,
        promptCacheTtl: settings.promptCacheTtl === "1h" ? "1h" : "5m"
      }
    );
  }

  resolveApiKey() {
    if (!this.apiKeySecretName || !this.secretStorage?.getSecret) {
      return "";
    }

    return this.secretStorage.getSecret(this.apiKeySecretName) ?? "";
  }

  async sendMessage(request) {
    return this.client.createMessage(request.model, request.messages, request.signal, {
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
}

function parsePositiveInteger(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
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
  AnthropicProvider
};
