const {
  DEFAULT_MAX_AUDIO_BYTES,
  DEFAULT_MAX_AUDIO_DURATION_MS,
  AudioValidationError,
  inspectAudioBuffer
} = require("./AudioInspector");

const DEFAULT_MAX_AUDIO_FILES = 3;
const DEFAULT_MAX_COMBINED_AUDIO_BYTES = 30 * 1024 * 1024;
const DEFAULT_MAX_COMBINED_AUDIO_DURATION_MS = 60 * 60 * 1000;
const DEFAULT_TRANSCRIPTION_TIMEOUT_MS = 120000;
const DEFAULT_TRANSCRIPTION_BATCH_TIMEOUT_MS = 300000;
const DEFAULT_MAX_TRANSCRIPT_CHARS = 80000;
const DEFAULT_MAX_COMBINED_TRANSCRIPT_CHARS = 120000;

class AudioTranscriptionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AudioTranscriptionError";
    this.code = code;
  }
}

class AudioTranscriptionService {
  constructor(options = {}) {
    this.getAdapter = typeof options.getAdapter === "function" ? options.getAdapter : () => options.adapter;
    this.limits = normalizeLimits(options.limits);
    this.diagnostics = options.diagnostics ?? null;
  }

  async transcribeBatch(sources, options = {}) {
    const items = Array.isArray(sources) ? sources : [];
    if (items.length === 0) {
      throw new AudioTranscriptionError("empty-batch", "No audio files were provided for transcription.");
    }
    if (items.length > this.limits.maxFiles) {
      throw new AudioTranscriptionError(
        "too-many-files",
        `A request can include at most ${this.limits.maxFiles} audio files.`
      );
    }

    validateDeclaredBatchBytes(items, this.limits);
    throwIfAborted(options.signal);

    const batchController = new AbortController();
    const cleanupExternalAbort = forwardAbort(options.signal, batchController);
    const batchTimer = createTimeout(
      batchController,
      this.limits.batchTimeoutMs,
      "batch-timeout",
      "Audio transcription timed out."
    );

    try {
      const providerDiagnostic = createAudioProviderDiagnosticContext(
        options.adapterContext,
        options.model
      );
      const adapter = await Promise.resolve(this.getAdapter(options.adapterContext));
      if (!adapter || typeof adapter.transcribe !== "function") {
        throw new AudioTranscriptionError(
          "transcription-not-configured",
          "Audio transcription is not configured."
        );
      }

      const prepared = [];
      let combinedDurationMs = 0;
      for (const source of items) {
        throwIfAborted(batchController.signal);
        const arrayBuffer = await readAudioSource(source, batchController.signal);
        let inspection;
        try {
          inspection = inspectAudioBuffer(arrayBuffer, {
            name: source.name,
            extension: source.extension,
            mimeType: source.mimeType,
            size: source.size
          }, {
            maxBytes: this.limits.maxBytes,
            maxDurationMs: this.limits.maxDurationMs
          });
        } catch (error) {
          await this.logDiagnostic("attachment.audio.validation_failed", {
            stage: "local-validation",
            errorCode: getAudioErrorCode(error),
            extension: source.extension,
            sizeBytes: source.size
          });
          throw error;
        }
        await this.logDiagnostic("attachment.audio.validation_succeeded", {
          stage: "local-validation",
          extension: inspection.extension,
          container: inspection.container,
          codec: inspection.codec,
          fragmented: inspection.fragmented,
          sizeBytes: inspection.size,
          durationMs: inspection.durationMs
        });
        combinedDurationMs += inspection.durationMs;
        if (combinedDurationMs > this.limits.maxCombinedDurationMs) {
          throw new AudioTranscriptionError(
            "combined-duration-too-long",
            "The combined audio duration is longer than 60 minutes."
          );
        }
        prepared.push({ source, arrayBuffer, inspection });
      }

      const results = [];
      let combinedTranscriptChars = 0;
      for (const item of prepared) {
        throwIfAborted(batchController.signal);
        const fileController = new AbortController();
        const cleanupBatchAbort = forwardAbort(batchController.signal, fileController);
        const fileTimer = createTimeout(
          fileController,
          this.limits.timeoutMs,
          "transcription-timeout",
          "Audio transcription timed out."
        );

        let stage = "provider-capability";
        try {
          if (typeof adapter.supportsFormat === "function" && !adapter.supportsFormat(item.inspection)) {
            throw new AudioTranscriptionError(
              "adapter-format-unsupported",
              `The selected transcription provider does not support .${item.inspection.extension} audio.`
            );
          }

          await this.logDiagnostic("attachment.audio.transcription_started", {
            stage: "provider-request",
            ...providerDiagnostic,
            extension: item.inspection.extension,
            container: item.inspection.container,
            codec: item.inspection.codec,
            fragmented: item.inspection.fragmented,
            sizeBytes: item.inspection.size,
            durationMs: item.inspection.durationMs
          });
          stage = "provider-request";
          const response = await raceWithAbort(Promise.resolve().then(() => {
            throwIfAborted(fileController.signal);
            item.source.beforeUpload?.();
            options.onCallStarted?.({ name: item.source.name, inspection: item.inspection });
            return adapter.transcribe({
              audio: item.arrayBuffer,
              fileName: item.source.name,
              mimeType: getProviderMimeType(item.inspection),
              inspection: item.inspection,
              model: options.model,
              signal: fileController.signal,
              beforeUpload: item.source.beforeUpload
            });
          }), fileController.signal);
          throwIfAborted(fileController.signal);
          stage = "transcript-normalization";
          const normalized = normalizeTranscript(response?.text, this.limits.maxTranscriptChars);
          if (!normalized.text) {
            throw new AudioTranscriptionError("no-speech", "No speech was detected in the audio file.");
          }

          const remaining = this.limits.maxCombinedTranscriptChars - combinedTranscriptChars;
          if (remaining <= 0) {
            throw new AudioTranscriptionError(
              "combined-transcript-too-large",
              "The combined audio transcript limit was reached."
            );
          }
          const combinedLimited = limitUnicodeText(normalized.text, remaining);
          const characterCount = countUnicodeCharacters(combinedLimited.text);
          combinedTranscriptChars += characterCount;
          results.push({
            name: item.source.name,
            text: combinedLimited.text,
            truncated: normalized.truncated || combinedLimited.truncated,
            characterCount,
            inspection: item.inspection,
            usage: normalizeTranscriptionUsage(response?.usage)
          });
          await this.logDiagnostic("attachment.audio.transcription_completed", {
            stage: "attachment-processing",
            ...providerDiagnostic,
            extension: item.inspection.extension,
            container: item.inspection.container,
            codec: item.inspection.codec,
            fragmented: item.inspection.fragmented,
            sizeBytes: item.inspection.size,
            durationMs: item.inspection.durationMs
          });
        } catch (error) {
          await this.logDiagnostic("attachment.audio.transcription_failed", {
            stage,
            errorCode: getAudioErrorCode(error),
            ...providerDiagnostic,
            extension: item.inspection.extension,
            container: item.inspection.container,
            codec: item.inspection.codec,
            fragmented: item.inspection.fragmented,
            sizeBytes: item.inspection.size,
            durationMs: item.inspection.durationMs
          });
          throw error;
        } finally {
          fileTimer.clear();
          cleanupBatchAbort();
        }
      }

      return {
        results,
        combinedTranscriptChars,
        combinedDurationMs
      };
    } catch (error) {
      throw normalizeTranscriptionError(error);
    } finally {
      batchTimer.clear();
      cleanupExternalAbort();
    }
  }

