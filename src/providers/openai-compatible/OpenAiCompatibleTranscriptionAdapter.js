const { requestUrl } = require("obsidian");
const { AUDIO_ATTACHMENT_EXTENSIONS } = require("../../attachments/AudioInspector");
const {
  AudioTranscriptionError,
  raceWithAbort
} = require("../../attachments/AudioTranscriptionService");

class OpenAiCompatibleTranscriptionAdapter {
  constructor(baseUrl, apiKeyResolver = "", options = {}) {
    this.baseUrl = validateBaseUrl(baseUrl);
    this.apiKeyResolver = typeof apiKeyResolver === "function"
      ? apiKeyResolver
      : () => apiKeyResolver;
    this.authenticationRequired = options.authenticationRequired === true;
    this.request = typeof options.request === "function" ? options.request : requestUrl;
  }

  supportsFormat(inspection) {
    return AUDIO_ATTACHMENT_EXTENSIONS.has(String(inspection?.extension || "").toLowerCase());
  }

  async transcribe(request) {
    throwIfAborted(request.signal);
    const model = String(request.model || "").trim();
    if (!model) {
      throw new AudioTranscriptionError(
        "transcription-model-missing",
        "Select a transcription model before transcribing audio."
      );
    }
    const apiKey = String((await Promise.resolve(this.apiKeyResolver())) || "").trim();
    if (this.authenticationRequired && !apiKey) {
      throw new AudioTranscriptionError(
        "transcription-secret-missing",
        "The transcription provider secret is unavailable."
      );
    }
    throwIfAborted(request.signal);

    const multipart = createMultipartTranscriptionBody({
      audio: request.audio,
      fileName: request.fileName,
      mimeType: request.mimeType,
      model
    });
    const pending = Promise.resolve().then(() => {
      throwIfAborted(request.signal);
      request.beforeUpload?.();
      return this.request({
        url: `${this.baseUrl}/audio/transcriptions`,
        method: "POST",
        contentType: multipart.contentType,
        headers: createTranscriptionHeaders(apiKey),
        body: multipart.body,
        throw: false
      });
    });
    const response = await raceWithAbort(pending, request.signal);
    throwIfAborted(request.signal);

    if (!response || !Number.isFinite(response.status)) {
      throw new AudioTranscriptionError(
        "transcription-response-invalid",
        "The transcription provider returned an unexpected response."
      );
    }
    if (response.status < 200 || response.status >= 300) {
      throw createHttpError(response.status);
    }

    const data = readJsonResponse(response);
    if (!data || typeof data.text !== "string") {
      throw new AudioTranscriptionError(
        "transcription-response-invalid",
        "The transcription provider returned an unexpected response."
      );
    }

    return {
      text: data.text,
      usage: normalizeOpenAiTranscriptionUsage(data.usage)
    };
  }
}

function createTranscriptionHeaders(apiKey) {
  const headers = { Accept: "application/json" };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

function createMultipartTranscriptionBody(input) {
  const boundary = `codriver-${createBoundaryToken()}`;
  const encoder = new TextEncoder();
  const audio = toUint8Array(input.audio);
  const safeFileName = sanitizeMultipartFileName(input.fileName);
  const mimeType = sanitizeMimeType(input.mimeType);
  const parts = [
    encoder.encode(
      `--${boundary}\r\n` +
      "Content-Disposition: form-data; name=\"model\"\r\n\r\n" +
      `${String(input.model)}\r\n`
    ),
    encoder.encode(
      `--${boundary}\r\n` +
      "Content-Disposition: form-data; name=\"response_format\"\r\n\r\n" +
      "json\r\n"
    ),
    encoder.encode(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name=\"file\"; filename=\"${safeFileName}\"\r\n` +
      `Content-Type: ${mimeType}\r\n\r\n`
    ),
    audio,
    encoder.encode(`\r\n--${boundary}--\r\n`)
  ];

  const byteLength = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const body = new Uint8Array(byteLength);
  let offset = 0;
  for (const part of parts) {
    body.set(part, offset);
    offset += part.byteLength;
  }

  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    body: body.buffer
  };
}

