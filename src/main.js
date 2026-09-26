const { Notice, Platform, Plugin } = require("obsidian");
const { ChatController, COMMAND_ACTION_SESSION_MODE } = require("./chat/ChatController");
const {
  DEFAULT_MAX_MCP_TOOLS,
  DEFAULT_SETTINGS,
  MAX_MCP_TOOLS_SETTING,
  MAX_REQUEST_CONTEXT_CHARS_SETTING,
  MIN_MCP_TOOLS,
  MIN_REQUEST_CONTEXT_CHARS,
  REQUEST_CONTEXT_CHARS_STEP
} = require("./settings/defaults");
const { CoDriverSettingTab } = require("./settings/CoDriverSettingTab");
const {
  normalizeAudioTranscriptionSettings,
  resolveAudioTranscriptionSelection
} = require("./settings/AudioTranscriptionSettings");
const {
  ANTHROPIC_PROVIDER_TYPE,
  DEFAULT_ANTHROPIC_BASE_ENDPOINT,
  DEFAULT_ANTHROPIC_MAX_OUTPUT_TOKENS,
  DEFAULT_ANTHROPIC_PROVIDER_ID,
  DEFAULT_ANTHROPIC_PROVIDER_NAME,
  DEFAULT_GEMINI_API_VERSION,
  DEFAULT_GEMINI_BASE_ENDPOINT,
  DEFAULT_GEMINI_PROVIDER_ID,
  DEFAULT_GEMINI_PROVIDER_NAME,
  DEFAULT_OPENAI_COMPATIBLE_BASE_URL,
  DEFAULT_OPENAI_COMPATIBLE_PROVIDER_ID,
  DEFAULT_OPENAI_COMPATIBLE_PROVIDER_NAME,
  GEMINI_PROVIDER_TYPE,
  MCP_HTTP_TRANSPORT,
  MCP_STDIO_TRANSPORT,
  OPENAI_PROVIDER_TYPE,
  VIEW_TYPE_CODRIVER
} = require("./constants");
const { ProviderRegistry } = require("./providers/ProviderRegistry");
const { OpenAiCompatibleProvider } = require("./providers/openai-compatible/OpenAiCompatibleProvider");
const { GeminiProvider } = require("./providers/gemini/GeminiProvider");
const { AnthropicProvider } = require("./providers/anthropic/AnthropicProvider");
const { SessionStorage } = require("./chat/SessionStorage");
const { ChatView } = require("./views/ChatView");
const {
  CommandActionModal,
  CommandActionPickerModal,
  filterCommandActionChoices
} = require("./views/CommandActionModal");
const {
  DEFAULT_SKILL_FOLDER_PATH,
  LEGACY_HIDDEN_SKILL_FOLDER_PATH,
  SkillFolderLoader,
  createDuplicateSkillError,
  normalizeSkillFolderPath,
  validateSkillFolderPath
} = require("./skills/SkillFolderLoader");
const {
  CommandFolderLoader,
  DEFAULT_COMMAND_FOLDER_PATH,
  createDuplicateCommandError,
  normalizeCommandFolderPath,
  validateCommandFolderPath
} = require("./commands/CommandFolderLoader");
const { DiagnosticLogger } = require("./diagnostics/DiagnosticLogger");
const { McpHttpClient } = require("./mcp/McpHttpClient");
const { McpStdioClient } = require("./mcp/McpStdioClient");
const {
  STDIO_MCP_UNAVAILABLE_MESSAGE,
  getStdioMcpRuntimeSupport
} = require("./mcp/McpRuntimeSupport");
const {
  CODRIVER_VAULT_CONFIGURABLE_AUTO_TOOL_NAMES,
  CODRIVER_VAULT_TRANSCRIBE_AUDIO_TOOL_NAME,
  VAULT_AUDIO_AUTO_CONSENT_VERSION,
  CODRIVER_VAULT_TOOL_NAMES,
  CODRIVER_VAULT_SERVER_ID
} = require("./mcp/CodriverVaultMcpServer");

function cloneDefaultSettings() {
  return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
}

function createPersistableSettings(settings) {
  const persistable = JSON.parse(JSON.stringify(settings));

  for (const provider of persistable.providers ?? []) {
    delete provider.apiKey;
  }

  return persistable;
}

function hasPersistedApiKey(settings) {
  return Array.isArray(settings?.providers) && settings.providers.some(
    (provider) => Object.prototype.hasOwnProperty.call(provider ?? {}, "apiKey")
  );
}

function normalizeSettings(settings) {
  const providers = Array.isArray(settings.providers)
    ? settings.providers
    : [];

  settings.providers = providers.map((provider, index) => normalizeProviderSettings(provider, index));

  for (const provider of settings.providers) {
    if (!Array.isArray(provider.models)) {
      provider.models = [];
    }

    if (!Array.isArray(provider.hiddenModels)) {
      provider.hiddenModels = [];
    }
  }

  settings.mcpServers = Array.isArray(settings.mcpServers)
    ? settings.mcpServers.map((server, index) => normalizeMcpServerSettings(server, index))
    : [];
  settings.audioTranscription = normalizeAudioTranscriptionSettings(settings.audioTranscription);

  const enabledProviders = settings.providers.filter((provider) => provider.enabled !== false);
  let selectedProvider = enabledProviders.find((provider) => provider.id === settings.selectedProviderId);
  if (!selectedProvider) {
    selectedProvider = enabledProviders[0] ?? null;
    settings.selectedProviderId = selectedProvider?.id ?? null;
  }

  if (selectedProvider) {
    const visibleModels = getVisibleProviderModelIds(selectedProvider);
    const availableModels = new Set([
      ...(Array.isArray(selectedProvider.models) ? selectedProvider.models : []),
      selectedProvider.model
    ].filter(Boolean));

    if (
      settings.selectedModelId &&
      (!availableModels.has(settings.selectedModelId) || !visibleModels.includes(settings.selectedModelId))
    ) {
      settings.selectedModelId = getPreferredVisibleProviderModel(selectedProvider);
    } else if (!settings.selectedModelId) {
      settings.selectedModelId = getPreferredVisibleProviderModel(selectedProvider);
    } else if (selectedProvider.model && settings.selectedModelId !== selectedProvider.model && visibleModels.includes(selectedProvider.model)) {
      settings.selectedModelId = selectedProvider.model;
    } else if (settings.selectedModelId && !availableModels.has(settings.selectedModelId)) {
      settings.selectedModelId = getPreferredVisibleProviderModel(selectedProvider);
    }
  } else {
    settings.selectedModelId = null;
  }

  settings.skillSettings = normalizeSkillSettings(settings.skillSettings);
  settings.commandSettings = normalizeSkillSettings(settings.commandSettings);
  settings.commandFolderPath = normalizeCommandFolderPath(settings.commandFolderPath ?? DEFAULT_COMMAND_FOLDER_PATH);
  settings.skillFolderPath = normalizeSkillFolderPath(
    settings.skillFolderPath ?? DEFAULT_SKILL_FOLDER_PATH
  );
  if (settings.skillFolderPath === LEGACY_HIDDEN_SKILL_FOLDER_PATH) {
    settings.skillFolderPath = DEFAULT_SKILL_FOLDER_PATH;
  }
  settings.enableSessionHistory = settings.enableSessionHistory !== false;
  settings.maxSessionHistory = normalizeMaxSessionHistory(settings.maxSessionHistory);
  settings.sessionStartupBehavior = normalizeSessionStartupBehavior(settings.sessionStartupBehavior);
  settings.maxMcpTools = normalizeMaxMcpTools(settings.maxMcpTools);
  settings.maxAutomaticMcpToolCalls = normalizeMaxAutomaticMcpToolCalls(settings.maxAutomaticMcpToolCalls);
  settings.mcpToolTimeoutSeconds = normalizeMcpToolTimeoutSeconds(settings.mcpToolTimeoutSeconds);
  delete settings.maxRecentMcpToolResults;
  delete settings.maxRecentMcpToolResultContextChars;
  settings.maxRequestContextChars = normalizeMaxRequestContextChars(settings.maxRequestContextChars);
  settings.enableCoDriverVaultTools = settings.enableCoDriverVaultTools !== false;
  settings.codriverVaultToolSettings = normalizeCodriverVaultToolSettings(settings.codriverVaultToolSettings);
  settings.enableDiagnosticLogging = settings.enableDiagnosticLogging === true;
  settings.diagnosticLogLevel = normalizeDiagnosticLogLevel(settings.diagnosticLogLevel);
  settings.diagnosticLogTarget = normalizeDiagnosticLogTarget(settings.diagnosticLogTarget);

  return settings;
}