  async logDiagnostic(event, detail) {
    if (!this.diagnostics || typeof this.diagnostics.debug !== "function") {
      return;
    }
    try {
      await this.diagnostics.debug(event, createSafeAudioDiagnosticDetail(detail));
    } catch {
      // Diagnostics must never interrupt attachment processing.
    }
  }
}

function normalizeTranscript(value, maxChars = DEFAULT_MAX_TRANSCRIPT_CHARS) {
  const normalized = String(value || "")
    .replace(/\u0000/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
  return limitUnicodeText(normalized, maxChars);
}

function limitUnicodeText(value, maxChars) {
  const text = String(value || "");
  if (!Number.isFinite(maxChars) || maxChars < 0) {
    return { text, truncated: false };
  }

  const codePoints = Array.from(text);
  if (codePoints.length <= maxChars) {
    return { text, truncated: false };
  }

  return {
    text: codePoints.slice(0, maxChars).join("").trimEnd(),
    truncated: true
  };
}

function countUnicodeCharacters(value) {
  return Array.from(String(value || "")).length;
}

function normalizeTranscriptionUsage(usage) {
  if (!usage || typeof usage !== "object") {
    return { type: "unknown", incomplete: true };
  }
  if (usage.type === "tokens") {
    const normalized = {
      type: "tokens",
      inputTokens: readFiniteNumber(usage.inputTokens),
      audioInputTokens: readFiniteNumber(usage.audioInputTokens),
      textInputTokens: readFiniteNumber(usage.textInputTokens),
      outputTokens: readFiniteNumber(usage.outputTokens),
      totalTokens: readFiniteNumber(usage.totalTokens)
    };
    return {
      ...normalized,
      incomplete: !Number.isFinite(normalized.totalTokens)
    };
  }
  if (usage.type === "duration") {
    const seconds = readFiniteNumber(usage.seconds);
    return {
      type: "duration",
      seconds,
      incomplete: !Number.isFinite(seconds)
    };
  }
  return { type: "unknown", incomplete: true };
}

async function readAudioSource(source, signal) {
  throwIfAborted(signal);
  if (typeof source?.readArrayBuffer !== "function") {
    throw new AudioTranscriptionError("unreadable-file", "The audio file could not be read.");
  }
  const result = await raceWithAbort(Promise.resolve().then(() => source.readArrayBuffer()), signal);
  throwIfAborted(signal);
  return result;
}

function validateDeclaredBatchBytes(items, limits) {
  let totalBytes = 0;
  for (const source of items) {
    const size = Number(source?.size);
    if (!Number.isFinite(size) || size <= 0) {
      throw new AudioTranscriptionError("empty-file", "The audio file is empty.");
    }
    if (size > limits.maxBytes) {
      throw new AudioTranscriptionError("file-too-large", "The audio file is larger than 15 MB.");
    }
    totalBytes += size;
  }
  if (totalBytes > limits.maxCombinedBytes) {
    throw new AudioTranscriptionError(
      "combined-bytes-too-large",
      "The combined audio size is larger than 30 MB."
    );
  }
}

function normalizeLimits(value = {}) {
  return {
    maxFiles: value.maxFiles ?? DEFAULT_MAX_AUDIO_FILES,
    maxBytes: value.maxBytes ?? DEFAULT_MAX_AUDIO_BYTES,
    maxCombinedBytes: value.maxCombinedBytes ?? DEFAULT_MAX_COMBINED_AUDIO_BYTES,
    maxDurationMs: value.maxDurationMs ?? DEFAULT_MAX_AUDIO_DURATION_MS,
    maxCombinedDurationMs: value.maxCombinedDurationMs ?? DEFAULT_MAX_COMBINED_AUDIO_DURATION_MS,
    timeoutMs: value.timeoutMs ?? DEFAULT_TRANSCRIPTION_TIMEOUT_MS,
    batchTimeoutMs: value.batchTimeoutMs ?? DEFAULT_TRANSCRIPTION_BATCH_TIMEOUT_MS,
    maxTranscriptChars: value.maxTranscriptChars ?? DEFAULT_MAX_TRANSCRIPT_CHARS,
    maxCombinedTranscriptChars: value.maxCombinedTranscriptChars ?? DEFAULT_MAX_COMBINED_TRANSCRIPT_CHARS
  };
}

function normalizeTranscriptionError(error) {
  if (error instanceof AudioTranscriptionError) {
    return error;
  }
  if (error instanceof AudioValidationError) {
    return new AudioTranscriptionError(error.code, error.message);
  }
  if (error?.name === "AbortError") {
    return new AudioTranscriptionError("cancelled", "Transcription cancelled.");
  }
  if (error?.code === "batch-timeout" || error?.code === "transcription-timeout") {
    return new AudioTranscriptionError(error.code, error.message || "Audio transcription timed out.");
  }
  return new AudioTranscriptionError("transcription-failed", "Audio transcription failed.");
}

function getAudioErrorCode(error) {
  if (typeof error?.code === "string" && error.code.trim()) {
    return error.code;
  }
  if (error?.name === "AbortError") {
    return "cancelled";
  }
  return "transcription-failed";
}

function createSafeAudioDiagnosticDetail(value = {}) {
  const detail = {};
  for (const key of ["stage", "errorCode", "extension", "container", "codec"]) {
    const token = normalizeDiagnosticToken(value[key]);
    if (token) {
      detail[key] = token;
    }
  }
  for (const key of ["sizeBytes", "durationMs"]) {
    if (Number.isFinite(value[key]) && value[key] >= 0) {
      detail[key] = Math.round(value[key]);
    }
  }
  if (typeof value.fragmented === "boolean") {
    detail.fragmented = value.fragmented;
  }
  const providerId = normalizeDiagnosticIdentifier(value.providerId);
  if (providerId) {
    detail.providerId = providerId;
  }
  const model = normalizeDiagnosticIdentifier(value.model);
  if (model) {
    detail.model = model;
  }
  if (value.authenticationMode === "none" || value.authenticationMode === "secret") {
    detail.authenticationMode = value.authenticationMode;
  }
  const endpoint = summarizeDiagnosticEndpoint(value.endpoint);
  if (endpoint) {
    detail.endpoint = endpoint;
  }
  return detail;
}

function createAudioProviderDiagnosticContext(adapterContext, model) {
  const context = adapterContext && typeof adapterContext === "object"
    ? adapterContext
    : null;
  return {
    providerId: context?.providerId,
    endpoint: context?.endpoint,
    authenticationMode: context
      ? (String(context.authenticationPath || "").trim() ? "secret" : "none")
      : "",
    model
  };
}

function normalizeDiagnosticToken(value) {
  const token = String(value || "").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(token) ? token : "";
}

function normalizeDiagnosticIdentifier(value) {
  const identifier = String(value || "").trim();
  return /^[a-z0-9][a-z0-9._:/@+-]{0,127}$/i.test(identifier) ? identifier : "";
}

function summarizeDiagnosticEndpoint(value) {
  const endpoint = String(value || "").trim();
  if (!endpoint) {
    return null;
  }
  try {
    const parsed = new URL(endpoint);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { present: true, protocol: "", host: "", hasQuery: Boolean(parsed.search) };
    }
    return {
      present: true,
      protocol: parsed.protocol.replace(/:$/, ""),
      host: parsed.host,
      hasQuery: Boolean(parsed.search)
    };
  } catch {
    return {
      present: true,
      protocol: "",
      host: "",
      hasQuery: endpoint.includes("?")
    };
  }
}

