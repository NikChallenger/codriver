const {
  CODRIVER_VAULT_CONFIGURABLE_AUTO_TOOL_NAMES,
  CODRIVER_VAULT_TRANSCRIBE_AUDIO_TOOL_NAME,
  VAULT_AUDIO_AUTO_CONSENT_VERSION,
  CODRIVER_VAULT_TOOL_NAMES
} = require("../mcp/CodriverVaultMcpServer");
const { DEFAULT_SKILL_FOLDER_PATH } = require("../skills/SkillFolderLoader");
const { DEFAULT_COMMAND_FOLDER_PATH } = require("../commands/CommandFolderLoader");
const { DEFAULT_AUDIO_TRANSCRIPTION_SETTINGS } = require("./AudioTranscriptionSettings");

const DEFAULT_MAX_REQUEST_CONTEXT_CHARS = 200000;
const MIN_REQUEST_CONTEXT_CHARS = 10000;
const MAX_REQUEST_CONTEXT_CHARS_SETTING = 1000000;
const REQUEST_CONTEXT_CHARS_STEP = 10000;
const DEFAULT_MAX_MCP_TOOLS = 45;
const MIN_MCP_TOOLS = 0;
const MAX_MCP_TOOLS_SETTING = 200;

const DEFAULT_SETTINGS = {
  providers: [],
  mcpServers: [],
  selectedProviderId: null,
  selectedModelId: null,
  audioTranscription: DEFAULT_AUDIO_TRANSCRIPTION_SETTINGS,
  skillFolderPath: DEFAULT_SKILL_FOLDER_PATH,
  skillSettings: {},
  commandFolderPath: DEFAULT_COMMAND_FOLDER_PATH,
  commandSettings: {},
  enableSessionHistory: true,
  maxSessionHistory: 5,
  sessionStartupBehavior: "new",
  maxMcpTools: DEFAULT_MAX_MCP_TOOLS,
  maxAutomaticMcpToolCalls: 10,
  mcpToolTimeoutSeconds: 60,
  maxMcpToolResultChars: 60000,
  maxRequestContextChars: DEFAULT_MAX_REQUEST_CONTEXT_CHARS,
  enableCoDriverVaultTools: true,
  codriverVaultToolSettings: Object.fromEntries(
    CODRIVER_VAULT_TOOL_NAMES.map((toolName) => [
      toolName,
      {
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
  DEFAULT_MAX_MCP_TOOLS,
  DEFAULT_MAX_REQUEST_CONTEXT_CHARS,
  DEFAULT_SETTINGS,
  MAX_MCP_TOOLS_SETTING,
  MAX_REQUEST_CONTEXT_CHARS_SETTING,
  MIN_MCP_TOOLS,
  MIN_REQUEST_CONTEXT_CHARS,
  REQUEST_CONTEXT_CHARS_STEP
};
