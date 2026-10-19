const {
  TEXT_DOCUMENT_AUTO_CONSENT_VERSION,
  TEXT_DOCUMENT_MUTATION_TOOLS,
  CODRIVER_VAULT_CONFIGURABLE_AUTO_TOOL_NAMES,
  CODRIVER_VAULT_TRANSCRIBE_AUDIO_TOOL_NAME,
  VAULT_AUDIO_AUTO_CONSENT_VERSION,
  CODRIVER_VAULT_TOOL_NAMES,
} = require("../mcp/CodriverVaultMcpServer");
const { DEFAULT_SKILL_FOLDER_PATH } = require("../skills/SkillFolderLoader");
const { DEFAULT_COMMAND_FOLDER_PATH } = require("../commands/CommandFolderLoader");
const { DEFAULT_AUDIO_TRANSCRIPTION_SETTINGS, DEFAULT_VOICE_INPUT_SETTINGS } = require("./AudioTranscriptionSettings");

const DEFAULT_MAX_REQUEST_CONTEXT_CHARS = 200000;
const MIN_REQUEST_CONTEXT_CHARS = 10000;
const MAX_REQUEST_CONTEXT_CHARS_SETTING = 1000000;
const REQUEST_CONTEXT_CHARS_STEP = 10000;
const DEFAULT_MAX_MCP_TOOLS = 45;
const MIN_MCP_TOOLS = 0;
const MAX_MCP_TOOLS_SETTING = 200;

// Setup templates only: model capabilities and credentials are never inferred.
const OPENAI_COMPATIBLE_PRESETS = Object.freeze([
  ["custom", "Custom", "", "manual"],
  ["openai", "OpenAI", "https://api.openai.com/v1", "gpt"],
  ["openrouter", "OpenRouter", "https://openrouter.ai/api/v1", "router"],
  ["deepseek", "DeepSeek", "https://api.deepseek.com", "deep seek"],
  ["groq", "Groq", "https://api.groq.com/openai/v1", "groqcloud"],
  ["mistral", "Mistral", "https://api.mistral.ai/v1", "mistral ai"],
  ["together", "Together AI", "https://api.together.ai/v1", "together"],
  ["ollama", "Ollama (local)", "http://localhost:11434/v1", "local"],
  ["lmstudio", "LM Studio (local)", "http://localhost:1234/v1", "local lmstudio"],
  ["xai", "xAI / Grok", "https://api.x.ai/v1", "grok x ai"],
  ["kimi", "Moonshot AI / Kimi", "https://api.moonshot.ai/v1", "moonshot kimi"],
  ["zai", "Z.ai / GLM", "https://api.z.ai/api/paas/v4", "glm z ai"],
  ["alibaba", "Alibaba Cloud / Qwen", "", "qwen dashscope model studio"],
  ["fireworks", "Fireworks AI", "https://api.fireworks.ai/inference/v1", "fireworks"],
  ["deepinfra", "DeepInfra", "https://api.deepinfra.com/v1/openai", "deep infra"],
  ["huggingface", "Hugging Face", "https://router.huggingface.co/v1", "hf huggingface inference providers"],
  ["nvidia", "NVIDIA API Catalog", "https://integrate.api.nvidia.com/v1", "nim"],
  ["siliconflow", "SiliconFlow", "https://api.siliconflow.com/v1", "silicon flow"]
].map(([id, name, endpoint, aliases]) => Object.freeze({ id, name, endpoint, aliases })));

function getOpenAiCompatibleEndpointError(endpoint) {
  if (typeof endpoint !== "string" || !endpoint.trim()) return "Enter a complete provider endpoint URL.";
  try {
    const url = new URL(endpoint.trim());
    if (!/^https?:\/\//i.test(endpoint.trim()) || !["http:", "https:"].includes(url.protocol)
      || !url.hostname || url.username || url.password || /[{}]/.test(endpoint)) {
      return "Enter an HTTP(S) base URL without credentials or placeholders.";
    }
  } catch { return "Enter a complete provider endpoint URL."; }
  return "";
}