function normalizeOpenAiTranscriptionUsage(usage) {
  if (!usage || typeof usage !== "object") {
    return { type: "unknown", incomplete: true };
  }
  if (usage.type === "tokens" || Number.isFinite(usage.total_tokens)) {
    const details = usage.input_token_details && typeof usage.input_token_details === "object"
      ? usage.input_token_details
      : {};
    return {
      type: "tokens",
      inputTokens: readFiniteNumber(usage.input_tokens),
      audioInputTokens: readFiniteNumber(details.audio_tokens),
      textInputTokens: readFiniteNumber(details.text_tokens),
      outputTokens: readFiniteNumber(usage.output_tokens),
      totalTokens: readFiniteNumber(usage.total_tokens)
    };
  }
  if (usage.type === "duration" || Number.isFinite(usage.seconds)) {
    return {
      type: "duration",
      seconds: readFiniteNumber(usage.seconds)
    };
  }
  return { type: "unknown", incomplete: true };
}

function validateBaseUrl(value) {
  const raw = String(value || "").trim().replace(/\/$/, "");
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new AudioTranscriptionError(
      "transcription-endpoint-invalid",
      "The transcription provider endpoint is invalid."
    );
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new AudioTranscriptionError(
      "transcription-endpoint-invalid",
      "The transcription provider endpoint must use HTTP or HTTPS."
    );
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new AudioTranscriptionError(
      "transcription-endpoint-unsafe",
      "The transcription provider endpoint cannot contain credentials, query parameters, or fragments."
    );
  }
  return raw;
}

function readJsonResponse(response) {
  if (response.json && typeof response.json === "object") {
    return response.json;
  }
  if (typeof response.text !== "string" || !response.text.trim()) {
    return null;
  }
  try {
    return JSON.parse(response.text);
  } catch {
    return null;
  }
}

function createHttpError(status) {
  if (status === 401 || status === 403) {
    return new AudioTranscriptionError(
      "transcription-authentication-failed",
      "The transcription provider rejected its credentials."
    );
  }
  if (status === 429) {
    return new AudioTranscriptionError(
      "transcription-rate-limited",
      "The transcription provider rate limit was reached."
    );
  }
  if (status >= 500) {
    return new AudioTranscriptionError(
      "transcription-provider-unavailable",
      "The transcription provider is temporarily unavailable."
    );
  }
  if (status >= 400) {
    return new AudioTranscriptionError(
      "transcription-provider-rejected",
      "The transcription provider rejected the audio request."
    );
  }
  return new AudioTranscriptionError(
    "transcription-response-invalid",
    "The transcription provider returned an unexpected response."
  );
}

function sanitizeMultipartFileName(value) {
  const normalized = String(value || "audio")
    .replace(/[\r\n\u0000]/g, "")
    .replace(/["\\/]/g, "_")
    .trim();
  return normalized || "audio";
}

function sanitizeMimeType(value) {
  const normalized = String(value || "application/octet-stream").trim().toLowerCase();
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(normalized)
    ? normalized
    : "application/octet-stream";
}

function createBoundaryToken() {
  if (globalThis.crypto?.getRandomValues) {
    const values = new Uint32Array(4);
    globalThis.crypto.getRandomValues(values);
    return Array.from(values, (value) => value.toString(16).padStart(8, "0")).join("");
  }
  return `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
}

function toUint8Array(value) {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new AudioTranscriptionError("unreadable-file", "The audio file could not be read.");
}

function readFiniteNumber(value) {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function throwIfAborted(signal) {
  if (!signal?.aborted) {
    return;
  }
  if (signal.reason instanceof Error) {
    throw signal.reason;
  }
  const error = new Error("Transcription cancelled.");
  error.name = "AbortError";
  throw error;
}

module.exports = {
  OpenAiCompatibleTranscriptionAdapter,
  createMultipartTranscriptionBody,
  normalizeOpenAiTranscriptionUsage,
  sanitizeMultipartFileName,
  validateBaseUrl
};
