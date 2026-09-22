const { OPENAI_COMPATIBLE_PROVIDER_TYPE } = require("../constants");

const AUDIO_TRANSCRIPTION_DISABLED_MESSAGE = "Audio transcription is off. Enable it in CoDriver Settings before adding audio.";
const AUDIO_TRANSCRIPTION_SELECTION_REQUIRED_MESSAGE = "Select an audio transcription model in CoDriver Settings before adding audio.";
const AUDIO_TRANSCRIPTION_SELECTION_UNAVAILABLE_MESSAGE = "The selected transcription model is unavailable. Select another model in CoDriver Settings.";
const AUDIO_TRANSCRIPTION_TOOLTIP = "Uses the selected provider and model for audio transcription.";

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
      models: getConfiguredProviderModelIds(provider)
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
    !getConfiguredProviderModelIds(providerSettings).includes(selection.modelId)
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
  decodeAudioTranscriptionSelection,
  encodeAudioTranscriptionSelection,
  getAudioTranscriptionModelChoices,
  getConfiguredProviderModelIds,
  normalizeAudioTranscriptionSettings,
  resolveAudioTranscriptionSelection
};