function createProviderSettings(type, id = "") {
  const providerType = normalizeProviderType(type);
  if (providerType === ANTHROPIC_PROVIDER_TYPE) {
    return {
      id: id || DEFAULT_ANTHROPIC_PROVIDER_ID,
      type: ANTHROPIC_PROVIDER_TYPE,
      name: DEFAULT_ANTHROPIC_PROVIDER_NAME,
      endpoint: DEFAULT_ANTHROPIC_BASE_ENDPOINT,
      apiKeySecretName: "",
      model: "",
      models: [],
      hiddenModels: [],
      enabled: true,
      maxOutputTokens: String(DEFAULT_ANTHROPIC_MAX_OUTPUT_TOKENS),
      enablePromptCaching: true,
      promptCacheTtl: "5m"
    };
  }

  if (providerType === GEMINI_PROVIDER_TYPE) {
    return {
      id: id || DEFAULT_GEMINI_PROVIDER_ID,
      type: GEMINI_PROVIDER_TYPE,
      name: DEFAULT_GEMINI_PROVIDER_NAME,
      endpoint: DEFAULT_GEMINI_BASE_ENDPOINT,
      apiVersion: DEFAULT_GEMINI_API_VERSION,
      apiKeySecretName: "",
      model: "",
      models: [],
      hiddenModels: [],
      enabled: true,
      temperature: "",
      topP: "",
      maxOutputTokens: "",
      topK: "",
      thinkingBudget: "",
      thinkingLevel: "",
      enableGoogleSearch: false
    };
  }

  return {
    id: id || DEFAULT_OPENAI_COMPATIBLE_PROVIDER_ID,
    type: OPENAI_PROVIDER_TYPE,
    name: DEFAULT_OPENAI_COMPATIBLE_PROVIDER_NAME,
    endpoint: DEFAULT_OPENAI_COMPATIBLE_BASE_URL,
    apiKeySecretName: "",
    model: "",
    models: [],
    hiddenModels: [],
    enabled: true,
    temperature: "",
    topP: "",
    topK: "",
    reasoningEffort: ""
  };
}

function normalizeProviderSettings(provider, index = 0) {
  const providerType = normalizeProviderType(provider?.type);
  const defaultProvider = createProviderSettings(providerType);
  const fallbackId = index === 0 && providerType === OPENAI_PROVIDER_TYPE
    ? DEFAULT_OPENAI_COMPATIBLE_PROVIDER_ID
    : createProviderId(providerType, index + 1);
  const id = typeof provider?.id === "string" && provider.id.trim()
    ? provider.id.trim()
    : fallbackId;
  const name = typeof provider?.name === "string" && provider.name.trim()
    ? provider.name.trim()
    : defaultProvider.name;
  const configuredEndpoint = typeof provider?.endpoint === "string"
    ? provider.endpoint.trim()
    : "";
  const endpoint = configuredEndpoint || defaultProvider.endpoint;

  const normalizedProvider = {
    ...provider,
    id,
    name,
    type: providerType,
    endpoint,
    model: typeof provider?.model === "string" ? provider.model : defaultProvider.model,
    apiKeySecretName: typeof provider?.apiKeySecretName === "string" ? provider.apiKeySecretName : "",
    models: normalizeStringArray(provider?.models),
    hiddenModels: normalizeStringArray(provider?.hiddenModels),
    enabled: provider?.enabled !== false
  };

  if (providerType !== ANTHROPIC_PROVIDER_TYPE) {
    normalizedProvider.temperature = normalizeOptionalRangedNumberText(provider?.temperature, 0, 2);
    normalizedProvider.topP = normalizeOptionalRangedNumberText(provider?.topP, 0, 1);
    normalizedProvider.topK = normalizeOptionalIntegerText(provider?.topK);
  }

  if (providerType === ANTHROPIC_PROVIDER_TYPE) {
    normalizedProvider.endpoint = DEFAULT_ANTHROPIC_BASE_ENDPOINT;
    normalizedProvider.maxOutputTokens = normalizeOptionalIntegerText(provider?.maxOutputTokens) || String(DEFAULT_ANTHROPIC_MAX_OUTPUT_TOKENS);
    normalizedProvider.enablePromptCaching = provider?.enablePromptCaching !== false;
    normalizedProvider.promptCacheTtl = provider?.promptCacheTtl === "1h" ? "1h" : "5m";
    delete normalizedProvider.temperature;
    delete normalizedProvider.topP;
    delete normalizedProvider.topK;
    delete normalizedProvider.reasoningEffort;
    delete normalizedProvider.apiVersion;
    delete normalizedProvider.thinkingBudget;
    delete normalizedProvider.thinkingLevel;
    delete normalizedProvider.includeThoughts;
    delete normalizedProvider.enableGoogleSearch;
    delete normalizedProvider.enableGroundedCustomTools;
  } else if (providerType === GEMINI_PROVIDER_TYPE) {
    normalizedProvider.maxOutputTokens = normalizeOptionalIntegerText(provider?.maxOutputTokens);
    normalizedProvider.apiVersion = typeof provider?.apiVersion === "string" && provider.apiVersion.trim()
      ? provider.apiVersion.trim()
      : defaultProvider.apiVersion;
    normalizedProvider.thinkingBudget = normalizeOptionalNonNegativeIntegerText(provider?.thinkingBudget);
    normalizedProvider.thinkingLevel = normalizeThinkingLevel(provider?.thinkingLevel);
    normalizedProvider.enableGoogleSearch = provider?.enableGoogleSearch === true;
    delete normalizedProvider.enableGroundedCustomTools;
    delete normalizedProvider.reasoningEffort;
    delete normalizedProvider.includeThoughts;
  } else {
    delete normalizedProvider.apiVersion;
    delete normalizedProvider.thinkingBudget;
    delete normalizedProvider.thinkingLevel;
    delete normalizedProvider.includeThoughts;
    delete normalizedProvider.enableGoogleSearch;
    delete normalizedProvider.enableGroundedCustomTools;
    delete normalizedProvider.maxOutputTokens;
    normalizedProvider.reasoningEffort = normalizeReasoningEffort(provider?.reasoningEffort);
  }

  delete normalizedProvider.apiKey;

  return normalizedProvider;
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return Array.from(new Set(
    value
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter(Boolean)
  ));
}

