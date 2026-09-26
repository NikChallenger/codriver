const { DEFAULT_GEMINI_API_VERSION, DEFAULT_GEMINI_BASE_ENDPOINT, GEMINI_PROVIDER_TYPE } = require("../../constants");
const { GeminiClient } = require("./GeminiClient");

class GeminiProvider {
  constructor(settings, options = {}) {
    this.id = settings.id;
    this.name = settings.name;
    this.type = GEMINI_PROVIDER_TYPE;
    this.toolMode = settings.enableGoogleSearch === true ? "google-search" : "custom-tools";
    this.supportsStreaming = true;
    this.defaultModel = settings.model;
    this.models = Array.isArray(settings.models) ? settings.models : [];
    this.hiddenModels = Array.isArray(settings.hiddenModels) ? settings.hiddenModels : [];
    this.apiKeySecretName = settings.apiKeySecretName;
    this.secretStorage = options.secretStorage;
    this.diagnostics = options.diagnostics ?? null;
    this.continuationBinding = JSON.stringify({
      id: this.id,
      endpoint: settings.endpoint || DEFAULT_GEMINI_BASE_ENDPOINT,
      apiVersion: settings.apiVersion || DEFAULT_GEMINI_API_VERSION,
      apiKeySecretName: this.apiKeySecretName,
      temperature: settings.temperature,
      topP: settings.topP,
      topK: settings.topK,
      maxOutputTokens: settings.maxOutputTokens,
      thinkingBudget: settings.thinkingBudget,
      thinkingLevel: settings.thinkingLevel,
      enableGoogleSearch: settings.enableGoogleSearch === true,
      enableGroundedCustomTools: settings.enableGroundedCustomTools === true
    });
    this.client = new GeminiClient(
      settings.endpoint || DEFAULT_GEMINI_BASE_ENDPOINT,
      settings.apiVersion || DEFAULT_GEMINI_API_VERSION,
      () => this.resolveApiKey(),
      {
        diagnostics: this.diagnostics,
        generationConfig: {
          temperature: parseOptionalNumber(settings.temperature),
          topP: parseOptionalNumber(settings.topP),
          topK: parseOptionalInteger(settings.topK),
          maxOutputTokens: parseOptionalInteger(settings.maxOutputTokens),
          thinkingConfig: {
            thinkingBudget: parseOptionalNonNegativeInteger(settings.thinkingBudget),
            thinkingLevel: parseOptionalString(settings.thinkingLevel)
          }
        },
        enableGoogleSearch: settings.enableGoogleSearch === true,
        enableGroundedCustomTools: settings.enableGroundedCustomTools === true,
        retryDelay: options.retryDelay,
        retryRandom: options.retryRandom,
        fetch: options.fetch
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
    return this.client.createChatCompletion(request.model, request.messages, request.signal, {
      nativeTools: request.nativeTools,
      enableGoogleSearch: request.purpose !== "skill-routing",
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

function parseOptionalNonNegativeInteger(value) {
  if (value === null || value === undefined || value === "") {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function parseOptionalString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
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
  GeminiProvider
};