function getProviderMimeType(inspection) {
  if (inspection.extension === "m4a") {
    return "audio/mp4";
  }
  if (inspection.extension === "mp3") {
    return "audio/mpeg";
  }
  if (inspection.extension === "wav") {
    return "audio/wav";
  }
  if (inspection.extension === "webm") {
    return "audio/webm";
  }
  if (inspection.extension === "ogg") {
    return "audio/ogg";
  }
  if (inspection.extension === "flac") {
    return "audio/flac";
  }
  return "application/octet-stream";
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

function forwardAbort(sourceSignal, targetController) {
  if (!sourceSignal) {
    return () => {};
  }
  const abort = () => targetController.abort(sourceSignal.reason);
  if (sourceSignal.aborted) {
    abort();
    return () => {};
  }
  sourceSignal.addEventListener("abort", abort, { once: true });
  return () => sourceSignal.removeEventListener("abort", abort);
}

function createTimeout(controller, timeoutMs, code, message) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return { clear() {} };
  }
  const timer = setTimeout(() => {
    const error = new Error(message);
    error.code = code;
    controller.abort(error);
  }, timeoutMs);
  return { clear: () => clearTimeout(timer) };
}

function raceWithAbort(promise, signal) {
  if (!signal) {
    return promise;
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback(value);
    };
    const onAbort = () => {
      try {
        throwIfAborted(signal);
      } catch (error) {
        finish(reject, error);
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    Promise.resolve(promise).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error)
    );
  });
}

function readFiniteNumber(value) {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

module.exports = {
  AudioTranscriptionError,
  AudioTranscriptionService,
  DEFAULT_MAX_AUDIO_FILES,
  DEFAULT_MAX_COMBINED_AUDIO_BYTES,
  DEFAULT_MAX_COMBINED_AUDIO_DURATION_MS,
  DEFAULT_MAX_COMBINED_TRANSCRIPT_CHARS,
  DEFAULT_MAX_TRANSCRIPT_CHARS,
  DEFAULT_TRANSCRIPTION_BATCH_TIMEOUT_MS,
  DEFAULT_TRANSCRIPTION_TIMEOUT_MS,
  limitUnicodeText,
  countUnicodeCharacters,
  normalizeTranscript,
  normalizeTranscriptionUsage,
  raceWithAbort
};