function getVisibleProviderModelIds(provider) {
  const models = Array.isArray(provider?.models) ? provider.models : [];
  const hiddenModels = new Set(Array.isArray(provider?.hiddenModels) ? provider.hiddenModels : []);
  const fallbackModels = provider?.model ? [provider.model] : [];
  return Array.from(new Set([...models, ...fallbackModels]))
    .filter((model) => model && !hiddenModels.has(model));
}

function getPreferredVisibleProviderModel(provider) {
  const visibleModels = getVisibleProviderModelIds(provider);
  if (provider?.model && visibleModels.includes(provider.model)) {
    return provider.model;
  }

  return visibleModels[0] ?? null;
}

function normalizeOptionalRangedNumberText(value, min, max) {
  if (value === null || value === undefined) {
    return "";
  }

  const text = String(value).trim();
  if (!text) {
    return "";
  }

  const number = Number(text);
  return Number.isFinite(number) && number >= min && number <= max ? text : "";
}

function normalizeOptionalIntegerText(value) {
  if (value === null || value === undefined) {
    return "";
  }

  const text = String(value).trim();
  if (!text) {
    return "";
  }

  const number = Number(text);
  return Number.isInteger(number) && number > 0 ? String(number) : "";
}

function normalizeMaxAutomaticMcpToolCalls(value) {
  const defaultValue = cloneDefaultSettings().maxAutomaticMcpToolCalls;
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return defaultValue;
  }

  return Math.min(20, Math.max(1, Math.trunc(number)));
}

function normalizeMaxMcpTools(value) {
  if (value === null || value === undefined || (typeof value === "string" && !value.trim())) {
    return DEFAULT_MAX_MCP_TOOLS;
  }
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return DEFAULT_MAX_MCP_TOOLS;
  }

  return Math.min(MAX_MCP_TOOLS_SETTING, Math.max(MIN_MCP_TOOLS, Math.trunc(number)));
}

function normalizeSkillSettings(value) {
  const source = isPlainObject(value) ? value : {};
  return Object.fromEntries(Object.entries(source)
    .map(([skillId, setting]) => [String(skillId || "").trim(), {
      enabled: setting?.enabled !== false
    }])
    .filter(([skillId]) => Boolean(skillId)));
}

function normalizeMcpToolTimeoutSeconds(value) {
  const defaultValue = cloneDefaultSettings().mcpToolTimeoutSeconds;
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return defaultValue;
  }

  return Math.min(600, Math.max(5, Math.trunc(number)));
}

function normalizeMaxRequestContextChars(value) {
  const defaultValue = cloneDefaultSettings().maxRequestContextChars;
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return defaultValue;
  }

  if (number <= 0) {
    return 0;
  }

  const clamped = Math.min(
    MAX_REQUEST_CONTEXT_CHARS_SETTING,
    Math.max(MIN_REQUEST_CONTEXT_CHARS, Math.trunc(number))
  );
  return Math.round(clamped / REQUEST_CONTEXT_CHARS_STEP) * REQUEST_CONTEXT_CHARS_STEP;
}

function normalizeMaxSessionHistory(value) {
  const defaultValue = cloneDefaultSettings().maxSessionHistory;
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return defaultValue;
  }

  return Math.min(100, Math.max(1, Math.trunc(number)));
}

function normalizeSessionStartupBehavior(value) {
  const text = String(value || "").trim().toLowerCase();
  return text === "last" ? "last" : "new";
}

function normalizeDiagnosticLogLevel(value) {
  const text = String(value || "").trim().toLowerCase();
  return text === "errors" ? "errors" : "all";
}

function normalizeDiagnosticLogTarget(value) {
  const text = String(value || "").trim().toLowerCase();
  return text === "console" ? "console" : "file";
}

function normalizeOptionalNonNegativeIntegerText(value) {
  if (value === null || value === undefined) {
    return "";
  }

  const text = String(value).trim();
  if (!text) {
    return "";
  }

  const number = Number(text);
  return Number.isInteger(number) && number >= 0 ? String(number) : "";
}

function normalizeReasoningEffort(value) {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  return ["minimal", "low", "medium", "high"].includes(text) ? text : "";
}

function normalizeThinkingLevel(value) {
  const text = typeof value === "string" ? value.trim().toUpperCase() : "";
  return ["MINIMAL", "LOW", "MEDIUM", "HIGH"].includes(text) ? text : "";
}

function normalizeProviderType(type) {
  if (type === ANTHROPIC_PROVIDER_TYPE) {
    return ANTHROPIC_PROVIDER_TYPE;
  }

  if (type === GEMINI_PROVIDER_TYPE) {
    return GEMINI_PROVIDER_TYPE;
  }

  if (type === OPENAI_PROVIDER_TYPE) {
    return OPENAI_PROVIDER_TYPE;
  }

  return OPENAI_PROVIDER_TYPE;
}

function createProviderId(type, count) {
  const providerType = normalizeProviderType(type);
  const prefix = providerType === GEMINI_PROVIDER_TYPE
    ? "gemini"
    : (providerType === ANTHROPIC_PROVIDER_TYPE ? "anthropic" : "openai");
  return `${prefix}-${count}`;
}

function createMcpServerSettings(id = "") {
  return {
    id: id || "mcp-server-1",
    name: "MCP server",
    transport: MCP_STDIO_TRANSPORT,
    command: "",
    args: "",
    env: "",
    endpoint: "",
    headers: "",
    enabled: true,
    tools: []
  };
}