function getOpenAiCompatiblePresetUpdate(draft, id) {
  const preset = OPENAI_COMPATIBLE_PRESETS.find((item) => item.id === id);
  if (!preset) return null;
  const currentEndpoint = typeof draft.endpoint === "string" ? draft.endpoint.trim().replace(/\/+$/, "") : "";
  const endpointChanged = currentEndpoint !== preset.endpoint.replace(/\/+$/, "");
  const name = typeof draft.name === "string" ? draft.name : "";
  const genericName = !name.trim() || /^OpenAI-compatible(?: \d+)?$/.test(name)
    || OPENAI_COMPATIBLE_PRESETS.some((item) => item.name === name);
  const update = {};
  if (id !== "custom" && genericName) update.name = preset.name;
  if (endpointChanged) {
    Object.assign(update, { endpoint: preset.endpoint, apiKeySecretName: "", model: "", models: [], hiddenModels: [],
      temperature: "", topP: "", topK: "", reasoningEffort: "" });
  }
  return { update, endpointChanged };
}

const DEFAULT_SETTINGS = {
  releaseNotesAcknowledgedVersion: "",
  providers: [],
  mcpServers: [],
  selectedProviderId: null,
  selectedModelId: null,
  audioTranscription: DEFAULT_AUDIO_TRANSCRIPTION_SETTINGS,
  voiceInput: DEFAULT_VOICE_INPUT_SETTINGS,
  skillFolderPath: DEFAULT_SKILL_FOLDER_PATH,
  skillSettings: {},
  commandFolderPath: DEFAULT_COMMAND_FOLDER_PATH,
  commandSettings: {},
  enableAutomaticActiveNoteContext: true,
  enableSessionHistory: true,
  maxSessionHistory: 5,
  sessionStartupBehavior: "new",
  maxMcpTools: DEFAULT_MAX_MCP_TOOLS,
  maxAutomaticMcpToolCalls: 10,
  mcpToolTimeoutSeconds: 60,
  maxMcpToolResultChars: 60000,
  maxRequestContextChars: DEFAULT_MAX_REQUEST_CONTEXT_CHARS,
  enableCoDriverVaultTools: true,
  enableDirectObsidianApiAccess: false,
  allowAutomaticDirectObsidianApiAccess: false,
  enableDirectPluginApiAccess: false,
  directPluginApiSettings: {},
  codriverVaultToolSettings: Object.fromEntries(
    CODRIVER_VAULT_TOOL_NAMES.map((toolName) => [
      toolName,
      {
        ...(TEXT_DOCUMENT_MUTATION_TOOLS.includes(toolName) ? { documentAutoConsentVersion: TEXT_DOCUMENT_AUTO_CONSENT_VERSION } : {}),
        ...(toolName === CODRIVER_VAULT_TRANSCRIBE_AUDIO_TOOL_NAME ? { autoConsentVersion: VAULT_AUDIO_AUTO_CONSENT_VERSION } : { enabled: true }),
        ...(CODRIVER_VAULT_CONFIGURABLE_AUTO_TOOL_NAMES.includes(toolName)
          ? { allowAutomaticExecution: false }
          : {})
      }
    ])
  ),
  enableDiagnosticLogging: false,
  diagnosticLogLevel: "errors",
  diagnosticLogTarget: "console"
};

module.exports = {
  OPENAI_COMPATIBLE_PRESETS,
  getOpenAiCompatibleEndpointError,
  getOpenAiCompatiblePresetUpdate,
  DEFAULT_MAX_MCP_TOOLS,
  DEFAULT_MAX_REQUEST_CONTEXT_CHARS,
  DEFAULT_SETTINGS,
  MAX_MCP_TOOLS_SETTING,
  MAX_REQUEST_CONTEXT_CHARS_SETTING,
  MIN_MCP_TOOLS,
  MIN_REQUEST_CONTEXT_CHARS,
  REQUEST_CONTEXT_CHARS_STEP
};
