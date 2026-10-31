const { OPENAI_COMPATIBLE_PROVIDER_TYPE } = require("../constants");

const AUDIO_TRANSCRIPTION_DISABLED_MESSAGE = "Audio transcription is off. Enable it in CoDriver Settings before adding audio.";
const AUDIO_TRANSCRIPTION_SELECTION_REQUIRED_MESSAGE = "Select an audio transcription model in CoDriver Settings before adding audio.";
const AUDIO_TRANSCRIPTION_SELECTION_UNAVAILABLE_MESSAGE = "The selected transcription model is unavailable. Select another model in CoDriver Settings.";
const AUDIO_TRANSCRIPTION_TOOLTIP = "Transcribe audio files with the selected model.";

const DEFAULT_AUDIO_TRANSCRIPTION_SETTINGS = Object.freeze({
  enabled: false,
  providerId: "",
  modelId: ""
});

function normalizeAudioTranscriptionSettings(value) {
  return {
    enabled: value?.enabled === true,
    providerId: normalizeIdentity(value?.providerId),
    modelId: normalizeIdentity(value?.modelId)
  };
}

const DEFAULT_VOICE_INPUT_SETTINGS = Object.freeze({
  enabled: false,
  providerId: "",
  modelId: "",
  timeoutSeconds: 15
});

function normalizeVoiceInputSettings(value, legacyAudio = null) {
  // Preserve only the exact previously enabled voice destination during the split.
  const source = value === undefined && legacyAudio?.voiceInputEnabled === true
    ? { enabled: true, providerId: legacyAudio.providerId, modelId: legacyAudio.modelId }
    : value;
  const timeout = source?.timeoutSeconds;
  return {
    enabled: source?.enabled === true,
    providerId: normalizeIdentity(source?.providerId),
    modelId: normalizeIdentity(source?.modelId),
    timeoutSeconds: typeof timeout === "number" && Number.isFinite(timeout)
      ? Math.max(5, Math.min(300, Math.floor(timeout))) : DEFAULT_VOICE_INPUT_SETTINGS.timeoutSeconds
  };
}

function resolveVoiceInputSelection(settings, options = {}) {
  const voiceInput = normalizeVoiceInputSettings(settings?.voiceInput);
  const result = resolveAudioTranscriptionSelection({ ...settings, audioTranscription: voiceInput }, options);
  if (!result.ok) {
    return { ...result, message: !voiceInput.enabled && options.requireEnabled !== false
      ? "Voice input is off. Enable it in CoDriver Settings."
      : "Select an available voice input provider and model in CoDriver Settings." };
  }
  return result;
}

function getAudioTranscriptionModelChoices(settings) {
  const providers = Array.isArray(settings?.providers) ? settings.providers : [];
  return providers
    .filter((provider) => (
      provider?.enabled !== false &&
      provider?.type === OPENAI_COMPATIBLE_PROVIDER_TYPE
    ))
    .map((provider) => ({
      providerId: normalizeIdentity(provider.id),
      providerName: normalizeIdentity(provider.name) || normalizeIdentity(provider.id),
      models: getAvailableProviderModelIds(provider)
    }))
    .filter((provider) => provider.providerId && provider.models.length > 0);
}

function resolveAudioTranscriptionSelection(settings, options = {}) {
  const selection = normalizeAudioTranscriptionSettings(settings?.audioTranscription);
  if (options.requireEnabled !== false && !selection.enabled) {
    return createUnavailableResult("audio-transcription-disabled", AUDIO_TRANSCRIPTION_DISABLED_MESSAGE, selection);
  }
  if (!selection.providerId || !selection.modelId) {
    return createUnavailableResult(
      "audio-transcription-selection-required",
      AUDIO_TRANSCRIPTION_SELECTION_REQUIRED_MESSAGE,
      selection
    );
  }

  const providerSettings = (Array.isArray(settings?.providers) ? settings.providers : [])
    .find((provider) => normalizeIdentity(provider?.id) === selection.providerId);
  if (
    !providerSettings ||
    providerSettings.enabled === false ||
    providerSettings.type !== OPENAI_COMPATIBLE_PROVIDER_TYPE ||
    !getAvailableProviderModelIds(providerSettings).includes(selection.modelId)
  ) {
    return createUnavailableResult(
      "audio-transcription-selection-unavailable",
      AUDIO_TRANSCRIPTION_SELECTION_UNAVAILABLE_MESSAGE,
      selection
    );
  }

  return {
    ok: true,
    code: "",
    message: "",
    enabled: selection.enabled,
    providerId: selection.providerId,
    providerName: normalizeIdentity(providerSettings.name) || selection.providerId,
    modelId: selection.modelId,
    providerSettings
  };
}

function isProviderModelDisabled(provider, modelId) {
  return Array.isArray(provider?.hiddenModels) && provider.hiddenModels.includes(modelId);
}

function getAvailableProviderModelIds(provider) {
  return getConfiguredProviderModelIds(provider).filter((model) => !isProviderModelDisabled(provider, model));
}

function getConfiguredProviderModelIds(provider) {
  const models = Array.isArray(provider?.models) ? provider.models : [];
  return Array.from(new Set(
    [...models, provider?.model]
      .map(normalizeIdentity)
      .filter(Boolean)
  ));
}

function encodeAudioTranscriptionSelection(providerId, modelId) {
  return JSON.stringify([normalizeIdentity(providerId), normalizeIdentity(modelId)]);
}

function decodeAudioTranscriptionSelection(value) {
  try {
    const parsed = JSON.parse(String(value ?? ""));
    if (!Array.isArray(parsed) || parsed.length !== 2) {
      return { providerId: "", modelId: "" };
    }
    return {
      providerId: normalizeIdentity(parsed[0]),
      modelId: normalizeIdentity(parsed[1])
    };
  } catch {
    return { providerId: "", modelId: "" };
  }
}

function createUnavailableResult(code, message, selection) {
  return {
    ok: false,
    code,
    message,
    enabled: selection.enabled,
    providerId: selection.providerId,
    providerName: "",
    modelId: selection.modelId,
    providerSettings: null
  };
}

function normalizeIdentity(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  AUDIO_TRANSCRIPTION_DISABLED_MESSAGE,
  AUDIO_TRANSCRIPTION_SELECTION_REQUIRED_MESSAGE,
  AUDIO_TRANSCRIPTION_SELECTION_UNAVAILABLE_MESSAGE,
  AUDIO_TRANSCRIPTION_TOOLTIP,
  DEFAULT_AUDIO_TRANSCRIPTION_SETTINGS,
  DEFAULT_VOICE_INPUT_SETTINGS,
  normalizeVoiceInputSettings,
  resolveVoiceInputSelection,
  decodeAudioTranscriptionSelection,
  encodeAudioTranscriptionSelection,
  getAudioTranscriptionModelChoices,
  getConfiguredProviderModelIds,
  isProviderModelDisabled,
  normalizeAudioTranscriptionSettings,
  resolveAudioTranscriptionSelection
};