function normalizeMcpServerSettings(server, index = 0) {
  const defaults = createMcpServerSettings(`mcp-server-${index + 1}`);
  const id = typeof server?.id === "string" && server.id.trim()
    ? server.id.trim()
    : defaults.id;
  const name = typeof server?.name === "string" && server.name.trim()
    ? server.name.trim()
    : defaults.name;

  return {
    ...server,
    id,
    name,
    transport: normalizeMcpTransport(server?.transport),
    command: typeof server?.command === "string" ? server.command.trim() : "",
    args: typeof server?.args === "string" ? server.args.trim() : "",
    env: typeof server?.env === "string" ? server.env.trim() : "",
    endpoint: typeof server?.endpoint === "string" ? server.endpoint.trim() : "",
    headers: typeof server?.headers === "string" ? server.headers.trim() : "",
    enabled: server?.enabled !== false,
    tools: Array.isArray(server?.tools) ? server.tools.map(normalizeMcpToolSettings).filter(Boolean) : []
  };
}

function normalizeMcpTransport(transport) {
  return transport === MCP_HTTP_TRANSPORT ? MCP_HTTP_TRANSPORT : MCP_STDIO_TRANSPORT;
}

function normalizeMcpToolSettings(tool) {
  const name = typeof tool?.name === "string" && tool.name.trim()
    ? tool.name.trim()
    : "";
  if (!name) {
    return null;
  }

  return {
    name,
    title: typeof tool?.title === "string" ? tool.title : "",
    description: typeof tool?.description === "string" ? tool.description : "",
    inputSchema: isPlainObject(tool?.inputSchema) ? tool.inputSchema : null,
    outputSchema: isPlainObject(tool?.outputSchema) ? tool.outputSchema : null,
    annotations: isPlainObject(tool?.annotations) ? tool.annotations : null,
    enabled: tool?.enabled !== false,
    allowAutomaticExecution: tool?.allowAutomaticExecution === true
  };
}

function normalizeCodriverVaultToolSettings(value) {
  const source = isPlainObject(value) ? value : {};
  return Object.fromEntries(CODRIVER_VAULT_TOOL_NAMES.map((toolName) => [
    toolName,
    {
      ...(toolName === CODRIVER_VAULT_TRANSCRIBE_AUDIO_TOOL_NAME
        ? { autoConsentVersion: VAULT_AUDIO_AUTO_CONSENT_VERSION }
        : { enabled: source[toolName]?.enabled !== false }),
      ...(CODRIVER_VAULT_CONFIGURABLE_AUTO_TOOL_NAMES.includes(toolName)
        ? { allowAutomaticExecution: source[toolName]?.allowAutomaticExecution === true &&
            (toolName !== CODRIVER_VAULT_TRANSCRIBE_AUDIO_TOOL_NAME || source[toolName]?.autoConsentVersion === VAULT_AUDIO_AUTO_CONSENT_VERSION) }
        : {})
    }
  ]));
}

