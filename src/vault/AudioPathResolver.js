const { AUDIO_ATTACHMENT_EXTENSIONS } = require("../attachments/AudioInspector");

class AudioPathResolutionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AudioPathResolutionError";
    this.code = code;
  }
}

function resolveVaultAudioPath(app, input) {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
      Object.keys(input).length !== 1 || !Object.hasOwn(input, "path") || typeof input.path !== "string") {
    throw new AudioPathResolutionError("audio-path-invalid-arguments", "Provide only one exact vault-relative audio path in the path argument. Legacy embed arguments are not supported.");
  }
  const path = input.path;
  if (!path || path !== path.trim() || /[\x00-\x1f\x7f\\:*?"<>|\[\]#]/.test(path) ||
      path.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw new AudioPathResolutionError("audio-path-unsafe", "Use an exact vault-relative audio file path with forward slashes, not a URL, OS path, or Markdown link.");
  }
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (extension === "md" || extension === "markdown") {
    throw new AudioPathResolutionError("audio-path-markdown", "Markdown notes cannot be transcribed. Provide the exact vault-relative audio file path.");
  }
  if (!AUDIO_ATTACHMENT_EXTENSIONS.has(extension)) {
    throw new AudioPathResolutionError("audio-path-unsupported-extension", "The path must identify a supported audio file (.m4a, .mp3, .wav, .webm, .ogg, or .flac).");
  }
  const file = app?.vault?.getAbstractFileByPath?.(path);
  if (!file || file.path !== path || file.children || typeof file.extension !== "string" || file.extension.toLowerCase() !== extension) {
    throw new AudioPathResolutionError("audio-path-file-missing", "The exact vault audio file was not found.");
  }
  if (!Number.isFinite(file.stat?.size) || file.stat.size < 0 || !Number.isFinite(file.stat?.mtime)) {
    throw new AudioPathResolutionError("audio-path-metadata-unavailable", "The audio file state is unavailable. Request transcription again when metadata is available.");
  }
  return {
    path, extension, size: file.stat.size, mtime: file.stat.mtime,
    ctime: Number.isFinite(file.stat.ctime) ? file.stat.ctime : null,
    file
  };
}

module.exports = { AudioPathResolutionError, resolveVaultAudioPath };