function mergeDiscoveredMcpTools(existingTools, discoveredTools) {
  const existingByName = new Map(
    (Array.isArray(existingTools) ? existingTools : [])
      .map((tool) => [tool.name, tool])
  );

  return discoveredTools
    .map((tool) => {
      const existing = existingByName.get(tool.name);
      return normalizeMcpToolSettings({
        ...tool,
        enabled: existing?.enabled !== false,
        allowAutomaticExecution: existing?.allowAutomaticExecution === true
      });
    })
    .filter(Boolean);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

class CoDriverPlugin extends Plugin {
  async onload() {
    this.settings = cloneDefaultSettings();
    this.providerRegistry = new ProviderRegistry();
    this.chatController = null;
    this.commandActionModal = null;

    await this.loadSettings();
    this.sessionStorage = new SessionStorage(this.app, this.manifest.id);
    this.skillFolderLoader = new SkillFolderLoader(this.app, this.settings.skillFolderPath);
    this.commandFolderLoader = new CommandFolderLoader(this.app, this.settings.commandFolderPath);
    this.diagnosticLogger = new DiagnosticLogger(
      this.app,
      this.manifest.id,
      () => Boolean(this.settings.enableDiagnosticLogging),
      {
        getLogLevel: () => this.settings.diagnosticLogLevel,
        getLogTarget: () => this.settings.diagnosticLogTarget,
        isMobileApp: () => Boolean(Platform?.isMobileApp)
      }
    );
    await this.diagnosticLogger.refresh();
    this.registerProviders();
    this.chatController = new ChatController(
      this.app,
      this.settings,
      this.providerRegistry,
      this.sessionStorage,
      this.diagnosticLogger,
      async () => this.saveSettings(),
      this.createChatRuntimeSupport()
    );
    this.registerView(
      VIEW_TYPE_CODRIVER,
      (leaf) => new ChatView(leaf, this.chatController, this.diagnosticLogger)
    );

    this.addRibbonIcon("messages-square", "Open CoDriver", () => {
      void this.activateView();
    });

    this.addCommand({
      id: "open-codriver-chat",
      name: "Open CoDriver chat",
      callback: () => {
        void this.activateView();
      }
    });

    this.addCommand({
      id: "reload-codriver-skills",
      name: "Reload CoDriver skills",
      callback: () => {
        void this.reloadSkills(true);
      }
    });

    this.addCommand({
      id: "reload-codriver-commands",
      name: "Reload CoDriver commands",
      callback: () => { void this.reloadCommands(true); }
    });

    this.addCommand({
      id: "run-codriver-command",
      name: "Run command",
      callback: () => { void this.openCommandActionPicker(); }
    });

    this.addCommand({
      id: "run-codriver-command-instantly",
      name: "Run command instantly",
      callback: () => { void this.openCommandActionPicker({ instant: true }); }
    });

    this.addSettingTab(new CoDriverSettingTab(this.app, this));
    this.app.workspace.onLayoutReady(() => {
      this.workspaceInitializationPromise = this.initializeAfterLayoutReady();
      return this.workspaceInitializationPromise;
    });
  }

  onunload() {
    this.commandActionModal?.close?.();
    this.commandActionModal = null;
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_CODRIVER);
  }

  createChatRuntimeSupport(overrides = {}) {
    return {
      getPlatform: () => Platform.isMobile ? "mobile" : "desktop",
      isStdioMcpSupported: () => this.isStdioMcpSupported(),
      getStdioMcpUnavailableMessage: () => this.getStdioMcpUnavailableMessage(),
      ...overrides
    };
  }

  async openCommandActionPicker(options = {}) {
    if (this.commandActionModal) {
      new Notice("A CoDriver command session is already open.");
      return;
    }

    await this.reloadCommands(false);
    const instant = options.instant === true;
    const commands = filterCommandActionChoices(this.chatController.getCommandChoices(), { instant });
    if (commands.length === 0) {
      new Notice(instant
        ? "No enabled CoDriver commands without a text placeholder are available."
        : "No enabled CoDriver commands are available.");
      return;
    }

    new CommandActionPickerModal(this.app, commands, async (command) => {
      await this.openCommandActionModal(command, { instant });
    }, {
      placeholder: instant ? "Run command instantly" : "Run command"
    }).open();
  }

  async openCommandActionModal(command, options = {}) {
    if (this.commandActionModal) {
      new Notice("A CoDriver command session is already open.");
      return;
    }

    const diagnostics = this.diagnosticLogger?.createSessionScope?.() ?? this.diagnosticLogger;
    const controller = new ChatController(
      this.app,
      this.settings,
      this.providerRegistry,
      this.sessionStorage,
      diagnostics,
      async () => this.saveSettings(),
      this.createChatRuntimeSupport({ sessionMode: COMMAND_ACTION_SESSION_MODE })
    );
    controller.loadCommands(this.chatController.commands);
    const selectedCommand = controller.getCommandChoices().find((item) => item.id === command?.id);
    if (!selectedCommand) {
      new Notice("The selected command is unavailable. Reload commands and try again.");
      return;
    }
    controller.configureCommandActionContext(selectedCommand);

    const instant = options.instant === true;
    if (instant && selectedCommand.requiresText) {
      new Notice("Commands with a text placeholder cannot run instantly.");
      return;
    }
    if (instant && !controller.getSelectedModelId()) {
      new Notice("Select a visible chat model before running a command instantly.");
      return;
    }
    if (instant && selectedCommand.requiresActiveNote && !controller.getActiveNotePathContextForRequest().path) {
      new Notice("This command requires an active Markdown note.");
      return;
    }

    const modal = new CommandActionModal(
      this.app,
      controller,
      selectedCommand,
      diagnostics,
      () => {
        if (this.commandActionModal === modal) this.commandActionModal = null;
      },
      { instant }
    );
    this.commandActionModal = modal;
    modal.open();
  }

  async loadSettings() {
    const savedSettings = await this.loadData();
    const needsMaxMcpToolsMigration = Boolean(savedSettings) && !Object.prototype.hasOwnProperty.call(
      savedSettings,
      "maxMcpTools"
    );
    const needsSkillFolderPathMigration = Boolean(savedSettings) && !Object.prototype.hasOwnProperty.call(
      savedSettings,
      "skillFolderPath"
    );
    const needsAudioTranscriptionMigration = Boolean(savedSettings) && !Object.prototype.hasOwnProperty.call(
      savedSettings,
      "audioTranscription"
    );
    const needsVaultAudioConsentMigration = Boolean(savedSettings) &&
      savedSettings.codriverVaultToolSettings?.[CODRIVER_VAULT_TRANSCRIBE_AUDIO_TOOL_NAME]?.autoConsentVersion !== VAULT_AUDIO_AUTO_CONSENT_VERSION;
    const needsHiddenSkillFolderPathMigration = normalizeSkillFolderPath(
      savedSettings?.skillFolderPath ?? DEFAULT_SKILL_FOLDER_PATH
    ) === LEGACY_HIDDEN_SKILL_FOLDER_PATH;
    this.settings = normalizeSettings({
      ...cloneDefaultSettings(),
      ...(savedSettings ?? {})
    });

    if (
      (
        hasPersistedApiKey(savedSettings) ||
        needsAudioTranscriptionMigration ||
        needsVaultAudioConsentMigration ||
        needsMaxMcpToolsMigration ||
        needsSkillFolderPathMigration ||
        needsHiddenSkillFolderPathMigration
      ) &&
      typeof this.saveData === "function"
    ) {
      await this.saveData(createPersistableSettings(this.settings));
    }
  }

  async saveSettings() {
    this.settings = normalizeSettings(this.settings);
    await this.saveData(createPersistableSettings(this.settings));
    this.registerProviders();
    this.chatController?.updateSettings(this.settings, this.providerRegistry);
    await this.diagnosticLogger?.refresh();
    this.refreshChatViews();
  }

  getDiagnosticLogPath() {
    return this.diagnosticLogger?.getCurrentLogPath() ?? "";
  }

  async readDiagnosticLogForSharing() {
    if (!this.diagnosticLogger) {
      return {
        ok: false,
        reason: "unavailable",
        path: "",
        content: ""
      };
    }

    return this.diagnosticLogger.readCurrentLog();
  }

  async restoreStartupSession() {
    if (
      this.settings.enableSessionHistory === false ||
      this.settings.sessionStartupBehavior !== "last"
    ) {
      return;
    }

    await this.chatController?.restoreLatestSavedSession();
  }

  async initializeAfterLayoutReady() {
    try {
      await this.reloadSkills(false);
      await this.reloadCommands(false);
      await this.restoreStartupSession();
    } catch {
      // Workspace initialization is best-effort and must not block the plugin UI.
    }
    this.refreshChatViews();
  }

  getStdioMcpRuntimeSupport() {
    return getStdioMcpRuntimeSupport();
  }

  isStdioMcpSupported() {
    return this.getStdioMcpRuntimeSupport().supported === true;
  }

  getStdioMcpUnavailableMessage() {
    const support = this.getStdioMcpRuntimeSupport();
    return support.message || STDIO_MCP_UNAVAILABLE_MESSAGE;
  }

  isMcpServerRuntimeBlocked(server) {
    return server?.transport === MCP_STDIO_TRANSPORT && !this.isStdioMcpSupported();
  }

  createProviderDraft(type = OPENAI_PROVIDER_TYPE) {
    const providerType = normalizeProviderType(type);
    const existingOfType = this.settings.providers.filter((provider) => provider.type === providerType).length;
    const provider = createProviderSettings(providerType, this.createUniqueProviderId(providerType));

    if (existingOfType > 0) {
      provider.name = `${provider.name} ${existingOfType + 1}`;
    }

    return provider;
  }

  createMcpServerDraft() {
    const server = createMcpServerSettings(this.createUniqueMcpServerId());
    const count = this.settings.mcpServers.length + 1;
    server.name = count > 1 ? `MCP server ${count}` : server.name;
    if (!this.isStdioMcpSupported()) {
      server.transport = MCP_HTTP_TRANSPORT;
    }
    return server;
  }

  async addProvider(type) {
    const provider = await this.saveProviderDraft(this.createProviderDraft(type));

    return provider;
  }

  async saveProviderDraft(draft) {
    const existing = this.getProviderSettings(draft?.id);
    const providerType = normalizeProviderType(draft?.type);
    const id = existing?.id ?? this.createUniqueProviderId(providerType);
    const wasSelected = this.settings.selectedProviderId === existing?.id;
    const hadEnabledProvider = this.settings.providers.some((provider) => provider.enabled !== false);
    const provider = normalizeProviderSettings({
      ...draft,
      id
    }, this.settings.providers.length);

    if (existing) {
      Object.assign(existing, provider);
    } else {
      this.settings.providers.push(provider);
    }

    if (wasSelected || (!existing && !hadEnabledProvider && provider.enabled !== false)) {
      this.settings.selectedProviderId = provider.id;
      this.settings.selectedModelId = provider.model || null;
    }

    await this.saveSettings();

    return provider;
  }

  async saveMcpServerDraft(draft) {
    const existing = this.getMcpServerSettings(draft?.id);
    const id = existing?.id ?? this.createUniqueMcpServerId();
    if (draft?.transport === MCP_STDIO_TRANSPORT && !this.isStdioMcpSupported()) {
      throw new Error(this.getStdioMcpUnavailableMessage());
    }
    const server = normalizeMcpServerSettings({
      ...draft,
      id
    }, this.settings.mcpServers.length);

    if (existing) {
      Object.assign(existing, server);
    } else {
      this.settings.mcpServers.push(server);
    }

    await this.saveSettings();

    return server;
  }

  createUniqueProviderId(type) {
    const providerType = normalizeProviderType(type);
    let count = this.settings.providers.filter((provider) => provider.type === providerType).length + 1;
    let id = createProviderId(providerType, count);

    while (this.getProviderSettings(id)) {
      count += 1;
      id = createProviderId(providerType, count);
    }

    return id;
  }

  createUniqueMcpServerId() {
    let count = this.settings.mcpServers.length + 1;
    let id = `mcp-server-${count}`;

    while (this.getMcpServerSettings(id)) {
      count += 1;
      id = `mcp-server-${count}`;
    }

    return id;
  }

  async updateProviderSettings(providerId, update) {
    const provider = this.getProviderSettings(providerId);
    if (!provider) {
      return;
    }

    const nextType = update?.type ? normalizeProviderType(update.type) : provider.type;
    const typeChanged = nextType !== provider.type;
    const nextDefaults = createProviderSettings(nextType, provider.id);

    Object.assign(provider, update, {
      type: nextType
    });

    if (typeChanged) {
      provider.name = nextDefaults.name;
      provider.endpoint = nextDefaults.endpoint;
      provider.apiVersion = nextDefaults.apiVersion;
      provider.temperature = nextDefaults.temperature;
      provider.maxOutputTokens = nextDefaults.maxOutputTokens;
      provider.model = "";
      provider.models = [];
      provider.hiddenModels = [];
      provider.apiKeySecretName = "";
      provider.enablePromptCaching = nextDefaults.enablePromptCaching;
      provider.promptCacheTtl = nextDefaults.promptCacheTtl;
    }

    await this.saveSettings();
  }

  async updateMcpServerSettings(serverId, update) {
    const server = this.getMcpServerSettings(serverId);
    if (!server) {
      return;
    }

    const nextTransport = update?.transport ?? server.transport;
    if (nextTransport === MCP_STDIO_TRANSPORT && update?.enabled === true && !this.isStdioMcpSupported()) {
      return;
    }

    if (update?.transport === MCP_STDIO_TRANSPORT && !this.isStdioMcpSupported()) {
      return;
    }

    Object.assign(server, update);
    await this.saveSettings();
  }

  getLoadedSkillsForSettings() {
    return this.chatController?.getSkillsForSettings() ?? [];
  }

  getLoadedCommandsForSettings() {
    return this.chatController?.getCommandsForSettings() ?? [];
  }

  async updateCommandSettings(commandId, update) {
    const id = String(commandId ?? "").trim().toLowerCase();
    if (!id || !Object.prototype.hasOwnProperty.call(update ?? {}, "enabled")) return;
    this.settings.commandSettings ??= {};
    this.settings.commandSettings[id] = { enabled: update.enabled !== false };
    await this.saveSettings();
    this.chatController.loadCommands(this.chatController.commands);
  }

  async updateCommandFolderPath(value) {
    const nextPath = validateCommandFolderPath(value);
    const candidate = new CommandFolderLoader(this.app, nextPath);
    await candidate.ensureDirectory();
    const previousPath = this.settings.commandFolderPath;
    const previousLoader = this.commandFolderLoader;
    this.settings.commandFolderPath = nextPath;
    this.commandFolderLoader = candidate;
    try { await this.saveSettings(); }
    catch (error) { this.settings.commandFolderPath = previousPath; this.commandFolderLoader = previousLoader; throw error; }
    return this.reloadCommands(false);
  }

  async openCommandFile(path, newLeaf = true) {
    const file = this.commandFolderLoader.getCommandFile(path);
    const workspace = this.app.workspace;
    const leaf = workspace?.getLeaf?.(newLeaf ? "tab" : false);
    if (leaf?.openFile) { await leaf.openFile(file); workspace?.revealLeaf?.(leaf); return { opened: true, path: file.path }; }
    if (workspace?.openLinkText) { await workspace.openLinkText(file.path, "", newLeaf === true); return { opened: true, path: file.path }; }
    throw new Error("Obsidian workspace file opening API is not available.");
  }

  async createUserCommand(name) {
    const existing = this.getLoadedCommandsForSettings().find((command) => command.id === String(name ?? "").toLowerCase());
    if (existing) throw createDuplicateCommandError(name, existing.sourcePath);
    const created = await this.commandFolderLoader.createCommand(name);
    return { ...created, reloadResult: await this.reloadCommands(false) };
  }

  async updateSkillSettings(skillId, update) {
    const normalizedSkillId = String(skillId || "").trim();
    if (!normalizedSkillId || !this.chatController?.skillRegistry.get(normalizedSkillId)) {
      return;
    }

    if (!Object.prototype.hasOwnProperty.call(update ?? {}, "enabled")) {
      return;
    }

    this.settings.skillSettings ??= {};
    this.settings.skillSettings[normalizedSkillId] = {
      enabled: update.enabled !== false
    };
    await this.saveSettings();
  }

  async updateSkillFolderPath(value) {
    const nextPath = validateSkillFolderPath(value);
    const candidateLoader = new SkillFolderLoader(this.app, nextPath);
    await candidateLoader.ensureDirectory();

    const previousPath = this.settings.skillFolderPath;
    const previousLoader = this.skillFolderLoader;
    this.settings.skillFolderPath = nextPath;
    this.skillFolderLoader = candidateLoader;
    try {
      await this.saveSettings();
    } catch (error) {
      this.settings.skillFolderPath = previousPath;
      this.skillFolderLoader = previousLoader;
      throw error;
    }

    return this.reloadSkills(false);
  }

  async openSkillFile(path, newLeaf = true) {
    const file = this.skillFolderLoader.getSkillFile(path);
    const workspace = this.app.workspace;
    const leaf = workspace?.getLeaf?.(newLeaf ? "tab" : false);
    if (leaf?.openFile) {
      await leaf.openFile(file);
      workspace?.revealLeaf?.(leaf);
      return { opened: true, path: file.path };
    }
    if (workspace?.openLinkText) {
      await workspace.openLinkText(file.path, "", newLeaf === true);
      return { opened: true, path: file.path };
    }
    throw new Error("Obsidian workspace file opening API is not available.");
  }

  async createUserSkill(name) {
    const existing = this.getLoadedSkillsForSettings().find((skill) => skill.id === name);
    if (existing) {
      throw createDuplicateSkillError(name, existing.sourcePath);
    }

    const created = await this.skillFolderLoader.createSkill(name);
    const reloadResult = await this.reloadSkills(false);
    return {
      ...created,
      reloadResult
    };
  }

  async updateMcpToolSettings(serverId, toolName, update) {
    if (serverId === CODRIVER_VAULT_SERVER_ID) {
      if (!CODRIVER_VAULT_TOOL_NAMES.includes(toolName)) {
        return;
      }

      this.settings.codriverVaultToolSettings ??= {};
      const current = this.settings.codriverVaultToolSettings[toolName] ?? {};
      const next = {
        ...current
      };
      let changed = false;
      if (
        toolName !== CODRIVER_VAULT_TRANSCRIBE_AUDIO_TOOL_NAME &&
        Object.prototype.hasOwnProperty.call(update ?? {}, "enabled")
      ) {
        next.enabled = update.enabled !== false;
        changed = true;
      }
      if (
        CODRIVER_VAULT_CONFIGURABLE_AUTO_TOOL_NAMES.includes(toolName) &&
        Object.prototype.hasOwnProperty.call(update ?? {}, "allowAutomaticExecution")
      ) {
        next.allowAutomaticExecution = update.allowAutomaticExecution === true;
        if (toolName === CODRIVER_VAULT_TRANSCRIBE_AUDIO_TOOL_NAME) {
          next.autoConsentVersion = VAULT_AUDIO_AUTO_CONSENT_VERSION;
        }
        changed = true;
      }
      if (!changed) {
        return;
      }
      this.settings.codriverVaultToolSettings[toolName] = next;
      await this.saveSettings();
      return;
    }

    const server = this.getMcpServerSettings(serverId);
    if (!server || !Array.isArray(server.tools)) {
      return;
    }

    if (this.isMcpServerRuntimeBlocked(server)) {
      return;
    }

    const tool = server.tools.find((item) => item.name === toolName);
    if (!tool) {
      return;
    }

    Object.assign(tool, update);
    await this.saveSettings();
  }

  async updateMcpToolsEnabled(serverId, toolNames, enabled) {
    const requestedToolNames = new Set(normalizeStringArray(toolNames));
    if (requestedToolNames.size === 0) {
      return;
    }

    const nextEnabled = enabled !== false;
    let changed = false;
    if (serverId === CODRIVER_VAULT_SERVER_ID) {
      this.settings.codriverVaultToolSettings ??= {};
      for (const toolName of CODRIVER_VAULT_TOOL_NAMES) {
        if (
          toolName === CODRIVER_VAULT_TRANSCRIBE_AUDIO_TOOL_NAME ||
          !requestedToolNames.has(toolName)
        ) {
          continue;
        }

        const current = this.settings.codriverVaultToolSettings[toolName] ?? { enabled: true };
        if (current.enabled !== nextEnabled) {
          this.settings.codriverVaultToolSettings[toolName] = {
            ...current,
            enabled: nextEnabled
          };
          changed = true;
        }
      }
    } else {
      const server = this.getMcpServerSettings(serverId);
      if (!server || !Array.isArray(server.tools) || this.isMcpServerRuntimeBlocked(server)) {
        return;
      }

      for (const tool of server.tools) {
        if (!requestedToolNames.has(tool.name) || tool.available === false) {
          continue;
        }

        if (tool.enabled !== nextEnabled) {
          tool.enabled = nextEnabled;
          changed = true;
        }
      }
    }

    if (changed) {
      await this.saveSettings();
    }
  }

  async selectProviderModel(providerId, modelId) {
    const provider = this.getProviderSettings(providerId);
    if (!provider) {
      return;
    }

    provider.model = modelId;
    this.settings.selectedProviderId = provider.id;
    this.settings.selectedModelId = modelId;
    await this.saveSettings();
  }

  async updateAudioTranscriptionSettings(update) {
    const current = normalizeAudioTranscriptionSettings(this.settings.audioTranscription);
    const next = normalizeAudioTranscriptionSettings({
      ...current,
      ...(update ?? {})
    });
    const validation = resolveAudioTranscriptionSelection({
      ...this.settings,
      audioTranscription: next
    }, {
      requireEnabled: false
    });
    if (next.enabled && !validation.ok) {
      return validation;
    }

    this.settings.audioTranscription = next;
    await this.saveSettings();
    return {
      ok: true,
      ...next
    };
  }

  async selectProvider(providerId) {
    const provider = this.getProviderSettings(providerId);
    if (!provider) {
      return;
    }

    provider.enabled = true;
    this.settings.selectedProviderId = provider.id;
    this.settings.selectedModelId = getPreferredVisibleProviderModel(provider);
    await this.saveSettings();
  }

  async removeProvider(providerId) {
    const provider = this.getProviderSettings(providerId);
    if (!provider) {
      return;
    }

    this.settings.providers = this.settings.providers.filter((item) => item.id !== providerId);
    if (this.settings.selectedProviderId === providerId) {
      const nextProvider = this.settings.providers.find((item) => item.enabled !== false);
      this.settings.selectedProviderId = nextProvider?.id ?? null;
      this.settings.selectedModelId = nextProvider?.model || null;
    }

    await this.saveSettings();
  }

  async removeMcpServer(serverId) {
    const server = this.getMcpServerSettings(serverId);
    if (!server) {
      return;
    }

    this.settings.mcpServers = this.settings.mcpServers.filter((item) => item.id !== serverId);
    await this.saveSettings();
  }

  async discoverMcpServerTools(serverId) {
    const server = this.getMcpServerSettings(serverId);
    if (!server) {
      return {
        ok: false,
        message: "MCP server is not configured.",
        tools: []
      };
    }

    if (this.isMcpServerRuntimeBlocked(server)) {
      return {
        ok: false,
        message: this.getStdioMcpUnavailableMessage(),
        tools: server.tools ?? []
      };
    }

    if (server.transport === MCP_STDIO_TRANSPORT && !server.command) {
      return {
        ok: false,
        message: "Set an MCP stdio command before discovering tools.",
        tools: server.tools ?? []
      };
    }

    if (server.transport === MCP_HTTP_TRANSPORT && !server.endpoint) {
      return {
        ok: false,
        message: "Set an MCP HTTP endpoint before discovering tools.",
        tools: server.tools ?? []
      };
    }

    try {
      const Client = server.transport === MCP_STDIO_TRANSPORT
        ? McpStdioClient
        : McpHttpClient;
      const client = new Client(server, {
        diagnostics: this.diagnosticLogger
      });
      const discoveredTools = await client.discoverTools();
      server.tools = mergeDiscoveredMcpTools(server.tools, discoveredTools);
      await this.saveSettings();

      return {
        ok: true,
        message: `Discovered ${server.tools.length} MCP tool(s).`,
        tools: server.tools
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unknown MCP discovery error.";
      return {
        ok: false,
        message: `Unable to discover MCP tools. ${detail}`,
        tools: server.tools ?? []
      };
    }
  }

  async discoverProviderModels(providerId) {
    const providerSettings = this.getProviderSettings(providerId);
    if (!providerSettings) {
      return {
        ok: false,
        message: "Provider is not configured.",
        models: []
      };
    }

    if (!providerSettings.endpoint) {
      return {
        ok: false,
        message: "Set a provider endpoint before loading models.",
        models: []
      };
    }

    try {
      const provider = this.createProvider(providerSettings);
      const models = await provider.listModels();
      providerSettings.models = models;

      if (models.length > 0) {
        const selectedModel = models.includes(providerSettings.model)
          ? providerSettings.model
          : models[0];

        providerSettings.model = selectedModel;
        this.settings.selectedProviderId = providerSettings.id;
        this.settings.selectedModelId = selectedModel;
      }

      await this.saveSettings();

      if (models.length === 0) {
        return {
          ok: false,
          message: "Connected to the provider, but no models were returned.",
          models
        };
      }

      return {
        ok: true,
        message: `Loaded ${models.length} model(s).`,
        models
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unknown model discovery error.";
      return {
        ok: false,
        message: `Unable to load models. ${detail}`,
        models: []
      };
    }
  }

  async testProviderConnection(providerId) {
    const providerSettings = this.getProviderSettings(providerId);
    if (!providerSettings) {
      return {
        ok: false,
        message: "Provider is not configured."
      };
    }

    if (!providerSettings.endpoint) {
      return {
        ok: false,
        message: "Set a provider endpoint before testing the connection."
      };
    }

    try {
      const provider = this.createProvider(providerSettings);
      const result = await provider.testConnection();
      providerSettings.models = result.models;
      if (result.models.length > 0) {
        const selectedModel = result.models.includes(providerSettings.model)
          ? providerSettings.model
          : result.models[0];

        providerSettings.model = selectedModel;
        this.settings.selectedProviderId = providerSettings.id;
        this.settings.selectedModelId = selectedModel;
      }
      await this.saveSettings();

      const modelText = `Model list endpoint responded with ${result.modelCount} model(s).`;

      return {
        ok: true,
        message: `Connected to the provider. ${modelText}`
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unknown connection error.";
      return {
        ok: false,
        message: `Unable to connect to the provider. ${detail}`
      };
    }
  }

  async testProviderDraftConnection(draft) {
    const providerSettings = normalizeProviderSettings({
      ...draft,
      id: draft?.id || "provider-draft"
    }, 0);

    if (!providerSettings.endpoint) {
      return {
        ok: false,
        message: "Set a provider endpoint before testing the connection.",
        models: []
      };
    }

    try {
      const provider = this.createProvider(providerSettings);
      const result = await provider.testConnection();
      const modelText = `Model list endpoint responded with ${result.modelCount} model(s).`;

      return {
        ok: true,
        message: `Connected to the provider. ${modelText}`,
        models: result.models
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unknown connection error.";
      return {
        ok: false,
        message: `Unable to connect to the provider. ${detail}`,
        models: []
      };
    }
  }

  getProviderSettings(providerId) {
    return this.settings.providers.find((item) => item.id === providerId);
  }

  getMcpServerSettings(serverId) {
    return this.settings.mcpServers.find((item) => item.id === serverId);
  }

  registerProviders() {
    this.providerRegistry.clear();

    for (const providerSettings of this.settings.providers) {
      if (providerSettings.enabled === false) {
        continue;
      }

      const provider = this.createProvider(providerSettings);
      if (provider) {
        this.providerRegistry.register(provider);
      }
    }
  }

  refreshChatViews() {
    const leaves = this.app.workspace.getLeavesOfType?.(VIEW_TYPE_CODRIVER) ?? [];
    for (const leaf of leaves) {
      leaf.view?.render?.();
    }
  }

  createProvider(providerSettings) {
    if (providerSettings.type === ANTHROPIC_PROVIDER_TYPE) {
      return new AnthropicProvider(providerSettings, {
        secretStorage: this.app.secretStorage,
        diagnostics: this.diagnosticLogger
      });
    }

    if (providerSettings.type === GEMINI_PROVIDER_TYPE) {
      return new GeminiProvider(providerSettings, {
        secretStorage: this.app.secretStorage,
        diagnostics: this.diagnosticLogger
      });
    }

    if (providerSettings.type === OPENAI_PROVIDER_TYPE) {
      return new OpenAiCompatibleProvider(providerSettings, {
        secretStorage: this.app.secretStorage,
        diagnostics: this.diagnosticLogger
      });
    }

    return null;
  }

  async reloadSkills(showNotice = true) {
    let sources = [];
    const errors = [];
    try {
      const loadResult = await this.skillFolderLoader.loadSkillSources();
      if (Array.isArray(loadResult)) {
        sources = loadResult;
      } else {
        sources = Array.isArray(loadResult?.sources) ? loadResult.sources : [];
        errors.push(...(Array.isArray(loadResult?.errors) ? loadResult.errors : []));
      }
    } catch (error) {
      errors.push({
        path: this.skillFolderLoader.getDirectory(),
        message: error instanceof Error ? error.message : "Unknown user skill load error."
      });
    }

    const result = this.chatController.loadExternalSkillSources(sources);
    result.errors.push(...errors);
    this.skillReloadResult = result;
    if (showNotice) {
      new Notice(createSkillReloadMessage(result));
    }
    return result;
  }

  async reloadCommands(showNotice = true) {
    let commands = [];
    const errors = [];
    try {
      const result = await this.commandFolderLoader.loadCommands();
      commands = result.commands;
      errors.push(...result.errors);
    } catch (error) {
      errors.push({ path: this.commandFolderLoader.getDirectory(), message: error instanceof Error ? error.message : "Unknown command load error." });
    }
    const loaded = this.chatController.loadCommands(commands);
    const result = { loaded, errors };
    this.commandReloadResult = result;
    if (showNotice) new Notice(errors.length ? `Loaded ${loaded.length} commands. ${errors.length} command(s) failed.` : `Loaded ${loaded.length} commands`);
    this.refreshChatViews();
    return result;
  }

  async activateView() {
    const existingLeaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_CODRIVER);
    if (existingLeaves.length > 0) {
      this.app.workspace.revealLeaf(existingLeaves[0]);
      return;
    }

    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) {
      new Notice("Unable to open CoDriver.");
      return;
    }

    await leaf.setViewState({
      type: VIEW_TYPE_CODRIVER,
      active: true
    });

    this.app.workspace.revealLeaf(leaf);
  }
}

module.exports = CoDriverPlugin;

function createSkillReloadMessage(result) {
  if (result.errors.length > 0) {
    return `Loaded ${result.loaded.length} skills. ${formatSkillErrors(result.errors)}`;
  }

  return `Loaded ${result.loaded.length} skills`;
}

function formatSkillErrors(errors) {
  const firstError = errors[0];
  if (!firstError) {
    return "";
  }

  return `${errors.length} skill(s) failed. First error: ${firstError.path}: ${firstError.message}`;
}
