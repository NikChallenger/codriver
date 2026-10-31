const { McpCredentialError } = require("../mcp/McpCredentials");
const { DirectApiAccess, normalizeDirectPluginApiSettings } = require("../vault/VaultReader");
const { McpOAuthError } = require("../mcp/McpOAuthProtocol");
const { ProviderCredentialError } = require("./ProviderCredentials");
const { renderSecretInput } = require("./SecretInput");
const { OPENAI_COMPATIBLE_PRESETS, getOpenAiCompatibleEndpointError, getOpenAiCompatiblePresetUpdate } = require("./defaults");
const { McpCommandError, formatMcpCommand, parseMcpCommand } = require("./McpServerForm");
const { Modal, Notice, Platform, PluginSettingTab, Setting, setIcon } = require("obsidian");
const {
  ANTHROPIC_PROVIDER_TYPE,
  DEFAULT_GEMINI_API_VERSION,
  GEMINI_PROVIDER_TYPE,
  MCP_HTTP_TRANSPORT,
  MCP_STDIO_TRANSPORT,
  OPENAI_PROVIDER_TYPE
} = require("../constants");
const {
  CODRIVER_VAULT_TRANSCRIBE_AUDIO_TOOL_NAME,
  CODRIVER_API_CALL_TOOL_NAME,
  TEXT_DOCUMENT_MUTATION_TOOLS,
  createCodriverVaultMcpServer
} = require("../mcp/CodriverVaultMcpServer");
const {
  AUDIO_TRANSCRIPTION_TOOLTIP,
  decodeAudioTranscriptionSelection,
  encodeAudioTranscriptionSelection,
  getAudioTranscriptionModelChoices,
  isProviderModelDisabled,
  normalizeAudioTranscriptionSettings,
  normalizeVoiceInputSettings,
  resolveVoiceInputSelection,
  resolveAudioTranscriptionSelection
} = require("./AudioTranscriptionSettings");
const {
  DEFAULT_SKILL_FOLDER_PATH,
  normalizeSkillFolderPath
} = require("../skills/SkillFolderLoader");
const {
  DEFAULT_COMMAND_FOLDER_PATH,
  normalizeCommandFolderPath
} = require("../commands/CommandFolderLoader");
const { getBulkSelectionState } = require("../ui/BulkSelection");
const { bindModelPicker } = require("../views/ModelPickerPopover");
const { RemovalConfirmationModal } = require("../views/RemovalConfirmationModal");
const {
  canShareDiagnosticLogFile,
  copyDiagnosticLog,
  createDiagnosticLogFile,
  startDiagnosticLogFileShare
} = require("../diagnostics/DiagnosticLogSharing");

const PROVIDER_TYPE_OPTIONS = [
  { value: OPENAI_PROVIDER_TYPE, label: "OpenAI" },
  { value: GEMINI_PROVIDER_TYPE, label: "Gemini" },
  { value: ANTHROPIC_PROVIDER_TYPE, label: "Anthropic" }
];

const MCP_TOOL_LIMIT_FIELDS = [
  {
    key: "maxMcpTools",
    label: "Max tools",
    fallback: 45,
    min: 0,
    max: 200,
    ariaLabel: "Maximum model-facing MCP tools",
    description: "Warn before a request exposes more MCP tools than this value. Continue sends all available tools for that request. 0 means Unlimited."
  },
  {
    key: "maxAutomaticMcpToolCalls",
    label: "Max calls",
    fallback: 10,
    min: 1,
    max: 20,
    ariaLabel: "Maximum automatic MCP tool calls",
    description: "Maximum MCP tool calls CoDriver may run automatically while completing one user request."
  },
  {
    key: "maxMcpToolResultChars",
    label: "Output chars",
    fallback: 60000,
    min: 1000,
    max: 240000,
    ariaLabel: "Maximum MCP tool result characters",
    description: "Warn before one MCP tool result above this size is sent to the model. Continue sends the complete result."
  },
  {
    key: "mcpToolTimeoutSeconds",
    label: "Timeout, sec",
    fallback: 60,
    min: 5,
    max: 600,
    ariaLabel: "MCP tool timeout seconds",
    description: "Maximum time CoDriver waits for one MCP tool call before marking it as failed."
  }
];

const SETTINGS_PAGE_DEFINITIONS = [
  {
    id: "providers",
    title: "Providers",
    description: "Configure language models and audio transcription.",
    renderMethod: "renderProviderSettings"
  },
  {
    id: "mcp",
    title: "MCP",
    description: "Manage MCP servers, tool permissions, and request limits.",
    renderMethod: "renderMcpSettings"
  },
  {
    id: "skills",
    title: "Skills & Commands",
    description: "Manage vault-local skills and prompt commands.",
    renderMethod: "renderUserSkillsSettings"
  }
];

const SETTINGS_PAGE_DEFINITION_MAP = new Map(
  SETTINGS_PAGE_DEFINITIONS.map((definition) => [definition.id, definition])
);

class CoDriverSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
    this.openProviderModelIds = new Set();
    this.providerModelQueries = new Map();
    this.openMcpToolServerIds = new Set();
    this.directApiPluginsOpen = false;
    this.skillListOpen = false;
    this.commandListOpen = false;
    this.discoveringMcpServerIds = new Set();
    this.pendingAudioTranscriptionEnable = false;
    this.activeSettingsPageId = null;
    this.settingsIndexScrollTop = 0;
    this.settingsPageScrollTops = new Map();
    this.pendingSettingsNavigation = null;
  }

  display() {
    this.modelPickerPopover?.close();
    const { containerEl } = this;
    const navigation = this.pendingSettingsNavigation;
    if (!navigation) {
      this.rememberCurrentSettingsScroll();
    }

    containerEl.empty();
    containerEl.addClass("codriver-settings-navigation-root");

    const pageEl = containerEl.createDiv({ cls: "codriver-settings-navigation-page" });
    if (navigation?.direction) {
      pageEl.addClass(`is-${navigation.direction}`);
    }

    const definition = SETTINGS_PAGE_DEFINITION_MAP.get(this.activeSettingsPageId);
    let focusTarget = null;
    if (definition) {
      focusTarget = this.renderSettingsChildPage(pageEl, definition);
    } else {
      this.activeSettingsPageId = null;
      focusTarget = this.renderSettingsIndex(pageEl, navigation?.returnPageId ?? null);
    }

    const scrollTop = definition
      ? this.settingsPageScrollTops.get(definition.id) ?? 0
      : this.settingsIndexScrollTop;
    this.pendingSettingsNavigation = null;
    if (focusTarget && navigation?.focusTarget) {
      try {
        focusTarget.focus({ preventScroll: true });
      } catch {
        focusTarget.focus?.();
      }
    }
    containerEl.scrollTop = scrollTop;
  }

  rememberCurrentSettingsScroll() {
    const scrollTop = Number(this.containerEl?.scrollTop) || 0;
    if (this.activeSettingsPageId) {
      this.settingsPageScrollTops.set(this.activeSettingsPageId, scrollTop);
      return;
    }

    this.settingsIndexScrollTop = scrollTop;
  }

  hide() {
    this.modelPickerPopover?.close();
    this.removalConfirmationModal?.close();
  }

  confirmRemoval(kind, entry, remove) {
    if (this.removalConfirmationModal) return;
    let review;
    try { review = this.plugin.prepareConnectionRemoval(kind, entry.id); }
    catch { new Notice("Unable to review this connection. Refresh Settings and retry."); return; }
    const modal = new RemovalConfirmationModal(this.app, {
      kind,
      name: entry.name || entry.id,
      secretName: review.secretName,
      shared: review.shared,
      onDelete: async (removeSecret, signal) => {
        const result = await remove(entry.id, { review, removeSecret, signal });
        this.display();
        return result;
      },
      onRetry: async (signal) => {
        const result = await this.plugin.applyConnectionRemoval(review, true, true, signal);
        this.display();
        return result;
      },
      onClosed: () => {
        this.plugin.forgetConnectionRemoval?.(review);
        if (this.removalConfirmationModal === modal) this.removalConfirmationModal = null;
      }
    });
    this.removalConfirmationModal = modal;
    modal.open();
  }

  renderSettingsIndex(containerEl, returnPageId = null) {
    containerEl.createEl("h2", { text: "CoDriver Settings" });

    let returnFocusTarget = null;
    for (const definition of SETTINGS_PAGE_DEFINITIONS) {
      const row = containerEl.createEl("button", {
        cls: "codriver-settings-index-row",
        attr: {
          type: "button",
          "aria-label": definition.title,
          "data-settings-page": definition.id
        }
      });
      const text = row.createSpan({ cls: "codriver-settings-index-row-text" });
      text.createSpan({ cls: "codriver-settings-index-row-title", text: definition.title });
      text.createSpan({ cls: "codriver-settings-index-row-description", text: definition.description });
      const chevron = row.createSpan({
        cls: "codriver-settings-index-row-chevron",
        attr: { "aria-hidden": "true" }
      });
      setIcon(chevron, "chevron-right");
      row.addEventListener("click", () => this.openSettingsPage(definition.id));
      if (definition.id === returnPageId) {
        returnFocusTarget = row;
      }
    }

    this.renderActiveNoteContextSettings(containerEl);
    this.renderSessionHistorySettings(containerEl);
    this.renderDiagnosticLoggingSettings(containerEl);
    this.renderFeedbackLinks(containerEl);
    return returnFocusTarget;
  }

  renderFeedbackLinks(containerEl) {
    const footer = containerEl.createEl("footer", {
      cls: "codriver-settings-feedback-links",
      attr: { "aria-label": "CoDriver feedback links" }
    });
    const links = [
      {
        label: "Feedback",
        url: "https://tally.so/r/yXZZBx",
        icon: "message-square",
        description: "Feedback via Tally (opens externally)"
      },
      {
        label: "GitHub Issues",
        url: "https://github.com/NikChallenger/codriver/issues",
        icon: "github",
        description: "GitHub Issues (public; sign in to post; opens externally)"
      }
    ];
    for (const [index, definition] of links.entries()) {
      if (index > 0) {
        footer.createSpan({
          cls: "codriver-settings-feedback-divider",
          attr: { "aria-hidden": "true" }
        });
      }
      const link = footer.createEl("a", {
        cls: "codriver-settings-feedback-link",
        attr: {
          href: definition.url,
          target: "_blank",
          rel: "noopener noreferrer",
          title: definition.description,
          "aria-label": definition.description
        }
      });
      const icon = link.createSpan({ attr: { "aria-hidden": "true" } });
      setIcon(icon, definition.icon);
      link.createSpan({ text: definition.label });
      const external = link.createSpan({
        cls: "codriver-settings-feedback-external",
        attr: { "aria-hidden": "true" }
      });
      setIcon(external, "external-link");
    }
  }

  renderSettingsChildPage(containerEl, definition) {
    const titlebar = containerEl.createDiv({ cls: "codriver-settings-child-titlebar" });
    const backButton = titlebar.createEl("button", {
      cls: "clickable-icon codriver-settings-back-button",
      attr: {
        type: "button",
        title: "Back to CoDriver Settings",
        "aria-label": "Back to CoDriver Settings"
      }
    });
    setIcon(backButton, "chevron-left");
    backButton.addEventListener("click", () => this.returnToSettingsIndex());
    titlebar.createEl("h2", { text: definition.title });
    this[definition.renderMethod](containerEl);
    return backButton;
  }

  openSettingsPage(pageId) {
    if (!SETTINGS_PAGE_DEFINITION_MAP.has(pageId)) {
      return;
    }

    this.settingsIndexScrollTop = Number(this.containerEl?.scrollTop) || 0;
    this.activeSettingsPageId = pageId;
    this.settingsPageScrollTops.set(pageId, 0);
    this.pendingSettingsNavigation = {
      direction: "forward",
      focusTarget: "back"
    };
    this.display();
  }

  returnToSettingsIndex() {
    const returnPageId = this.activeSettingsPageId;
    if (!returnPageId) {
      return;
    }

    this.settingsPageScrollTops.set(
      returnPageId,
      Number(this.containerEl?.scrollTop) || 0
    );
    this.activeSettingsPageId = null;
    this.pendingSettingsNavigation = {
      direction: "back",
      focusTarget: "index-row",
      returnPageId
    };
    this.display();
  }

  renderProviderSettings(containerEl) {
    const providerHeader = this.renderSettingsSectionHeader(containerEl, "LLM providers");
    createIconButton(providerHeader, "plus", "Add model", () => {
      new ProviderSettingsModal(this.app, this.plugin, null, () => this.display()).open();
    }, "codriver-section-add-button");
    const providers = containerEl.createDiv({ cls: "codriver-provider-list" });
    for (const provider of this.plugin.settings.providers) {
      this.renderProviderCard(providers, provider);
    }

    if (this.plugin.settings.providers.length === 0) {
      providers.createDiv({
        cls: "codriver-setting-status",
        text: "No provider instances are configured."
      });
    }

    this.renderAudioTranscriptionSettings(containerEl);
  }

  renderMcpSettings(containerEl) {
    const mcpHeader = this.renderSettingsSectionHeader(containerEl, "MCP servers");
    createIconButton(mcpHeader, "plus", "Add MCP server", () => {
      new McpServerSettingsModal(this.app, this.plugin, null, () => this.display()).open();
    }, "codriver-section-add-button");
    const mcpServers = containerEl.createDiv({ cls: "codriver-provider-list" });
    const configuredMcpServers = Array.isArray(this.plugin.settings.mcpServers)
      ? this.plugin.settings.mcpServers
      : [];
    this.renderBuiltInMcpServerRow(mcpServers);
    for (const server of configuredMcpServers) {
      this.renderMcpServerRow(mcpServers, server);
    }

    if (configuredMcpServers.length === 0) {
      mcpServers.createDiv({
        cls: "codriver-setting-status",
        text: "No external MCP servers are configured."
      });
    }

    this.renderMcpToolLimitSettings(containerEl);
    this.renderDirectApiAccessSettings(containerEl);
  }

  renderDirectApiAccessSettings(containerEl) {
    const setting = new Setting(containerEl).setName("API access:");
    setting.settingEl.addClass("codriver-direct-api-setting");
    setting.infoEl.addClass("codriver-direct-api-heading");
    // Match MCP rows: checkbox inputs must not inherit the mobile Setting toggle layout.
    setting.controlEl.remove();
    const group = setting.settingEl.createDiv({ cls: "codriver-direct-api-controls" });
    const permission = this.plugin.settings.codriverVaultToolSettings?.[CODRIVER_API_CALL_TOOL_NAME];
    const status = setting.infoEl.createDiv({ cls: "codriver-direct-api-status", attr: { role: "status", "aria-live": "polite" } });
    const fields = group.createDiv({ cls: "codriver-direct-api-fields" });
    const enabled = this.plugin.settings.enableCoDriverVaultTools !== false && permission?.enabled !== false;
    const targets = [];
    if (this.plugin.settings.enableDirectObsidianApiAccess === true) targets.push("Obsidian");
    if (this.plugin.settings.enableDirectPluginApiAccess === true) targets.push("Plugin");
    status.textContent = " " + (!enabled ? "Tool disabled" : !targets.length ? "Both API targets are off"
      : `${targets.join(" + ")} API access`);
    setting.infoEl.createSpan({ cls: "codriver-api-experimental-badge codriver-direct-api-heading-badge", text: "Experimental" });
    for (const field of [
      { key: "enableDirectObsidianApiAccess", label: "Direct Obsidian API access", description: "Allow calls to additional Obsidian APIs. Existing specialized tools retain their own availability and permissions." },
      { key: "enableDirectPluginApiAccess", label: "Direct Plugin API access", description: "Allow calls to enabled third-party plugin APIs. Each plugin has its own Enabled and Auto permissions. Plugin methods can change files or use the network with the plugin's permissions; CoDriver proposal review does not cover their indirect effects." }
    ]) {
      const row = fields.createDiv({ cls: "codriver-direct-api-field" });
      row.createSpan({ text: field.label, attr: { title: field.description } });
      const controls = row.createDiv({ cls: "codriver-mcp-tool-controls" });
      const choices = [{ key: field.key, caption: "Enabled", description: field.description }];
      if (field.key === "enableDirectObsidianApiAccess") choices.push({ key: "allowAutomaticDirectObsidianApiAccess", caption: "Auto", description: "Allow these additional Obsidian API methods without confirmation." });
      for (const choice of choices) {
        const label = controls.createEl("label", { cls: "codriver-mcp-tool-permission" });
        const input = label.createEl("input", { cls: "codriver-provider-visibility", attr: { type: "checkbox", title: choice.description, "aria-label": `${field.label} ${choice.caption}` } });
        input.checked = this.plugin.settings[choice.key] === true;
        input.disabled = !enabled || (choice.caption === "Auto" && this.plugin.settings.enableDirectObsidianApiAccess !== true);
        if (input.disabled) label.addClass("is-disabled");
        label.createSpan({ text: choice.caption });
        input.addEventListener("change", async () => {
          this.plugin.settings[choice.key] = input.checked;
          await this.plugin.saveSettings();
          this.display();
        });
      }
    }
    this.renderDirectApiPlugins(fields, enabled);
  }

  renderDirectApiPlugins(container, toolEnabled) {
    const details = container.createEl("details", { cls: "codriver-mcp-tool-details codriver-api-plugins" });
    details.open = this.directApiPluginsOpen === true;
    details.createEl("summary", { cls: "codriver-mcp-tool-summary", text: "Plugins" });
    const list = details.createDiv({ cls: "codriver-mcp-tool-list" });
    const refresh = () => {
      list.empty();
      const app = this.app ?? this.plugin.app ?? {};
      if (!app.plugins?.plugins || typeof app.plugins.plugins !== "object") {
        list.createDiv({ text: "Plugin list unavailable." });
        return;
      }
      const access = new DirectApiAccess(app);
      let plugins;
      try { plugins = access.plugins(); } catch {
        list.createDiv({ text: "Plugin list unavailable. Reopen Plugins to retry." });
        return;
      }
      if (!plugins.length) list.createDiv({ text: "No loaded plugins." });
      for (const { id, instance } of plugins) {
        const row = list.createDiv({ cls: "codriver-mcp-tool-row" });
        const heading = row.createDiv({ cls: "codriver-mcp-tool-heading" });
        heading.createSpan({ cls: "codriver-mcp-tool-name", text: String(instance.manifest?.name || id).slice(0, 160) });
        const version = typeof instance.manifest?.version === "string" ? instance.manifest.version : "";
        heading.createSpan({ cls: "codriver-mcp-tool-protocol-name", text: version.slice(0, 80) });
        const current = this.plugin.settings.directPluginApiSettings?.[id] ?? { enabled: true };
        const controls = row.createDiv({ cls: "codriver-mcp-tool-controls" });
        const active = toolEnabled && this.plugin.settings.enableDirectPluginApiAccess === true;
        const inputs = {};
        for (const [key, caption] of [["enabled", "Enabled"], ["allowAutomaticExecution", "Auto"]]) {
          const label = controls.createEl("label", { cls: "codriver-mcp-tool-permission" });
          const input = label.createEl("input", { cls: "codriver-provider-visibility", attr: { type: "checkbox", "aria-label": `${caption} plugin ${id}` } });
          inputs[key] = input;
          input.checked = key === "enabled" ? current.enabled !== false : !!version && current.allowAutomaticExecution === true && current.autoVersion === version;
          input.disabled = !active || (key === "allowAutomaticExecution" && (current.enabled === false || !version || version.length > 80));
          if (input.disabled) label.addClass("is-disabled");
          label.createSpan({ text: caption });
          input.addEventListener("change", async () => {
            // Bind the grant to the exact displayed, still-loaded plugin version.
            const loaded = access.plugins().find((plugin) => plugin.id === id)?.instance;
            if (loaded !== instance || loaded?.manifest?.version !== version) { refresh(); return; }
            const permissions = normalizeDirectPluginApiSettings(this.plugin.settings.directPluginApiSettings);
            permissions[id] = {
              enabled: inputs.enabled.checked,
              allowAutomaticExecution: inputs.allowAutomaticExecution.checked,
              autoVersion: version
            };
            this.plugin.settings.directPluginApiSettings = normalizeDirectPluginApiSettings(permissions);
            await this.plugin.saveSettings();
            this.directApiPluginsOpen = true;
            this.display();
          });
        }
      }
    };
    details.addEventListener("toggle", () => {
      this.directApiPluginsOpen = details.open;
      if (details.open) refresh();
    });
    if (details.open) refresh();
  }

  renderActiveNoteContextSettings(containerEl) {
    const setting = new Setting(containerEl);
    setting.settingEl.addClass("codriver-active-note-context-setting");
    setting
      .setName("Automatically include active note path to the chat context")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.enableAutomaticActiveNoteContext !== false)
          .onChange(async (value) => {
            this.plugin.settings.enableAutomaticActiveNoteContext = value;
            await this.plugin.saveSettings();
          });
      });
  }

  renderSessionHistorySettings(containerEl) {
    const setting = new Setting(containerEl);
    let limitControl = null;
    let startupControl = null;
    const syncDisabledState = () => {
      const disabled = this.plugin.settings.enableSessionHistory === false;
      limitControl?.setDisabled(disabled);
      startupControl?.setDisabled(disabled);
    };

    setting.settingEl.addClass("codriver-session-history-setting");
    setting
      .setName("Session history")
      .setDesc("Save chat sessions automatically.")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.enableSessionHistory !== false)
          .onChange(async (value) => {
            this.plugin.settings.enableSessionHistory = value;
            syncDisabledState();
            await this.plugin.saveSettings();
          });
      })
      .addText((text) => {
        limitControl = text;
        text.inputEl.type = "number";
        text.inputEl.min = "1";
        text.inputEl.max = "100";
        text.inputEl.ariaLabel = "Maximum saved sessions";
        text
          .setPlaceholder("5")
          .setValue(String(this.plugin.settings.maxSessionHistory ?? 5))
          .onChange(async (value) => {
            const number = Number(value);
            if (!Number.isFinite(number)) {
              return;
            }

            this.plugin.settings.maxSessionHistory = Math.min(100, Math.max(1, Math.trunc(number)));
            await this.plugin.saveSettings();
          });
      })
      .addDropdown((dropdown) => {
        startupControl = dropdown;
        dropdown
          .addOption("new", "Start new")
          .addOption("last", "Open latest")
          .setValue(this.plugin.settings.sessionStartupBehavior ?? "new")
          .onChange(async (value) => {
            this.plugin.settings.sessionStartupBehavior = value;
            await this.plugin.saveSettings();
          });
      });

    syncDisabledState();
  }

  renderMcpToolLimitSettings(containerEl) {
    const setting = new Setting(containerEl)
      .setName("MCP tool limits");
    setting.settingEl.addClass("codriver-mcp-tool-limits-setting");

    const controls = setting.controlEl.createDiv({ cls: "codriver-mcp-tool-limits" });

    for (const field of MCP_TOOL_LIMIT_FIELDS) {
      this.renderMcpToolLimitNumberField(controls, field);
    }
  }

  renderMcpToolLimitNumberField(containerEl, field) {
    const group = containerEl.createEl("label", {
      cls: "codriver-mcp-tool-limit-field",
      attr: {
        title: field.description
      }
    });
    group.createSpan({
      text: field.label,
      attr: {
        title: field.description
      }
    });
    const input = group.createEl("input", {
      attr: {
        type: "number",
        min: String(field.min),
        max: String(field.max),
        title: field.description,
        "aria-label": field.ariaLabel
      }
    });
    input.value = String(this.plugin.settings[field.key] ?? field.fallback);
    input.addEventListener("change", async () => {
      const number = Number(input.value);
      if (!Number.isFinite(number)) {
        return;
      }

      const value = Math.min(field.max, Math.max(field.min, Math.trunc(number)));
      this.plugin.settings[field.key] = value;
      input.value = String(value);
      await this.plugin.saveSettings();
    });
  }

  addSkillFolderControl(setting) {
    setting.addText((text) => {
      const currentPath = normalizeSkillFolderPath(
        this.plugin.settings.skillFolderPath ?? DEFAULT_SKILL_FOLDER_PATH
      );
      text.inputEl.setAttribute("aria-label", "Vault-relative skills folder");
      text
        .setPlaceholder(formatSkillFolderPathForDisplay(DEFAULT_SKILL_FOLDER_PATH))
        .setValue(formatSkillFolderPathForDisplay(currentPath));
      text.inputEl.addEventListener("change", async () => {
        text.setDisabled?.(true);
        try {
          const result = await this.plugin.updateSkillFolderPath(text.inputEl.value);
          const savedPath = this.plugin.settings.skillFolderPath;
          text.setValue(formatSkillFolderPathForDisplay(savedPath));
          if (result.errors.length > 0) {
            new Notice(createSkillErrorStatusText(result));
          } else {
            new Notice(`Skills folder: ${savedPath}`);
          }
          this.display();
        } catch (error) {
          text.setValue(formatSkillFolderPathForDisplay(
            this.plugin.settings.skillFolderPath ?? DEFAULT_SKILL_FOLDER_PATH
          ));
          new Notice(error instanceof Error ? error.message : "Unable to update the skills folder.");
        } finally {
          text.setDisabled?.(false);
        }
      });
    });
  }

  renderDiagnosticLoggingSettings(containerEl) {
    const setting = new Setting(containerEl);
    const isMobileApp = Boolean(Platform?.isMobileApp);
    const diagnosticLogTarget = isMobileApp
      ? "file"
      : this.plugin.settings.diagnosticLogTarget ?? "console";
    setting.settingEl.addClass("codriver-diagnostic-logging-setting");
    setting.setName("Diagnostic logging");
    if (diagnosticLogTarget === "file") {
      setting.settingEl.addClass("codriver-diagnostic-log-file-setting");
      setting.setDesc(
        `${this.plugin.getDiagnosticLogPath() || "The CoDriver diagnostic log"}\nThis file is refreshed when CoDriver restarts.${this.plugin.settings.diagnosticLogLevel === "detailed"
          ? "\nDetailed logging may contain sensitive information." : ""}`
      );
      setting.descEl?.addClass("codriver-diagnostic-log-file-description");
      if (setting.descEl) setting.settingEl.appendChild(setting.descEl);
    }
    setting
      .addToggle((toggle) => {
        toggle
          .setValue(Boolean(this.plugin.settings.enableDiagnosticLogging))
          .onChange(async (value) => {
            await this.changeDiagnosticLogging({ enableDiagnosticLogging: value });
          });
      })
      .addDropdown((dropdown) => {
        dropdown
          .addOption("errors", "Errors only")
          .addOption("all", "Standard");
        if (diagnosticLogTarget === "file") dropdown.addOption("detailed", "Detailed");
        dropdown
          .setValue(this.plugin.settings.diagnosticLogLevel ?? "errors")
          .onChange(async (value) => {
            await this.changeDiagnosticLogging({ diagnosticLogLevel: value });
          });
      })
      .addDropdown((dropdown) => {
        if (isMobileApp) {
          dropdown
            .addOption("file", "File")
            .setValue("file");
          dropdown.setDisabled?.(true);
          return;
        }

        dropdown
          .addOption("file", "File")
          .addOption("console", "Console")
          .setValue(this.plugin.settings.diagnosticLogTarget ?? "console")
          .onChange(async (value) => {
            await this.changeDiagnosticLogging({ diagnosticLogTarget: value,
              ...(value === "console" && this.plugin.settings.diagnosticLogLevel === "detailed"
                ? { diagnosticLogLevel: "all" } : {}) });
          });
      });

    if (isMobileApp) {
      createIconButton(setting.controlEl, "share-2", "Share diagnostic log", () => (
        this.handleDiagnosticLogShare()
      ), "codriver-diagnostic-share-button");
    }
  }

  async changeDiagnosticLogging(changes) {
    const revision = (this.plugin.diagnosticLoggingChangeRevision ?? 0) + 1;
    this.plugin.diagnosticLoggingChangeRevision = revision;
    const settings = this.plugin.settings;
    const previous = diagnosticConfiguration(settings);
    const next = { ...settings, ...changes };
    if (diagnosticConfiguration(next) === previous) { this.display(); return; }
    const file = Platform?.isMobileApp || next.diagnosticLogTarget === "file";
    const needsConsent = next.enableDiagnosticLogging && next.diagnosticLogLevel === "detailed" && file &&
      (!settings.enableDiagnosticLogging || settings.diagnosticLogLevel !== "detailed");
    if (needsConsent) {
      const confirmed = await new Promise((resolve) => {
        new DetailedLogConsentModal(this.app, resolve).open();
      });
      if (!confirmed || this.plugin.diagnosticLoggingChangeRevision !== revision ||
          this.plugin.settings !== settings || diagnosticConfiguration(this.plugin.settings) !== previous) {
        this.display();
        return;
      }
    }
    this.plugin.diagnosticLogger?.revokeContentConsent();
    Object.assign(this.plugin.settings, changes);
    const confirmedConfiguration = diagnosticConfiguration(this.plugin.settings);
    try {
      await this.plugin.saveSettings();
      if (needsConsent && this.plugin.diagnosticLoggingChangeRevision === revision &&
          diagnosticConfiguration(this.plugin.settings) === confirmedConfiguration) this.plugin.diagnosticLogger?.activateContent();
    } catch {
      this.plugin.diagnosticLogger?.revokeContentConsent();
      this.plugin.settings.enableDiagnosticLogging = false;
      new Notice("Unable to save diagnostic logging settings. Logging was stopped.");
    }
    this.display();
  }

  async handleDiagnosticLogShare() {
    if (!this.plugin.settings.enableDiagnosticLogging) {
      new Notice("Enable diagnostic logging before sharing the log.");
      return;
    }

    let result;
    try {
      result = await this.plugin.readDiagnosticLogForSharing();
    } catch {
      new Notice("Unable to read the diagnostic log.");
      return;
    }

    if (!result?.ok) {
      new Notice(createDiagnosticLogUnavailableMessage(result?.reason));
      return;
    }

    const navigatorObject = globalThis.navigator;
    const file = createDiagnosticLogFile(result.content);
    new DiagnosticLogShareModal(this.app, {
      file,
      content: result.content,
      navigatorObject
    }).open();
  }

  renderUserSkillsSettings(containerEl) {
    let skillStatus = null;
    let skillDetails = null;
    let skillFeedback = null;
    let skillListHost = null;
    const setting = new Setting(containerEl).setName("Skills");
    setting.settingEl.addClass("codriver-skills-setting");
    this.addSkillFolderControl(setting);
    const reloadButton = createIconButton(
      setting.controlEl,
      "refresh-cw",
      "Reload skills",
      async () => {
        skillFeedback.empty();
        skillStatus = null;
        skillDetails = null;
        reloadButton.disabled = true;
        try {
          const result = await this.plugin.reloadSkills(false);
          skillListHost.empty();
          this.renderSkillRows(skillListHost);
          if (result.errors.length === 0) {
            new Notice(`Loaded ${result.loaded.length} skills`);
          } else {
            skillStatus = skillFeedback.createDiv({ cls: "codriver-setting-status is-error" });
            skillDetails = skillFeedback.createDiv({ cls: "codriver-setting-details" });
            skillStatus.setText(createSkillErrorStatusText(result));
            renderSkillDetails(skillDetails, result);
          }
        } finally {
          reloadButton.disabled = false;
        }
      },
      "codriver-skill-setting-action codriver-skill-reload-button"
    );
    createIconButton(
      setting.controlEl,
      "plus",
      "New skill",
      () => {
        new NewSkillModal(this.app, this.plugin, () => this.display()).open();
      },
      "codriver-skill-setting-action codriver-skill-new-button"
    );
    const skillContent = containerEl.createDiv({ cls: "codriver-user-skills-content" });
    skillListHost = skillContent.createDiv({ cls: "codriver-skill-list-host" });
    this.renderSkillRows(skillListHost);
    skillFeedback = skillContent.createDiv({ cls: "codriver-user-skill-feedback" });
    const lastResult = this.plugin.skillReloadResult;
    if (Array.isArray(lastResult?.errors) && lastResult.errors.length > 0) {
      skillStatus = skillFeedback.createDiv({ cls: "codriver-setting-status is-error" });
      skillDetails = skillFeedback.createDiv({ cls: "codriver-setting-details" });
      skillStatus.setText(createSkillErrorStatusText(lastResult));
      renderSkillDetails(skillDetails, lastResult);
    }
    this.renderUserCommandsSettings(containerEl);
  }

  renderUserCommandsSettings(containerEl) {
    const setting = new Setting(containerEl).setName("Commands");
    setting.settingEl.addClass("codriver-commands-setting");
    setting.addText((text) => {
      const path = normalizeCommandFolderPath(this.plugin.settings.commandFolderPath ?? DEFAULT_COMMAND_FOLDER_PATH);
      text.inputEl.setAttribute("aria-label", "Vault-relative commands folder");
      text.setPlaceholder(formatSkillFolderPathForDisplay(DEFAULT_COMMAND_FOLDER_PATH)).setValue(formatSkillFolderPathForDisplay(path));
      text.inputEl.addEventListener("change", async () => {
        text.setDisabled?.(true);
        try {
          const result = await this.plugin.updateCommandFolderPath(text.inputEl.value);
          if (result.errors.length) new Notice(`${result.errors.length} command(s) failed to load.`);
          else new Notice(`Commands folder: ${this.plugin.settings.commandFolderPath}`);
          this.display();
        } catch (error) {
          text.setValue(formatSkillFolderPathForDisplay(this.plugin.settings.commandFolderPath ?? DEFAULT_COMMAND_FOLDER_PATH));
          new Notice(error instanceof Error ? error.message : "Unable to update the commands folder.");
        } finally { text.setDisabled?.(false); }
      });
    });
    createIconButton(setting.controlEl, "refresh-cw", "Reload commands", async () => {
      const result = await this.plugin.reloadCommands(false);
      new Notice(result.errors.length ? `Loaded ${result.loaded.length} commands. ${result.errors.length} failed.` : `Loaded ${result.loaded.length} commands`);
      this.display();
    }, "codriver-command-setting-action codriver-command-reload-button");
    createIconButton(setting.controlEl, "plus", "New command", () => {
      new NewCommandModal(this.app, this.plugin, () => this.display()).open();
    }, "codriver-command-setting-action codriver-command-new-button");

    const host = containerEl.createDiv({ cls: "codriver-command-list-host" });
    const commands = this.plugin.getLoadedCommandsForSettings?.() ?? [];
    const errors = this.plugin.commandReloadResult?.errors ?? [];
    if (commands.length || errors.length) {
      const details = host.createEl("details", { cls: "codriver-command-details" });
      details.open = this.commandListOpen;
      details.addEventListener("toggle", () => { this.commandListOpen = details.open; });
      details.createEl("summary", { cls: "codriver-command-summary", text: `Commands (${commands.length})` });
      const list = details.createDiv({ cls: "codriver-command-list" });
      for (const command of commands) {
        const row = list.createDiv({ cls: "codriver-command-row" });
        row.toggleClass?.("is-disabled", command.enabled === false);
        const checkbox = row.createEl("input", { attr: { type: "checkbox", "aria-label": `Enable ${command.name}` } });
        checkbox.checked = command.enabled !== false;
        checkbox.addEventListener("change", async () => { await this.plugin.updateCommandSettings(command.id, { enabled: checkbox.checked }); row.toggleClass?.("is-disabled", !checkbox.checked); });
        const identity = row.createDiv({ cls: "codriver-command-identity" });
        identity.createDiv({ cls: "codriver-command-name", text: `${command.name} (~${command.approximateTokens} tokens)` });
        identity.createDiv({ cls: "codriver-command-description", text: command.description });
        if (command.warning) identity.createDiv({ cls: "codriver-setting-status is-warning", text: command.warning });
        const actions = row.createDiv({ cls: "codriver-command-actions" });
        createIconButton(actions, "pencil", `Edit ${command.name}`, async () => {
          try { await this.plugin.openCommandFile(command.sourcePath, true); }
          catch (error) { new Notice(error instanceof Error ? error.message : "Unable to open the command file."); }
        }, "codriver-command-edit-button");
      }
      for (const error of errors) {
        const row = list.createDiv({ cls: "codriver-command-row is-unavailable" });
        const identity = row.createDiv({ cls: "codriver-command-identity" });
        identity.createDiv({ cls: "codriver-command-name", text: error.path });
        identity.createDiv({ cls: "codriver-setting-status is-error", text: error.message, attr: { role: "alert" } });
        if (String(error.path).toLowerCase().endsWith(".md")) {
          const actions = row.createDiv({ cls: "codriver-command-actions" });
          createIconButton(actions, "pencil", `Edit invalid command ${error.path}`, async () => {
            try { await this.plugin.openCommandFile(error.path, true); } catch (openError) { new Notice(openError instanceof Error ? openError.message : "Unable to open the command file."); }
          }, "codriver-command-edit-button");
        }
      }
    }
  }

  renderSkillRows(container) {
    const skills = this.plugin.getLoadedSkillsForSettings();
    if (skills.length === 0) {
      return;
    }

    const details = container.createEl("details", { cls: "codriver-skill-details" });
    details.open = this.skillListOpen;
    details.addEventListener("toggle", () => {
      this.skillListOpen = details.open;
    });
    details.createEl("summary", {
      cls: "codriver-skill-summary",
      text: `Loaded skills (${skills.length})`
    });

    const list = details.createDiv({ cls: "codriver-skill-list" });
    for (const skill of skills) {
      const row = list.createDiv({ cls: "codriver-skill-row" });
      if (skill.enabled === false) {
        row.addClass("is-disabled");
      }
      if (skill.available === false) {
        row.addClass("is-unavailable");
      }

      const checkbox = row.createEl("input", {
        cls: "codriver-skill-enabled",
        attr: {
          type: "checkbox",
          title: `Enable ${skill.name}`,
          "aria-label": `Enable ${skill.name}`
        }
      });
      checkbox.checked = skill.enabled !== false;
      checkbox.disabled = skill.available === false;
      if (skill.available === false) {
        checkbox.setAttribute?.(
          "title",
          skill.availabilityReason || `Unavailable ${skill.name}`
        );
        checkbox.setAttribute?.(
          "aria-label",
          `Unavailable ${skill.name}: ${skill.availabilityReason || "invalid skill metadata"}`
        );
      }
      checkbox.addEventListener("change", async () => {
        await this.plugin.updateSkillSettings(skill.id, { enabled: checkbox.checked });
        if (checkbox.checked) {
          row.removeClass("is-disabled");
        } else {
          row.addClass("is-disabled");
        }
      });

      const identity = row.createDiv({ cls: "codriver-skill-identity" });
      identity.createDiv({
        cls: "codriver-skill-name",
        text: `${skill.name} (~${skill.approximateTokens} tokens)`,
        attr: {
          title: skill.name
        }
      });
      const invocation = identity.createDiv({
        cls: "codriver-skill-invocation",
        text: `Invocation: ${skill.invocation}`,
        attr: {
          title: `Invocation: ${skill.invocation}`,
          "aria-label": `Invocation: ${skill.invocation}`
        }
      });
      if (skill.builtin) identity.createSpan({ cls: "codriver-skill-builtin-label", text: "Built-in" });
      if (skill.metadataWarning) {
        invocation.createSpan({
          cls: "codriver-skill-warning",
          text: "\u26A0",
          attr: {
            title: skill.metadataWarning,
            "aria-label": skill.metadataWarning
          }
        });
      }

      const actions = row.createDiv({ cls: "codriver-skill-actions" });
      const editButton = createIconButton(actions, "pencil", `Edit ${skill.name}`, async () => {
        try {
          await this.plugin.openSkillFile(skill.sourcePath, true);
        } catch (error) {
          new Notice(error instanceof Error ? error.message : "Unable to open the skill file.");
        }
      }, "codriver-skill-edit-button");
      editButton.disabled = !skill.sourcePath;
      if (skill.builtin) {
        const resetButton = createIconButton(actions, "rotate-ccw", `Restore default ${skill.name} skill`, async () => {
          resetButton.disabled = true;
          try {
            const review = await this.plugin.prepareBuiltinSkillReset(skill.builtinId, skill.sourcePath);
            new BuiltinSkillResetModal(this.app, this.plugin, review, () => this.display()).open();
          } catch {
            new Notice("Unable to prepare skill reset. Reload skills and try again.");
          } finally { resetButton.disabled = false; }
        }, "codriver-skill-reset-button");
        resetButton.disabled = !skill.sourcePath;
      }
    }
  }

  renderSettingsSectionHeader(container, title) {
    const header = container.createDiv({ cls: "codriver-settings-section-header" });
    header.createEl("h3", { text: title });
    return header.createDiv({ cls: "codriver-settings-section-actions" });
  }

  renderAudioTranscriptionSettings(container) {
    container = container.createDiv({ cls: "codriver-audio-settings-group" });
    const current = normalizeAudioTranscriptionSettings(this.plugin.settings.audioTranscription);
    const choices = getAudioTranscriptionModelChoices(this.plugin.settings);
    const selectedValue = encodeAudioTranscriptionSelection(current.providerId, current.modelId);
    const groups = choices.map((provider) => ({
      label: provider.providerName,
      models: provider.models.map((model) => ({
        model, label: model, value: encodeAudioTranscriptionSelection(provider.providerId, model)
      }))
    }));
    const availableValues = new Set(groups.flatMap((group) => group.models.map((model) => model.value)));
    const setting = new Setting(container)
      .setName("Audio transcription")
      .addToggle((toggle) => {
        toggle
          .setValue(current.enabled || this.pendingAudioTranscriptionEnable)
          .onChange(async (enabled) => {
            if (!enabled) {
              this.pendingAudioTranscriptionEnable = false;
              if (current.enabled) {
                await this.plugin.updateAudioTranscriptionSettings({ enabled: false });
              }
              this.display();
              return;
            }

            const result = await this.plugin.updateAudioTranscriptionSettings({ enabled: true });
            if (result.ok) {
              this.pendingAudioTranscriptionEnable = false;
              this.display();
              return;
            }

            if (choices.length === 0) {
              toggle.setValue(false);
              new Notice("Select an OpenAI compatible provider and mode in CoDriver settings");
              return;
            }

            this.pendingAudioTranscriptionEnable = true;
            this.display();
          });
        toggle.toggleEl?.setAttribute("title", "Enable audio transcription");
        toggle.toggleEl?.setAttribute("aria-label", "Enable audio transcription");
      });
    setting.settingEl.classList.add("codriver-audio-transcription-setting");
    setting.nameEl.setAttribute("title", AUDIO_TRANSCRIPTION_TOOLTIP);

    const select = setting.controlEl.createEl("button", {
      cls: "codriver-audio-transcription-select codriver-model-select-trigger",
      text: current.modelId ? (availableValues.has(selectedValue) ? current.modelId : `Unavailable: ${current.modelId}`) : "Select model",
      attr: {
        type: "button",
        "aria-label": "Select audio transcription model",
        title: AUDIO_TRANSCRIPTION_TOOLTIP
      }
    });
    if (current.providerId && current.modelId && !availableValues.has(selectedValue) &&
      !isProviderModelDisabled(this.plugin.settings.providers?.find((provider) => provider.id === current.providerId), current.modelId)) {
      groups.push({ label: "", models: [{ model: current.modelId, label: `Unavailable: ${current.providerId} / ${current.modelId}`, value: selectedValue, disabled: true }] });
    }
    select.disabled = !current.enabled && !this.pendingAudioTranscriptionEnable;
    bindModelPicker(this, select, {
      label: "Select audio transcription model", groups, selectedValue,
      onChoose: async (value) => {
        const selection = decodeAudioTranscriptionSelection(value);
        if (!selection.providerId || !selection.modelId) {
          return;
        }
        const result = await this.plugin.updateAudioTranscriptionSettings({
          enabled: current.enabled || this.pendingAudioTranscriptionEnable,
          providerId: selection.providerId,
          modelId: selection.modelId
        });
        if (!result.ok) {
          new Notice(result.message);
          return;
        }
        this.pendingAudioTranscriptionEnable = false;
        this.display();
      }
    });

    const resolution = resolveAudioTranscriptionSelection(this.plugin.settings);
    if (current.enabled && !resolution.ok) {
      setting.settingEl.classList.add("is-invalid");
      select.setAttribute("aria-invalid", "true");
      select.title = `${AUDIO_TRANSCRIPTION_TOOLTIP} ${resolution.message}`;
    }
    if (this.pendingAudioTranscriptionEnable) {
      setTimeout(() => select.focus(), 0);
    }
    this.renderVoiceInputSettings(container, choices);
  }

  renderVoiceInputSettings(container, choices = getAudioTranscriptionModelChoices(this.plugin.settings)) {
    if (Platform.isMobile) return;
    const current = normalizeVoiceInputSettings(this.plugin.settings.voiceInput);
    const selectedValue = encodeAudioTranscriptionSelection(current.providerId, current.modelId);
    const groups = choices.map((provider) => ({ label: provider.providerName,
      models: provider.models.map((model) => ({ model, label: model, value: encodeAudioTranscriptionSelection(provider.providerId, model) })) }));
    const availableValues = new Set(groups.flatMap((group) => group.models.map((model) => model.value)));
    const resolution = resolveVoiceInputSelection(this.plugin.settings);
    const setting = new Setting(container).setName("Voice input");
    setting.settingEl.addClass("codriver-voice-input-setting");
    setting.nameEl.empty();
    const disclosure = setting.nameEl.createSpan({
      cls: "codriver-voice-input-disclosure",
      attr: { role: "button", tabindex: "0", "aria-expanded": String(this.voiceInputExpanded === true), "aria-controls": "codriver-voice-input-options" }
    });
    setIcon(disclosure.createSpan({ cls: "codriver-voice-input-chevron" }), "chevron-right");
    disclosure.createSpan({ text: "Voice input" });
    setting.addToggle((toggle) => {
      toggle.setValue(current.enabled || this.pendingVoiceInputEnable === true).setDisabled(Platform.isMobile)
        .onChange(async (enabled) => {
          if (!enabled) {
            this.pendingVoiceInputEnable = false;
            if (current.enabled) await this.plugin.updateVoiceInputSettings({ enabled: false });
          } else {
            const result = await this.plugin.updateVoiceInputSettings({ enabled: true });
            if (result.ok) this.pendingVoiceInputEnable = false;
            else if (choices.length) this.pendingVoiceInputEnable = true;
            else { toggle.setValue(false); new Notice(result.message); }
          }
          this.display();
        });
      toggle.toggleEl.setAttribute("aria-label", "Enable voice input");
      toggle.toggleEl.setAttribute("title", Platform.isMobile ? "Voice input is available only in the desktop app." : "Enable microphone input for chat.");
    });
    const select = setting.controlEl.createEl("button", {
      cls: "codriver-audio-transcription-select codriver-model-select-trigger",
      text: current.modelId ? (availableValues.has(selectedValue) ? current.modelId
        : `Unavailable: ${current.modelId}`) : "Select model",
      attr: { type: "button", "aria-label": "Select voice input provider and model", title: "Uses this provider and model only for microphone input." }
    });
    select.disabled = Platform.isMobile || (!current.enabled && !this.pendingVoiceInputEnable);
    if (current.providerId && current.modelId && !availableValues.has(selectedValue) &&
      !isProviderModelDisabled(this.plugin.settings.providers?.find((provider) => provider.id === current.providerId), current.modelId)) {
      groups.push({ label: "", models: [{ model: current.modelId, label: `Unavailable: ${current.providerId} / ${current.modelId}`, value: selectedValue, disabled: true }] });
    }
    bindModelPicker(this, select, {
      label: "Select voice input provider and model", groups, selectedValue,
      onChoose: async (value) => {
        const selection = decodeAudioTranscriptionSelection(value);
        if (!selection.providerId || !selection.modelId) return;
        const result = await this.plugin.updateVoiceInputSettings({ enabled: current.enabled || this.pendingVoiceInputEnable === true, ...selection });
        if (!result.ok) { new Notice(result.message); return; }
        this.pendingVoiceInputEnable = false;
        this.display();
      }
    });
    const voiceConfiguration = this.plugin.chatController?.getVoiceInputConfiguration?.();
    const unavailableReason = voiceConfiguration?.unavailableReason || (!resolution.ok ? resolution.message : "");
    if (current.enabled && unavailableReason) {
      setting.settingEl.addClass("is-invalid");
      select.setAttribute("aria-invalid", "true");
      select.title = unavailableReason;
      container.createDiv({ cls: "codriver-voice-unavailable",
        text: unavailableReason.replace(" Update it in Settings > Providers.", ""), attr: { role: "status" } });
    }
    const options = container.createDiv({ cls: "codriver-voice-input-options", attr: { id: "codriver-voice-input-options" } });
    options.hidden = this.voiceInputExpanded !== true;
    const toggleOptions = () => {
      this.voiceInputExpanded = !this.voiceInputExpanded;
      options.hidden = !this.voiceInputExpanded;
      disclosure.setAttribute("aria-expanded", String(this.voiceInputExpanded));
    };
    disclosure.addEventListener("click", toggleOptions);
    disclosure.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        toggleOptions();
      }
    });
    const timeout = new Setting(options).setName("Timeout");
    timeout.settingEl.setAttribute("title", "Maximum wait for voice input after stop");
    const input = timeout.controlEl.createEl("input", {
      cls: "codriver-voice-input-timeout",
      attr: { type: "number", min: "5", max: "300", step: "1", "aria-label": "Voice input timeout in seconds" }
    });
    input.value = String(current.timeoutSeconds);
    input.disabled = Platform.isMobile || (!current.enabled && !this.pendingVoiceInputEnable);
    timeout.controlEl.createSpan({ text: "seconds" });
    input.addEventListener("change", async () => {
      const seconds = Number(input.value);
      if (!Number.isInteger(seconds) || seconds < 5 || seconds > 300) {
        input.value = String(current.timeoutSeconds);
        new Notice("Enter a whole number from 5 to 300 seconds.");
        return;
      }
      const result = await this.plugin.updateVoiceInputSettings({ timeoutSeconds: seconds });
      if (!result.ok) { input.value = String(current.timeoutSeconds); new Notice(result.message); }
      else current.timeoutSeconds = seconds;
    });
  }

  renderProviderCard(container, provider) {
    const group = container.createDiv({ cls: "codriver-provider-group" });
    const row = group.createDiv({ cls: "codriver-provider-row" });
    if (provider.enabled === false) {
      row.addClass("is-disabled");
    }
    if (provider.id === this.plugin.settings.selectedProviderId) {
      row.addClass("is-selected");
    }

    const visibility = row.createEl("input", {
      cls: "codriver-provider-visibility",
      attr: {
        type: "checkbox",
        title: "Show in chat",
        "aria-label": "Show in chat"
      }
    });
    visibility.checked = provider.enabled !== false;
    visibility.addEventListener("change", async () => {
      await this.plugin.updateProviderSettings(provider.id, { enabled: visibility.checked });
      this.display();
    });

    const identity = row.createDiv({ cls: "codriver-provider-row-identity" });
    identity.createSpan({ cls: "codriver-provider-row-name", text: provider.name });
    identity.createSpan({
      cls: "codriver-provider-row-model",
      text: provider.model || getProviderTypeLabel(provider.type)
    });

    const actions = row.createDiv({ cls: "codriver-provider-row-actions" });
    createIconButton(actions, "pencil", "Edit model", () => {
      new ProviderSettingsModal(this.app, this.plugin, provider, () => this.display()).open();
    });
    createIconButton(actions, "trash-2", "Remove model", () => {
      this.confirmRemoval("provider", provider, (id, options) => this.plugin.removeProvider(id, options));
    });
    const defaultButton = createIconButton(actions, "star", "Set as default", async () => {
      await this.plugin.selectProvider(provider.id);
      this.display();
    });
    if (provider.id === this.plugin.settings.selectedProviderId) {
      defaultButton.addClass("is-active");
    }

    this.renderProviderModelRows(group, provider);
  }

  renderProviderModelRows(container, provider) {
    this.providerModelQueries ??= new Map();
    const models = Array.isArray(provider.models) ? provider.models : [];
    if (models.length === 0) {
      return;
    }

    const hiddenModels = new Set(Array.isArray(provider.hiddenModels) ? provider.hiddenModels : []);
    const details = container.createEl("details", { cls: "codriver-provider-model-details" });
    details.open = this.openProviderModelIds.has(provider.id);
    details.addEventListener("toggle", () => {
      if (details.open) {
        this.openProviderModelIds.add(provider.id);
      } else {
        this.openProviderModelIds.delete(provider.id);
        this.providerModelQueries.delete(provider.id);
      }
    });
    details.createEl("summary", {
      cls: "codriver-provider-model-summary",
      text: `Models (${models.length})`
    });

    const list = details.createDiv({ cls: "codriver-provider-model-list" });
    const toolbar = list.createDiv({ cls: "codriver-provider-model-toolbar" });
    const bulkState = getBulkSelectionState(models, {
      isEnabled: (model) => !hiddenModels.has(model)
    });
    this.renderBulkSelectionControl(toolbar, {
      ariaLabel: "Enable all models",
      label: "All models",
      state: bulkState,
      onChange: async (enabled) => {
        const nextHiddenModels = new Set(Array.isArray(provider.hiddenModels) ? provider.hiddenModels : []);
        for (const model of bulkState.controllableItems) {
          if (enabled) {
            nextHiddenModels.delete(model);
          } else {
            nextHiddenModels.add(model);
          }
        }

        await this.plugin.updateProviderSettings(provider.id, {
          hiddenModels: Array.from(nextHiddenModels)
        });
        this.openProviderModelIds.add(provider.id);
        this.display();
      }
    });
    const search = toolbar.createEl("input", {
      cls: "codriver-provider-model-search",
      attr: {
        type: "search",
        placeholder: "Search",
        "aria-label": "Search models"
      }
    });
    search.value = this.providerModelQueries.get(provider.id) ?? "";
    const rows = [];
    const emptyState = list.createDiv({
      cls: "codriver-provider-model-empty",
      text: "No matching models"
    });
    for (const model of models) {
      const row = list.createDiv({ cls: "codriver-provider-model-row" });
      rows.push({ model, row });
      const identity = row.createDiv({ cls: "codriver-provider-model-identity" });
      identity.createDiv({ cls: "codriver-provider-model-name", text: model });

      const visibility = row.createEl("label", { cls: "codriver-provider-model-visibility" });
      const checkbox = visibility.createEl("input", {
        attr: {
          type: "checkbox",
          title: "Show model in chat",
          "aria-label": `Show ${model} in chat`
        }
      });
      checkbox.checked = !hiddenModels.has(model);
      checkbox.addEventListener("change", async () => {
        const nextHiddenModels = new Set(Array.isArray(provider.hiddenModels) ? provider.hiddenModels : []);
        if (checkbox.checked) {
          nextHiddenModels.delete(model);
        } else {
          nextHiddenModels.add(model);
        }

        await this.plugin.updateProviderSettings(provider.id, {
          hiddenModels: Array.from(nextHiddenModels)
        });
        this.openProviderModelIds.add(provider.id);
        this.display();
      });
      visibility.createSpan({ text: "Show" });
    }
    const applySearch = () => {
      const query = search.value.trim().toLocaleLowerCase();
      this.providerModelQueries.set(provider.id, search.value);
      let visibleCount = 0;
      for (const entry of rows) {
        const matches = entry.model.toLocaleLowerCase().includes(query);
        entry.row.toggleClass("is-filtered-out", !matches);
        if (matches) {
          visibleCount += 1;
        }
      }
      emptyState.toggleClass("is-visible", visibleCount === 0);
    };
    search.addEventListener("input", applySearch);
    applySearch();
  }

  renderMcpServerRow(container, server) {
    const runtimeBlocked = isMcpServerRuntimeBlocked(this.plugin, server);
    const credentialStatus = this.plugin.getMcpCredentialStatus?.(server) ?? "";
    const credentialBlocked = server.transport === MCP_HTTP_TRANSPORT && Boolean(credentialStatus);
    const discovering = this.discoveringMcpServerIds.has(server.id);
    const group = container.createDiv({ cls: "codriver-mcp-server-group" });
    const row = group.createDiv({ cls: "codriver-provider-row" });
    if (server.enabled === false || runtimeBlocked) {
      row.addClass("is-disabled");
    }

    const enabled = row.createEl("input", {
      cls: "codriver-provider-visibility",
      attr: {
        type: "checkbox",
        title: "Enable MCP server",
        "aria-label": "Enable MCP server"
      }
    });
    enabled.checked = server.enabled !== false;
    enabled.disabled = runtimeBlocked;
    if (runtimeBlocked) {
      enabled.title = getStdioMcpUnavailableMessage(this.plugin);
      enabled.ariaLabel = "Stdio MCP server unavailable in this runtime";
    }
    enabled.addEventListener("change", async () => {
      await this.plugin.updateMcpServerSettings(server.id, { enabled: enabled.checked });
      this.display();
    });

    const identity = row.createDiv({ cls: "codriver-provider-row-identity" });
    identity.createSpan({ cls: "codriver-provider-row-name", text: server.name });
    identity.createSpan({
      cls: "codriver-provider-row-model",
      text: createMcpServerSubtitle(server, runtimeBlocked)
    });

    const actions = row.createDiv({ cls: "codriver-provider-row-actions" });
    const discoverButton = createIconButton(
      actions,
      discovering ? "loader-2" : "wrench",
      getMcpDiscoverButtonLabel(runtimeBlocked, discovering),
      async () => {
        if (runtimeBlocked || this.discoveringMcpServerIds.has(server.id)) {
          return;
        }

        this.discoveringMcpServerIds.add(server.id);
        this.display();

        try {
          const result = await this.plugin.discoverMcpServerTools(server.id);
          new Notice(result.message);
          this.openMcpToolServerIds.add(server.id);
        } catch (error) {
          const detail = error instanceof Error ? error.message : "Unknown MCP discovery error.";
          new Notice(`Unable to discover MCP tools. ${detail}`);
        } finally {
          this.discoveringMcpServerIds.delete(server.id);
          this.display();
        }
      },
      discovering ? "is-loading" : ""
    );
    discoverButton.disabled = runtimeBlocked || credentialBlocked || discovering;
    createIconButton(actions, "pencil", "Edit MCP server", () => {
      new McpServerSettingsModal(this.app, this.plugin, server, () => this.display()).open();
    });
    createIconButton(actions, "trash-2", "Remove MCP server", () => {
      this.confirmRemoval("MCP server", server, (id, options) => this.plugin.removeMcpServer(id, options));
    });

    if (runtimeBlocked) {
      group.createDiv({
        cls: "codriver-setting-status is-error",
        text: getStdioMcpUnavailableMessage(this.plugin)
      });
    }

    if (credentialStatus) {
      const attention = new Setting(group).setName(server.authMode === "oauth" ? "OAuth connection" : "Credentials need attention").setDesc(credentialStatus);
      if (server.authMode === "oauth") {
        attention.addButton((button) => button.setButtonText("Open Settings").onClick(() => {
          new McpServerSettingsModal(this.app, this.plugin, server, () => this.display()).open();
        }));
      } else {
        attention.addButton((button) => button.setButtonText("Retry migration").onClick(async () => {
          button.setDisabled(true);
          await this.plugin.retryMcpCredentialMigration(server.id);
          this.display();
        }));
      }
    }
    this.renderMcpToolRows(group, server, { disabled: runtimeBlocked });
  }

  renderBuiltInMcpServerRow(container) {
    const server = createCodriverVaultMcpServer({
      toolSettings: this.plugin.settings.codriverVaultToolSettings,
      directApiSettings: { obsidian: this.plugin.settings.enableDirectObsidianApiAccess === true, plugin: this.plugin.settings.enableDirectPluginApiAccess === true }
    });
    const enabledValue = this.plugin.settings.enableCoDriverVaultTools !== false;
    server.enabled = enabledValue;
    const group = container.createDiv({ cls: "codriver-mcp-server-group codriver-mcp-server-group-system" });
    const row = group.createDiv({ cls: "codriver-provider-row codriver-provider-row-system" });
    if (!enabledValue) {
      row.addClass("is-disabled");
    }

    const enabled = row.createEl("input", {
      cls: "codriver-provider-visibility",
      attr: {
        type: "checkbox",
        title: "Enable built-in CoDriver Vault tools",
        "aria-label": "Enable built-in CoDriver Vault tools"
      }
    });
    enabled.checked = enabledValue;
    enabled.addEventListener("change", () => {
      if (enabled.checked) {
        this.plugin.settings.enableCoDriverVaultTools = true;
        void this.plugin.saveSettings().then(() => {
          this.display();
        });
        return;
      }

      enabled.checked = true;
      new CoDriverVaultDisableModal(
        this.app,
        async () => {
          this.plugin.settings.enableCoDriverVaultTools = false;
          await this.plugin.saveSettings();
          new Notice("CoDriver Vault tools disabled.");
          this.display();
        },
        () => this.display()
      ).open();
    });

    const identity = row.createDiv({ cls: "codriver-provider-row-identity" });
    identity.createSpan({ cls: "codriver-provider-row-name", text: server.name });
    identity.createSpan({
      cls: "codriver-provider-row-model",
      text: createBuiltInMcpServerSubtitle(server, enabledValue)
    });

    const actions = row.createDiv({ cls: "codriver-provider-row-actions" });
    actions.createSpan({ cls: "codriver-mcp-system-badge", text: "Built-in" });

    if (!enabledValue) {
      group.createDiv({
        cls: "codriver-setting-status is-error",
        text: "CoDriver will rely on external skills or MCP servers for vault access. External MCP create, write, patch, delete, move, command, and execute tools are not protected by CoDriver proposal review unless they use a controlled first-party adapter."
      });
    }

    this.renderMcpToolRows(group, server, {
      showAvailability: (tool) => tool.name !== CODRIVER_VAULT_TRANSCRIBE_AUDIO_TOOL_NAME,
      showAutomaticPermission: (tool) => tool.automaticPermissionConfigurable === true
    });
  }

  renderMcpToolRows(container, server, options = {}) {
    const tools = Array.isArray(server.tools) ? [...server.tools] : [];
    if (server.id === "codriver-vault") {
      tools.sort((a, b) => Number(b.name === CODRIVER_API_CALL_TOOL_NAME) - Number(a.name === CODRIVER_API_CALL_TOOL_NAME));
    }
    if (tools.length === 0) {
      return;
    }

    const details = container.createEl("details", { cls: "codriver-mcp-tool-details" });
    details.open = this.openMcpToolServerIds.has(server.id);
    details.addEventListener("toggle", () => {
      if (details.open) {
        this.openMcpToolServerIds.add(server.id);
      } else {
        this.openMcpToolServerIds.delete(server.id);
      }
    });
    details.createEl("summary", {
      cls: "codriver-mcp-tool-summary",
      text: `Tools (${tools.length})`
    });

    const list = details.createDiv({ cls: "codriver-mcp-tool-list" });
    const isToolAvailable = (tool) => (
      options.disabled !== true && tool?.available !== false
    );
    const showAvailability = (tool) => (
      typeof options.showAvailability === "function"
        ? options.showAvailability(tool)
        : options.showAvailability !== false
    );
    const isToolControllable = (tool) => (
      isToolAvailable(tool) && showAvailability(tool)
    );
    const bulkState = getBulkSelectionState(tools, {
      isControllable: isToolControllable,
      isEnabled: (tool) => tool.enabled !== false
    });
    this.renderBulkSelectionControl(list, {
      ariaLabel: "Enable all tools",
      label: "All tools",
      state: bulkState,
      onChange: async (enabled) => {
        await this.plugin.updateMcpToolsEnabled(
          server.id,
          bulkState.controllableItems.map((tool) => tool.name),
          enabled
        );
        this.openMcpToolServerIds.add(server.id);
        this.display();
      }
    });
    for (const tool of tools) {
      const showAutomaticPermission = typeof options.showAutomaticPermission === "function"
        ? options.showAutomaticPermission(tool)
        : options.showAutomaticPermission !== false;
      const row = list.createDiv({ cls: "codriver-mcp-tool-row" });
      if (showAvailability(tool) && tool.enabled === false) {
        row.addClass("is-disabled");
      }
      const identity = row.createDiv({ cls: "codriver-mcp-tool-identity" });
      const protocolName = typeof tool.name === "string" ? tool.name.trim() : "";
      const toolTitle = typeof tool.title === "string" ? tool.title.trim() : "";
      const displayName = toolTitle || protocolName;
      const heading = identity.createDiv({ cls: "codriver-mcp-tool-heading" });
      heading.createSpan({ cls: "codriver-mcp-tool-name", text: displayName });
      if (toolTitle && toolTitle !== protocolName) {
        heading.createSpan({
          cls: "codriver-mcp-tool-protocol-name",
          text: protocolName,
          attr: {
            title: "Exact MCP tool name",
            "aria-label": `Exact MCP tool name: ${protocolName}`
          }
        });
      }
      if (server.id === "codriver-vault" && tool.name === CODRIVER_API_CALL_TOOL_NAME) {
        heading.createSpan({ cls: "codriver-api-experimental-badge", text: "Experimental" });
      }
      const description = server.id === "codriver-vault" && tool.name === CODRIVER_API_CALL_TOOL_NAME
        ? "Direct access to additional Obsidian and installed plugin APIs."
        : typeof tool.description === "string" ? tool.description.trim() : "";
      if (description) {
        identity.createDiv({
          cls: "codriver-mcp-tool-description",
          text: description
        });
      }

      const controls = row.createDiv({ cls: "codriver-mcp-tool-controls" });
      if (showAvailability(tool)) {
        const availability = controls.createEl("label", { cls: "codriver-mcp-tool-permission" });
        const availabilityCheckbox = availability.createEl("input", {
          attr: {
            type: "checkbox",
            title: options.disabled ? "Server unavailable in this runtime" : "Enable tool",
            "aria-label": `Enable ${tool.name}`
          }
        });
        availabilityCheckbox.checked = tool.enabled !== false;
        availabilityCheckbox.disabled = !isToolControllable(tool);
        availabilityCheckbox.addEventListener("change", async () => {
          await this.plugin.updateMcpToolSettings(server.id, tool.name, {
            enabled: availabilityCheckbox.checked
          });
          this.openMcpToolServerIds.add(server.id);
          this.display();
        });
        availability.createSpan({ text: "Enabled" });
      }

      if (!showAutomaticPermission) {
        continue;
      }

      const permission = controls.createEl("label", { cls: "codriver-mcp-tool-permission" });
      const checkbox = permission.createEl("input", {
        attr: {
          type: "checkbox",
          title: options.disabled ? "Server unavailable in this runtime"
            : tool.name === CODRIVER_VAULT_TRANSCRIBE_AUDIO_TOOL_NAME
              ? "Allow sending exact vault audio paths to the selected transcription provider and model without confirmation"
              : TEXT_DOCUMENT_MUTATION_TOOLS.includes(tool.name)
                ? "Allow this tool to write Markdown and validated Canvas files without confirmation"
              : "Allow without confirmation",
          "aria-label": `Allow ${tool.name} without confirmation`
        }
      });
      checkbox.checked = tool.automaticPermissionTarget === "proposal-application"
        ? tool.allowAutomaticProposalApplication === true
        : tool.allowAutomaticExecution === true;
      checkbox.disabled = !isToolAvailable(tool);
      checkbox.addEventListener("change", async () => {
        await this.plugin.updateMcpToolSettings(server.id, tool.name, {
          allowAutomaticExecution: checkbox.checked
        });
        this.openMcpToolServerIds.add(server.id);
        this.display();
      });
      permission.createSpan({ text: "Auto" });
    }
  }

  renderBulkSelectionControl(container, options) {
    const control = container.createEl("label", { cls: "codriver-bulk-selection" });
    if (options.state.disabled) {
      control.addClass("is-disabled");
    }
    const checkbox = control.createEl("input", {
      attr: {
        type: "checkbox",
        title: options.ariaLabel,
        "aria-label": options.ariaLabel
      }
    });
    checkbox.checked = options.state.checked;
    checkbox.indeterminate = options.state.indeterminate;
    checkbox.disabled = options.state.disabled;
    checkbox.addEventListener("change", async () => {
      if (options.state.disabled) {
        return;
      }

      checkbox.disabled = true;
      await options.onChange(options.state.nextEnabled);
    });
    control.createSpan({ text: options.label });
  }
}

class NewCommandModal extends Modal {
  constructor(app, plugin, onCreated) {
    super(app);
    this.plugin = plugin;
    this.onCreated = onCreated;
    this.commandName = "";
    this.errorMessage = "";
    this.existingPath = "";
    this.creating = false;
  }

  onOpen() { this.render(); }
  onClose() { this.contentEl.empty(); }

  render() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("codriver-new-command-modal");
    contentEl.createEl("h2", { text: "New command" });
    let nameControl = null;
    new Setting(contentEl).setName("Name").setDesc("Use 1-64 lowercase letters, numbers, and single hyphens.").addText((text) => {
      nameControl = text;
      text.inputEl.setAttribute("aria-label", "New command name");
      text.setPlaceholder("review-note").setValue(this.commandName).setDisabled?.(this.creating);
      text.inputEl.addEventListener("input", () => { this.commandName = text.inputEl.value; this.errorMessage = ""; this.existingPath = ""; });
      text.inputEl.addEventListener("keydown", (event) => { if (event.key === "Enter" && !this.creating) { event.preventDefault(); void this.createCommand(); } });
    });
    if (this.errorMessage) contentEl.createDiv({ cls: "codriver-setting-status is-error", text: this.errorMessage, attr: { role: "alert" } });
    const actions = new Setting(contentEl);
    actions.settingEl.addClass("codriver-new-command-actions");
    if (this.existingPath) actions.addButton((button) => button.setButtonText("Open existing").onClick(() => this.closeSettingsAndOpen(this.existingPath)));
    actions.addButton((button) => { button.setButtonText(this.creating ? "Creating" : "Create").setDisabled(this.creating).onClick(() => this.createCommand()); button.setCta?.(); });
    if (!this.creating) nameControl?.inputEl?.focus?.();
  }

  async createCommand() {
    if (this.creating) return;
    this.creating = true; this.errorMessage = ""; this.existingPath = ""; this.render();
    try {
      const created = await this.plugin.createUserCommand(this.commandName);
      this.onCreated?.();
      await this.closeSettingsAndOpen(created.path);
    } catch (error) {
      this.creating = false;
      this.errorMessage = error instanceof Error ? error.message : "Unable to create the command.";
      this.existingPath = error?.code === "command-exists" ? String(error.existingPath || "") : "";
      this.render();
    }
  }

  async closeSettingsAndOpen(path) {
    this.close(); this.app?.setting?.close?.();
    try { await this.plugin.openCommandFile(path, true); }
    catch (error) { new Notice(error instanceof Error ? error.message : "Unable to open the command file."); }
  }
}

class BuiltinSkillResetModal extends Modal {
  constructor(app, plugin, review, onReset) {
    super(app);
    this.plugin = plugin;
    this.review = review;
    this.onReset = onReset;
    this.isOpen = false;
    this.resetting = false;
  }

  onOpen() {
    this.isOpen = true;
    this.contentEl.createEl("h2", { text: "Restore default skill?" });
    this.contentEl.createEl("p", { text: "Your edits to this skill will be replaced." });
    const actions = new Setting(this.contentEl);
    actions.addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()));
    actions.addButton((button) => button.setButtonText("Restore").setCta().onClick(async () => {
      if (!this.isOpen || this.resetting) return;
      this.resetting = true;
      button.setDisabled(true);
      try {
        await this.plugin.resetBuiltinSkill(this.review, () => this.isOpen);
        this.onReset?.();
        this.close();
      } catch {
        if (this.isOpen) new Notice("Unable to restore defaults. Save the skill editor, reload skills and confirm again.");
      } finally { this.resetting = false; button.setDisabled(false); }
    }));
  }

  onClose() { this.isOpen = false; this.review = null; this.contentEl.empty(); }
}

class NewSkillModal extends Modal {
  constructor(app, plugin, onCreated) {
    super(app);
    this.plugin = plugin;
    this.onCreated = onCreated;
    this.skillName = "";
    this.errorMessage = "";
    this.existingPath = "";
    this.creating = false;
  }

  onOpen() {
    this.render();
  }

  onClose() {
    this.contentEl.empty();
  }

  render() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("codriver-new-skill-modal");
    contentEl.createEl("h2", { text: "New skill" });

    let nameControl = null;
    new Setting(contentEl)
      .setName("Name")
      .setDesc("Use 1-64 lowercase letters, numbers, and single hyphens.")
      .addText((text) => {
        nameControl = text;
        text.inputEl.setAttribute("aria-label", "New skill name");
        text
          .setPlaceholder("daily-review")
          .setValue(this.skillName)
          .setDisabled?.(this.creating);
        text.inputEl.addEventListener("input", () => {
          this.skillName = text.inputEl.value;
          if (this.existingPath) {
            this.errorMessage = "";
            this.existingPath = "";
            this.render();
          }
        });
        text.inputEl.addEventListener("keydown", (event) => {
          if (event.key === "Enter" && !this.creating) {
            event.preventDefault();
            void this.createSkill();
          }
        });
      });

    if (this.errorMessage) {
      contentEl.createDiv({
        cls: "codriver-setting-status is-error",
        text: this.errorMessage,
        attr: { role: "alert" }
      });
    }

    const actions = new Setting(contentEl);
    actions.settingEl.addClass("codriver-new-skill-actions");
    if (this.existingPath) {
      actions.addButton((button) => {
        button
          .setButtonText("Open existing")
          .onClick(() => this.closeSettingsAndOpenSkill(this.existingPath));
      });
    }
    actions.addButton((button) => {
      button
        .setButtonText(this.creating ? "Creating" : "Create")
        .setDisabled(this.creating)
        .onClick(() => this.createSkill());
      button.setCta?.();
    });

    if (!this.creating) {
      nameControl?.inputEl?.focus?.();
    }
  }

  async createSkill() {
    if (this.creating) {
      return;
    }
    this.creating = true;
    this.errorMessage = "";
    this.existingPath = "";
    this.render();
    try {
      const created = await this.plugin.createUserSkill(this.skillName);
      this.onCreated?.();
      await this.closeSettingsAndOpenSkill(created.path);
    } catch (error) {
      this.creating = false;
      this.errorMessage = error instanceof Error ? error.message : "Unable to create the skill.";
      this.existingPath = error?.code === "skill-exists" ? String(error.existingPath || "") : "";
      this.render();
    }
  }

  async closeSettingsAndOpenSkill(path) {
    this.close();
    this.app?.setting?.close?.();
    try {
      await this.plugin.openSkillFile(path, true);
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "Unable to open the skill file.");
    }
  }
}

class CoDriverVaultDisableModal extends Modal {
  constructor(app, onConfirm, onCancel) {
    super(app);
    this.onConfirm = onConfirm;
    this.onCancel = onCancel;
    this.confirmed = false;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("codriver-provider-modal");
    contentEl.createEl("h2", { text: "Disable CoDriver Vault tools?" });
    contentEl.createEl("p", {
      text: "CoDriver will no longer be able to work with notes through its built-in vault tools."
    });
    contentEl.createEl("p", {
      text: "You will need to rely on external skills or MCP servers for vault access. External MCP create, write, patch, delete, move, command, and execute tools do not use CoDriver proposal review unless they are implemented through a controlled first-party adapter."
    });

    new Setting(contentEl)
      .addButton((button) => {
        button
          .setButtonText("Cancel")
          .onClick(() => {
            this.close();
          });
      })
      .addButton((button) => {
        button
          .setButtonText("Disable")
          .onClick(async () => {
            this.confirmed = true;
            button.setDisabled(true);
            await this.onConfirm?.();
            this.close();
          });
      });
  }

  onClose() {
    if (!this.confirmed) {
      this.onCancel?.();
    }
  }
}

const DETAILED_LOG_WARNING = "Detailed logs save assistant answers and tool arguments/results to a local file. They may contain private notes, personal data, or secrets returned by tools. Known credentials are redacted, but redaction is not guaranteed. Reasoning, prompts, and raw attachments/audio are excluded. Review logs before sharing.";

function diagnosticConfiguration(settings) {
  return JSON.stringify([settings.enableDiagnosticLogging, settings.diagnosticLogLevel, settings.diagnosticLogTarget]);
}

class DetailedLogConsentModal extends Modal {
  constructor(app, resolve) {
    super(app);
    this.resolve = resolve;
    this.accepted = false;
  }
  onOpen() {
    this.contentEl.empty();
    this.contentEl.addClass("codriver-provider-modal");
    this.contentEl.createEl("h2", { text: "Enable detailed logging?" });
    this.contentEl.createEl("p", { text: DETAILED_LOG_WARNING });
    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((button) => button.setCta().setButtonText("Enable detailed logging").onClick(() => {
        this.accepted = true;
        this.close();
      }));
  }
  onClose() { this.resolve(this.accepted); }
}

class DiagnosticLogShareModal extends Modal {
  constructor(app, options) {
    super(app);
    this.file = options.file;
    this.content = options.content;
    this.navigatorObject = options.navigatorObject;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("codriver-provider-modal");
    contentEl.createEl("h2", { text: "Share diagnostic log?" });
    contentEl.createEl("p", {
      text: "This file may include Detailed logs containing assistant answers, private note content, and tool arguments/results from earlier logging. Review it before sharing or copying. Known credential redaction is not guaranteed. Prompts, reasoning, and raw attachments/audio are excluded. If file sharing fails, the confirmed log will be copied to the clipboard."
    });

    new Setting(contentEl)
      .addButton((button) => {
        button
          .setButtonText("Cancel")
          .onClick(() => this.close());
      })
      .addButton((button) => {
        button
          .setCta()
          .setButtonText(canShareDiagnosticLogFile(this.navigatorObject, this.file) ? "Share" : "Copy")
          .onClick(() => {
            button.setDisabled(true);
            if (!canShareDiagnosticLogFile(this.navigatorObject, this.file)) {
              void copyDiagnosticLogWithNotice(this.navigatorObject, this.content);
              this.close();
              return;
            }
            startDiagnosticLogFileShare(this.navigatorObject, this.file, {
              onShared: () => new Notice("Diagnostic log shared."),
              onError: () => {
                void copyDiagnosticLogWithNotice(this.navigatorObject, this.content, "failed");
              }
            });
            this.close();
          });
      });
  }
}

class ProviderSettingsModal extends Modal {
  constructor(app, plugin, provider, onSaved) {
    super(app);
    this.plugin = plugin;
    this.provider = provider ? copyProvider(provider) : null;
    this.draft = provider ? copyProvider(provider) : this.plugin.createProviderDraft(OPENAI_PROVIDER_TYPE);
    if (!provider && this.draft.type === OPENAI_PROVIDER_TYPE) this.draft.endpoint = "";
    this.providerPresetId = "custom";
    this.manualModelEntered = false;
    this.modelCatalogUnavailable = false;
    this.onSaved = onSaved;
    this.credentialInput = "";
    this.savedKeyInput = "";
    this.credentialAction = "keep";
    this.showKey = false;
    this.loadCredential();
    // Obsidian's phone opening transition uses inline styles, not CSS animations.
    // Gate only the supported native opening hook; leave native close behavior intact.
    if (Platform.isMobile && typeof this.shouldAnimate === "boolean") {
      this.shouldAnimate = false;
    }
    this.render();
  }

  onOpen() {
    // Content is ready before Obsidian measures and displays the mobile modal.
    if (Platform.isMobile && this.shouldAnimate === false && this.bgEl) {
      this.bgEl.style.opacity = this.dimBackground ? this.bgOpacity : "0";
    }
  }

  onClose() {
    this.modelPickerPopover?.close();
    this.clearCredential();
    if (!this.keepPreparedChange) this.plugin.discardProviderCredentialDraft?.(this.saveCredentialDraft);
    if (this.saveCredentialDraft) this.saveCredentialDraft.credentialInput = "";
    this.saveCredentialDraft = null;
    this.busyControls = null;
    this.providerPresetButton = null;
    this.provider = null;
    this.draft = null;
    this.contentEl.empty();
  }

  clearCredential() {
    if (this.secretInputEl) this.secretInputEl.value = "";
    this.secretInputEl = null;
    this.credentialInput = "";
    this.savedKeyInput = "";
    this.credentialAction = "keep";
    this.showKey = false;
  }

  loadCredential() {
    this.credentialError = "";
    try {
      const service = this.plugin.getProviderCredentialService?.();
      service?.access?.assertStorage();
      if (!this.draft.apiKeySecretName) return;
      this.savedKeyInput = service.resolve(this.draft);
      this.credentialInput = this.savedKeyInput;
    } catch (error) {
      this.credentialError = error instanceof ProviderCredentialError ? error.message : "Provider credentials are unavailable.";
    }
  }

  credentialDraft() {
    return { ...this.draft, credentialInput: this.credentialInput, credentialAction: this.credentialAction };
  }

  setBusyControls(allowCancel = false) {
    this.modelPickerPopover?.close();
    this.busyControls = new Map();
    const visit = (parent) => {
      for (const element of Array.from(parent.children ?? [])) {
        if (["input", "textarea", "select", "button"].includes(element.tagName?.toLowerCase())) {
          if (allowCancel && element.textContent === "Cancel") continue;
          this.busyControls.set(element, element.disabled);
          element.disabled = true;
        }
        visit(element);
      }
    };
    visit(this.contentEl);
  }

  restoreBusyControls() {
    for (const [element, disabled] of this.busyControls ?? []) element.disabled = disabled;
    this.busyControls = null;
  }

  render(statusText = "", statusOk = null) {
    if (!this.draft) return;
    if (this.secretInputEl) this.secretInputEl.value = "";
    this.secretInputEl = null;
    this.modelPickerPopover?.close();
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("codriver-provider-modal");

    this.saveButtons = [];
    this.providerPresetButton = null;
    contentEl.toggleClass("codriver-openai-provider-modal", this.draft.type === OPENAI_PROVIDER_TYPE);
    const header = contentEl.createDiv({ cls: "codriver-provider-modal-header" });
    header.createEl("h2", { text: this.provider ? "Edit model" : "Add model" });
    this.renderActions(header, true);

    new Setting(contentEl)
      .setName("Provider type")
      .addDropdown((dropdown) => {
        for (const option of PROVIDER_TYPE_OPTIONS) {
          dropdown.addOption(option.value, option.label);
        }

        dropdown
          .setValue(this.draft.type)
          .onChange((value) => {
            this.changeProviderType(value);
          });
      });

    if (this.draft.type === OPENAI_PROVIDER_TYPE) this.renderProviderPreset(contentEl);

    new Setting(contentEl)
      .setName("Name")
      .addText((text) => {
        text
          .setValue(this.draft.name ?? "")
          .onChange((value) => {
            this.draft.name = value;
          });
      });

    const endpointSetting = new Setting(contentEl)
      .setName(this.draft.type === OPENAI_PROVIDER_TYPE ? "Endpoint" : "Base endpoint")
      .addText((text) => {
        text.inputEl.classList.add("codriver-endpoint-input");
        text.inputEl.disabled = this.draft.type === ANTHROPIC_PROVIDER_TYPE;
        text.inputEl.readOnly = this.draft.type === OPENAI_PROVIDER_TYPE && this.providerPresetId !== "custom";
        text
          .setValue(this.draft.endpoint ?? "")
          .onChange((value) => {
            if (this.draft.type === OPENAI_PROVIDER_TYPE && this.providerPresetId !== "custom") return;
            this.draft.endpoint = value.trim();
          });
      });
    endpointSetting.settingEl.classList.add("codriver-provider-endpoint-setting");
    if (this.draft.type === OPENAI_PROVIDER_TYPE && this.providerPresetId === "alibaba") {
      endpointSetting.setDesc("Choose Custom to enter your regional workspace base URL from the Alibaba Cloud console.");
    }

    if (this.draft.type === GEMINI_PROVIDER_TYPE) {
      new Setting(contentEl)
        .setName("API version")
        .addText((text) => {
          text
            .setValue(this.draft.apiVersion || DEFAULT_GEMINI_API_VERSION)
            .onChange((value) => {
              this.draft.apiVersion = value.trim();
            });
        });
    }

    const keySetting = new Setting(contentEl).setName("API key");
    this.secretInputEl = renderSecretInput(keySetting, {
      value: this.credentialInput, visible: this.showKey, disabled: this.saving || this.testing,
      label: "Provider API key", visibilityLabel: "API key", placeholder: "API key",
      onVisibilityChange: (visible) => { this.showKey = visible; },
      onChange: (value) => {
        this.credentialInput = value;
        const pending = this.plugin.pendingProviderKeys?.some((entry) => entry.id === this.provider?.id);
        this.credentialAction = !value ? "clear" : !pending && !this.credentialError && value === this.savedKeyInput ? "keep" : "replace";
      }
    });
    const credentialStatus = this.credentialError || (this.provider && this.plugin.getProviderCredentialStatus?.(this.provider)) || "";
    if (credentialStatus) {
      const attention = new Setting(contentEl).setName("Credentials need attention").setDesc(credentialStatus);
      attention.addButton((button) => button.setButtonText("Retry migration").setDisabled(this.saving || this.testing)
        .onClick(async () => {
          button.setDisabled(true);
          try {
            await this.plugin.retryProviderCredentialMigration();
            const current = this.plugin.getProviderSettings(this.provider.id);
            if (!this.draft) return;
            this.provider = copyProvider(current);
            this.draft.apiKeySecretName = current.apiKeySecretName;
            if (this.credentialAction === "keep") { this.clearCredential(); this.loadCredential(); }
            this.render(this.plugin.getProviderCredentialStatus(current));
          } catch { this.render("Unable to retry provider migration. Existing credentials were preserved.", false); }
        }));
      attention.addButton((button) => button.setButtonText("Clear key").setDisabled(this.saving || this.testing)
        .onClick(() => { this.credentialInput = ""; this.credentialAction = "clear"; this.render(); }));
    }

    const modelSetting = new Setting(contentEl).setName("Default model");
    modelSetting.settingEl.classList.add("codriver-provider-model-setting");
    const models = this.getDraftModels();
    const selectedValue = models.includes(this.draft.model) ? this.draft.model : models[0] ?? "";
    let modelIdInput = null;
    const modelButton = modelSetting.controlEl.createEl("button", {
      cls: "codriver-model-select-trigger",
      text: selectedValue || "Load models first",
      attr: { type: "button", "aria-label": "Select default model", title: selectedValue || "Load models first" }
    });
    modelButton.disabled = models.length === 0;
    const pickerOptions = {
      label: "Select default model", selectedValue,
      groups: [{ label: "", models: models.map((model) => ({ model, label: model, value: model })) }],
      onChoose: (value) => {
        this.draft.model = value;
        if (this.draft.type === OPENAI_PROVIDER_TYPE && !this.draft.models?.includes(value)) {
          this.draft.models = [...(this.draft.models || []), value];
        }
        this.manualModelEntered = false;
        if (modelIdInput) modelIdInput.value = value;
        modelButton.textContent = value;
        modelButton.title = value;
        pickerOptions.selectedValue = value;
      }
    };
    bindModelPicker(this, modelButton, pickerOptions);
    modelSetting.addButton((button) => {
        button
          .setButtonText(this.draft.type === OPENAI_PROVIDER_TYPE ? "Load models" : "Test connection")
          .onClick(async () => {
            if (this.testing || this.saving) return;
            if (!this.validateProviderEndpoint()) return;
            this.testing = true;
            this.setBusyControls(true);
            let result;
            try { result = await this.plugin.testProviderDraftConnection(this.credentialDraft()); }
            catch { result = { ok: false, models: [], message: "Unable to connect to the provider. Check the endpoint, API key and account access." }; }
            finally { this.testing = false; this.restoreBusyControls(); }
            if (!this.draft) return;
            this.modelCatalogUnavailable = !result.ok || !result.models?.length;
            if (result.ok) {
              this.draft.models = result.models;
              if (this.manualModelEntered && this.draft.model.trim()) {
                this.draft.models = this.getDraftModels();
              }
              this.draft.model = this.draft.models.includes(this.draft.model)
                ? this.draft.model
                : this.draft.models[0] ?? "";
            }
            button.setDisabled(false);
            const message = this.draft.type === OPENAI_PROVIDER_TYPE
              ? result.ok ? result.models.length ? "Model list loaded. Chat compatibility depends on the selected model."
                : "No models returned. You can enter a model ID manually."
                : `${result.message} You can enter a model ID manually.`
              : result.message;
            this.render(message, result.ok);
          });
      });

    if (this.draft.type === OPENAI_PROVIDER_TYPE) {
      const manualSetting = new Setting(contentEl).setName("Model ID").addText((text) => {
        modelIdInput = text.inputEl;
        modelIdInput.setAttribute("aria-label", "Model ID");
        modelIdInput.setAttribute("placeholder", "Optional");
        modelIdInput.spellcheck = false;
        text.setValue(this.draft.model || "").onChange((value) => {
          this.draft.model = value.trim();
          this.manualModelEntered = Boolean(this.draft.model);
          this.modelPickerPopover?.close();
          const currentModels = this.getDraftModels();
          modelButton.textContent = this.draft.model || (currentModels.length ? "Choose loaded model" : "Load models first");
          modelButton.title = modelButton.textContent;
          modelButton.disabled = currentModels.length === 0;
          pickerOptions.selectedValue = this.draft.model;
          pickerOptions.groups = [{ label: "", models: currentModels.map((model) => ({ model, label: model, value: model })) }];
        });
      });
      manualSetting.settingEl.classList.add("codriver-provider-model-id-setting");
      manualSetting.settingEl.hidden = !this.shouldShowManualModelId();
    }

    if (statusText) {
      const status = contentEl.createDiv({ cls: "codriver-setting-status", text: statusText });
      if (statusOk !== null) status.addClass(statusOk ? "is-success" : "is-error");
      status.setAttribute("role", statusOk === false ? "alert" : "status");
    }
    if (this.otherKeysPending) {
      new Setting(contentEl).setDesc("Prepared changes stay in memory until all legacy keys are resolved. Cancel discards this change; restart discards all prepared changes.")
        .addButton((button) => button.setButtonText("Keep prepared change").onClick(() => {
          this.keepPreparedChange = true;
          this.close();
          this.onSaved?.();
        }));
    }

    this.renderGenerationParameters(contentEl);

    this.renderActions(contentEl);
  }

  renderActions(container, header = false) {
    const setting = new Setting(container)
      .addButton((button) => {
        button
          .setButtonText("Cancel")
          .setDisabled(this.saving === true)
          .onClick(() => this.close());
      })
      .addButton((button) => {
        button
          .setCta()
          .setButtonText("Save")
          .setDisabled(this.saving === true || this.testing === true)
          .onClick(() => this.saveDraft());
        this.saveButtons.push(button);
      });
    if (header) {
      setting.settingEl.removeClass("setting-item");
      setting.settingEl.addClass("codriver-provider-modal-header-actions");
    }
  }

  async saveDraft() {
    if (this.saving || this.testing) return;
    if (!this.validateProviderEndpoint()) return;
    if (this.draft.type === OPENAI_PROVIDER_TYPE && this.manualModelEntered) this.draft.models = this.getDraftModels();
    this.saving = true;
    let failure = "";
    this.setBusyControls();
    for (const button of this.saveButtons) button.setDisabled(true);
    try {
      // Preserve draft identity across a failed commit so verified secrets are reused.
      this.saveCredentialDraft ??= {};
      Object.assign(this.saveCredentialDraft, this.credentialDraft());
      await this.plugin.saveProviderDraft(this.saveCredentialDraft);
      this.close();
      this.onSaved?.();
    } catch (error) {
      const message = error instanceof ProviderCredentialError ? error.message : "Unable to save provider settings.";
      failure = message;
      this.otherKeysPending = error instanceof ProviderCredentialError && error.code === "other-pending";
      new Notice(message);
    } finally {
      this.saving = false;
      this.restoreBusyControls();
      for (const button of this.saveButtons) button.setDisabled(false);
      if (this.draft) this.render(failure, failure ? false : null);
    }
  }

  changeProviderType(type) {
    if (this.saving || this.testing) return;
    this.clearCredential();
    this.plugin.discardProviderCredentialDraft?.(this.saveCredentialDraft);
    this.credentialError = "";
    this.saveCredentialDraft = null;
    this.otherKeysPending = false;
    const next = this.plugin.createProviderDraft(type);
    if (type === OPENAI_PROVIDER_TYPE) next.endpoint = "";
    this.providerPresetId = "custom";
    this.manualModelEntered = false;
    this.modelCatalogUnavailable = false;
    const existingId = this.provider?.id;
    this.draft = {
      ...next,
      id: existingId ?? next.id
    };
    this.credentialAction = this.provider ? "clear" : "keep";
    this.render();
  }

  renderProviderPreset(contentEl) {
    const setting = new Setting(contentEl).setName("Preset");
    setting.settingEl.classList.add("codriver-provider-preset-setting");
    const selected = OPENAI_COMPATIBLE_PRESETS.find((preset) => preset.id === this.providerPresetId)
      || OPENAI_COMPATIBLE_PRESETS[0];
    const button = setting.controlEl.createEl("button", {
      cls: "codriver-model-select-trigger",
      text: selected.name,
      attr: { type: "button", "aria-label": "Select provider preset", title: selected.name }
    });
    this.providerPresetButton = button;
    bindModelPicker(this, button, {
      label: "Select provider preset", listLabel: "Provider presets", searchLabel: "Search provider presets",
      searchFirst: true,
      searchPlaceholder: "Search providers...", emptyText: "No matching providers", selectedValue: selected.id,
      groups: [{ label: "", models: OPENAI_COMPATIBLE_PRESETS.map((preset) => ({
        model: `${preset.name} ${preset.aliases}`, label: preset.name, value: preset.id
      })) }],
      onChoose: (id) => this.applyProviderPreset(id)
    });
  }

  applyProviderPreset(id) {
    if (!this.draft || this.draft.type !== OPENAI_PROVIDER_TYPE || this.saving || this.testing) return;
    const proposal = getOpenAiCompatiblePresetUpdate(this.draft, id);
    if (!proposal) return;
    const hadValues = Boolean(this.credentialInput || this.draft.apiKeySecretName || this.draft.model
      || this.draft.models?.length || this.draft.temperature || this.draft.topP || this.draft.topK || this.draft.reasoningEffort);
    if (proposal.endpointChanged) {
      this.plugin.discardProviderCredentialDraft?.(this.saveCredentialDraft);
      if (this.saveCredentialDraft) this.saveCredentialDraft.credentialInput = "";
      this.saveCredentialDraft = null;
      this.otherKeysPending = false;
      this.clearCredential();
      this.credentialAction = "clear";
      this.credentialError = "";
      this.manualModelEntered = false;
      this.modelCatalogUnavailable = false;
    }
    Object.assign(this.draft, proposal.update);
    this.providerPresetId = id;
    this.render(proposal.endpointChanged && hadValues ? "Endpoint changed. Draft key, models and parameters cleared." : "");
    this.providerPresetButton?.focus();
  }

  getDraftModels() {
    const models = Array.isArray(this.draft.models) ? this.draft.models : [];
    if (this.draft.type === OPENAI_PROVIDER_TYPE && this.manualModelEntered && this.draft.model
      && !models.includes(this.draft.model)) return [...models, this.draft.model];
    return models;
  }

  shouldShowManualModelId() {
    if (this.draft.type !== OPENAI_PROVIDER_TYPE) return false;
    if (this.modelCatalogUnavailable) return true;
    // Catalog support is unverified or incompatible with the current adapter for these templates.
    return ["custom", "together", "fireworks", "deepinfra", "zai", "nvidia", "alibaba"].includes(this.providerPresetId);
  }

  validateProviderEndpoint() {
    if (this.draft.type !== OPENAI_PROVIDER_TYPE) return true;
    const message = getOpenAiCompatibleEndpointError(this.draft.endpoint);
    if (!message) return true;
    this.render(message, false);
    return false;
  }

  renderGenerationParameters(contentEl) {
    contentEl.createEl("h3", { text: "Additional parameters" });

    if (this.draft.type === ANTHROPIC_PROVIDER_TYPE) {
      renderRequiredInteger(contentEl, this.draft, {
        key: "maxOutputTokens",
        name: "Max output tokens",
        desc: "Maximum tokens Claude may generate.",
        min: 1
      });

      new Setting(contentEl)
        .setName("Prompt caching")
        .setDesc("Request native automatic prompt caching for stable tools, system instructions, and conversation prefixes.")
        .addToggle((toggle) => {
          toggle
            .setValue(this.draft.enablePromptCaching !== false)
            .onChange((value) => {
              this.draft.enablePromptCaching = value;
              this.render();
            });
        });

      if (this.draft.enablePromptCaching !== false) {
        new Setting(contentEl)
          .setName("Cache TTL")
          .setDesc("One-hour cache writes cost more than the default five-minute cache writes.")
          .addDropdown((dropdown) => {
            dropdown
              .addOption("5m", "5 minutes")
              .addOption("1h", "1 hour")
              .setValue(this.draft.promptCacheTtl === "1h" ? "1h" : "5m")
              .onChange((value) => {
                this.draft.promptCacheTtl = value;
              });
          });
      }
      return;
    }

    renderOptionalSlider(contentEl, this.draft, {
      key: "temperature",
      name: "Temperature",
      desc: "Controls randomness.",
      min: 0,
      max: 2,
      step: 0.01,
      defaultValue: 1
    });

    renderOptionalSlider(contentEl, this.draft, {
      key: "topP",
      name: "Top P",
      desc: "Sampling threshold.",
      min: 0,
      max: 1,
      step: 0.01,
      defaultValue: 1
    });

    renderOptionalInteger(contentEl, this.draft, {
      key: "topK",
      name: "Top K",
      desc: "Sampling candidate limit.",
      min: 1
    });

    if (this.draft.type === GEMINI_PROVIDER_TYPE) {
      renderOptionalInteger(contentEl, this.draft, {
        key: "maxOutputTokens",
        name: "Max output tokens",
        desc: "Optional response length limit.",
        min: 1
      });

      renderOptionalInteger(contentEl, this.draft, {
        key: "thinkingBudget",
        name: "Thinking budget",
        desc: "Gemini thinking token budget. Empty sends no thinking budget.",
        min: 0
      });

      renderOptionalDropdown(contentEl, this.draft, {
        key: "thinkingLevel",
        name: "Thinking level",
        desc: "Gemini 3 reasoning depth. Empty sends no thinking level.",
        options: [
          { value: "MINIMAL", label: "Minimal" },
          { value: "LOW", label: "Low" },
          { value: "MEDIUM", label: "Medium" },
          { value: "HIGH", label: "High" }
        ]
      });

      new Setting(contentEl)
        .setName("Tool mode")
        .addDropdown((dropdown) => {
          dropdown
            .addOption("custom-tools", "Custom tools")
            .addOption("google-search", "Google Search")
            .setValue(this.draft.enableGoogleSearch === true ? "google-search" : "custom-tools")
            .onChange((value) => {
              this.draft.enableGoogleSearch = value === "google-search";
            });
        });
      contentEl.createDiv({
        cls: "codriver-gemini-tool-mode-note",
        text: "Gemma models cannot combine Google Search and custom tools. Choose one mode."
      });

    } else {
      renderReasoningSetting(contentEl, this.draft);
    }
  }
}

class McpServerSettingsModal extends Modal {
  constructor(app, plugin, server, onSaved) {
    super(app);
    this.plugin = plugin;
    this.server = server ? copyMcpServer(server) : null;
    this.draft = server ? copyMcpServer(server) : this.plugin.createMcpServerDraft();
    this.draft.authMode ??= this.draft.headers ? "custom-headers" : "none";
    this.onSaved = onSaved;
    this.commandInput = formatMcpCommand(this.draft);
    this.credentialInput = "";
    this.savedCredentialInput = "";
    this.credentialAction = "keep";
    this.showInput = false;
    this.saving = false;
    this.oauthBusy = false;
  }

  onOpen() {
    let message = "";
    if (this.server?.authMode === "oauth" && !Platform.isMobile) {
      try {
        this.savedCredentialInput = this.plugin.getMcpOAuthService().read(this.server)?.clientSecret || "";
        this.credentialInput = this.savedCredentialInput;
      } catch (error) { message = error instanceof McpOAuthError ? error.message : "OAuth credentials are unavailable."; }
    }
    if (this.server?.transport === MCP_HTTP_TRANSPORT && ["bearer", "custom-headers"].includes(this.server.authMode) && this.server.authSecretName) {
      try {
        this.savedCredentialInput = this.plugin.getMcpCredentialService().readInputValue(this.server);
        this.credentialInput = this.savedCredentialInput;
      } catch (error) {
        message = error instanceof McpCredentialError ? error.message : "MCP credentials are unavailable.";
      }
    }
    this.render(message);
  }

  onClose() {
    if (this.oauthBusy && this.server) this.plugin.getMcpOAuthService().cancel(this.server.id);
    this.oauthReviewModal?.close();
    this.oauthReviewModal = null;
    this.credentialInput = "";
    this.savedCredentialInput = "";
    if (this.secretInputEl) this.secretInputEl.value = "";
    this.secretInputEl = null;
    this.commandInput = "";
    this.server = null;
    this.draft = null;
    this.contentEl.empty();
  }

  render(statusText = "") {
    if (!this.draft) return;
    this.oauthConnectButton = null;
    if (this.secretInputEl) this.secretInputEl.value = "";
    this.secretInputEl = null;
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("codriver-provider-modal", "codriver-mcp-modal");
    this.modalEl?.addClass("codriver-mcp-modal-shell");
    contentEl.createEl("h2", { text: this.server ? "Edit MCP server" : "Add MCP server" });
    const stdioSupported = isStdioMcpSupported(this.plugin);
    const mobileOAuth = Platform.isMobile && this.draft.authMode === "oauth";
    const blocked = (this.draft.transport === MCP_STDIO_TRANSPORT && !stdioSupported) || mobileOAuth;
    const oauthLocked = this.oauthFieldsLocked();
    const status = contentEl.createDiv({ cls: "codriver-setting-status", text: statusText });
    status.setAttribute("role", statusText ? "alert" : "status");
    if (statusText) {
      status.addClass("is-error");
      contentEl.scrollTop = 0;
    }
    if (blocked) contentEl.createDiv({ cls: "codriver-setting-status", text: mobileOAuth ? "This OAuth connection is available on desktop only." : getStdioMcpUnavailableMessage(this.plugin) });
    const credentialStatus = this.server ? this.plugin.getMcpCredentialStatus?.(this.server) : "";
    if (credentialStatus && this.server.authMode !== "oauth") {
      new Setting(contentEl).setName("Credentials need attention").setDesc(credentialStatus)
        .addButton((button) => button.setButtonText("Retry migration").setDisabled(this.saving)
          .onClick(async () => {
            button.setDisabled(true);
            await this.plugin.retryMcpCredentialMigration(this.server.id);
            this.server = copyMcpServer(this.plugin.getMcpServerSettings(this.server.id));
            this.draft.authMode = this.server.authMode ?? this.draft.authMode;
            this.draft.authSecretName = this.server.authSecretName;
            this.draft.credentialSchemaVersion = this.server.credentialSchemaVersion;
            if (this.server.authHeaderPolicy != null) this.draft.authHeaderPolicy = this.server.authHeaderPolicy;
            else delete this.draft.authHeaderPolicy;
            this.render(this.plugin.getMcpCredentialStatus(this.server));
          }));
    }

    new Setting(contentEl).setName("Name").addText((text) => {
      text.setValue(this.draft.name).setDisabled(blocked || this.saving || this.oauthBusy).onChange((value) => { this.draft.name = value; this.updateOAuthControls(); });
      text.inputEl.setAttribute("aria-label", "MCP server name");
    });
    new Setting(contentEl).setName("Transport").addDropdown((dropdown) => {
      if (stdioSupported || this.draft.transport === MCP_STDIO_TRANSPORT) dropdown.addOption(MCP_STDIO_TRANSPORT, "stdio");
      dropdown.addOption(MCP_HTTP_TRANSPORT, "HTTP").setValue(this.draft.transport)
        .setDisabled(blocked || oauthLocked || this.saving || this.oauthBusy).onChange((value) => {
          this.draft.transport = value;
          this.credentialInput = "";
          this.credentialAction = "keep";
          this.render();
        });
      dropdown.selectEl?.setAttribute("aria-label", "MCP transport");
    });
    new Setting(contentEl).setName("Enabled").addToggle((toggle) => {
      toggle.setValue(this.draft.enabled !== false).setDisabled(blocked || oauthLocked || this.saving || this.oauthBusy)
        .onChange((value) => { this.draft.enabled = value; this.updateOAuthControls(); });
    });
    if (this.draft.transport === MCP_HTTP_TRANSPORT && mobileOAuth) {
      new Setting(contentEl).setName("Authentication").setDesc("OAuth 2 - desktop only");
    } else if (this.draft.transport === MCP_HTTP_TRANSPORT) {
      new Setting(contentEl).setName("Endpoint").addText((text) => {
        text.setValue(this.draft.endpoint ?? "").setPlaceholder("https://example.com/mcp")
          .setDisabled(oauthLocked || this.saving || this.oauthBusy).onChange((value) => {
            this.draft.endpoint = value;
            if (this.draft.authMode === "oauth") this.clearOAuthSecretDraft();
            this.updateOAuthControls();
          });
        text.inputEl.setAttribute("aria-label", "MCP HTTP endpoint");
      });
      new Setting(contentEl).setName("Authentication").addDropdown((dropdown) => {
        dropdown.addOption("bearer", "Bearer");
        if (!Platform.isMobile) dropdown.addOption("oauth", "OAuth 2");
        dropdown.addOption("custom-headers", "Custom headers").addOption("none", "None");
        dropdown.setValue(this.draft.authMode)
          .setDisabled(oauthLocked || this.saving || this.oauthBusy).onChange((value) => {
            this.draft.authMode = value;
            this.credentialInput = "";
            this.credentialAction = value === "none" ? "clear" : "replace";
            this.render();
          });
        dropdown.selectEl?.setAttribute("aria-label", "MCP authentication method");
      });
      if (this.draft.authMode === "bearer") {
        const authentication = new Setting(contentEl).setName("Authorization: Bearer");
        authentication.settingEl.addClass("codriver-mcp-bearer-row");
        this.secretInputEl = renderSecretInput(authentication, {
          value: this.credentialInput, visible: this.showInput, disabled: this.saving, placeholder: "Token only",
          label: "MCP bearer token", visibilityLabel: "token",
          onVisibilityChange: (visible) => { this.showInput = visible; },
          onChange: (value) => {
            this.credentialInput = value;
            this.credentialAction = !value ? "clear" : value === this.savedCredentialInput && this.server?.authMode === "bearer" ? "keep" : "replace";
          }
        });
      } else if (this.draft.authMode === "oauth") {
        this.renderOAuthSettings(contentEl);
      } else if (this.draft.authMode !== "none") {
        new Setting(contentEl).setName("Headers").setDesc("Stored in Obsidian keychain").addTextArea((text) => {
          text.setValue(this.credentialInput).setDisabled(this.saving).onChange((value) => {
            this.credentialInput = value;
            this.credentialAction = !value.trim() ? "clear" : value === this.savedCredentialInput && this.server?.authMode === "custom-headers" ? "keep" : "replace";
          });
          text.inputEl.setAttribute("aria-label", "MCP custom headers");
          text.inputEl.setAttribute("autocomplete", "off");
          text.inputEl.spellcheck = false;
          this.secretInputEl = text.inputEl;
          text.setPlaceholder("Authorization: Bearer ...\nX-Workspace: team-alpha");
        });
      }
    } else {
      new Setting(contentEl).setName("Command").setDesc("One program with arguments. Stored in plugin settings.")
        .addTextArea((text) => {
          text.setValue(this.commandInput).setPlaceholder('npx -y @example/mcp-server\n  --workspace "/home/user/Notes"')
            .setDisabled(blocked || this.saving).onChange((value) => { this.commandInput = value; });
          text.inputEl.setAttribute("aria-label", "MCP command and arguments");
          text.inputEl.spellcheck = false;
        });
      new Setting(contentEl).setName("Environment").setDesc("One KEY=value per line. Stored in plugin settings.")
        .addTextArea((text) => {
          text.setValue(this.draft.env ?? "").setPlaceholder("WORKSPACE_ID=team-alpha")
            .setDisabled(blocked || this.saving).onChange((value) => { this.draft.env = value; });
          text.inputEl.setAttribute("aria-label", "MCP environment variables");
          text.inputEl.spellcheck = false;
        });
    }
    const footer = new Setting(contentEl);
    footer.settingEl.addClass("codriver-mcp-modal-footer");
    footer.addButton((button) => button.setButtonText("Cancel").setDisabled(this.saving).onClick(() => this.close()));
    footer.addButton((button) => button.setButtonText(this.saving ? "Saving..." : "Save").setCta().setDisabled(blocked || this.saving || this.oauthBusy).onClick(async () => {
      if (this.saving) return;
      try {
        if (this.draft.transport === MCP_STDIO_TRANSPORT) Object.assign(this.draft, parseMcpCommand(this.commandInput, this.server));
        const draft = this.draft;
        draft.credentialInput = this.credentialInput;
        draft.credentialAction = this.credentialAction;
        this.saving = true;
        this.render();
        await this.plugin.saveMcpServerDraft(draft);
        this.saving = false;
        this.close();
        this.onSaved?.();
      } catch (error) {
        this.saving = false;
        const message = error instanceof McpCredentialError || error instanceof McpCommandError || error instanceof McpOAuthError ? error.message : "Unable to save MCP server. Check the command and settings, then retry.";
        this.render(message);
        new Notice(message);
      }
    }));
  }

  oauthDraftChanged() {
    const keys = ["transport", "endpoint", "authMode", "enabled"];
    if (!this.server || keys.some((key) => this.draft[key] !== this.server[key]) || this.credentialAction !== "keep") return true;
    return (this.draft.oauthRegistration || "automatic") !== (this.server.oauthRegistration || "automatic")
      || (this.draft.oauthClientId || "") !== (this.server.oauthClientId || "")
      || String(this.draft.oauthCallbackPort || "") !== String(this.server.oauthCallbackPort || "");
  }

  clearOAuthSecretDraft() {
    this.credentialInput = ""; this.savedCredentialInput = ""; this.credentialAction = "replace";
    if (this.secretInputEl) this.secretInputEl.value = "";
  }

  renderOAuthSettings(contentEl) {
    const locked = this.oauthFieldsLocked();
    this.draft.oauthRegistration ??= "automatic";
    const registration = new Setting(contentEl).setName("Client registration");
    registration.settingEl.addClass("codriver-oauth-registration");
    registration.addDropdown((dropdown) => {
      dropdown.addOption("automatic", "Automatic").addOption("existing", "Existing client")
        .setValue(this.draft.oauthRegistration).setDisabled(locked || this.saving || this.oauthBusy)
        .onChange((value) => { this.draft.oauthRegistration = value; this.render(); });
    });
    if (this.draft.oauthRegistration === "automatic") this.addOAuthAction(registration);
    if (this.draft.oauthRegistration === "existing") {
      new Setting(contentEl).setName("Client ID").addText((text) => {
        text.setValue(this.draft.oauthClientId || "").setDisabled(locked || this.saving || this.oauthBusy)
          .onChange((value) => { this.draft.oauthClientId = value; this.clearOAuthSecretDraft(); this.updateOAuthControls(); });
        text.inputEl.setAttribute("aria-label", "OAuth Client ID");
      });
      const secret = new Setting(contentEl).setName("Client Secret").setDesc("Optional");
      secret.settingEl.addClass("codriver-oauth-client-secret");
      this.secretInputEl = renderSecretInput(secret, {
        value: this.credentialInput, visible: this.showInput, disabled: locked || this.saving || this.oauthBusy,
        placeholder: "", label: "OAuth Client Secret", visibilityLabel: "client secret",
        onVisibilityChange: (visible) => { this.showInput = visible; },
        onChange: (value) => { this.credentialInput = value; this.credentialAction = value === this.savedCredentialInput ? "keep" : "replace"; this.updateOAuthControls(); }
      });
      new Setting(contentEl).setName("Callback port").setDesc("Optional").addText((text) => {
        text.setValue(String(this.draft.oauthCallbackPort || "")).setPlaceholder("Automatic").setDisabled(locked || this.saving || this.oauthBusy)
          .onChange((value) => { this.draft.oauthCallbackPort = value; this.updateOAuthControls(); });
        text.inputEl.setAttribute("inputmode", "numeric"); text.inputEl.setAttribute("aria-label", "OAuth callback port");
      });
      const connection = new Setting(contentEl);
      connection.settingEl.addClass("codriver-oauth-connection");
      this.addOAuthAction(connection);
    }
    this.updateOAuthControls();
  }

  addOAuthAction(connection) {
    connection.addButton((button) => {
      this.oauthConnectButton = button;
      button.onClick(async () => {
        if (this.saving) return;
        const service = this.plugin.getMcpOAuthService();
        if (this.oauthBusy) {
          service.cancel(this.server.id); this.oauthReviewModal?.close(); this.oauthBusy = false; this.render(); return;
        }
        if (this.oauthIsConnected()) {
          this.saving = true; this.render();
          try { await service.disconnect(this.server); this.saving = false; this.render(); this.onSaved?.(); }
          catch (error) { this.saving = false; this.render(error instanceof McpOAuthError ? error.message : "OAuth cleanup failed."); }
          return;
        }
        await this.connectOAuth();
      });
    });
  }

  oauthIsConnected() {
    return this.oauthFieldsLocked();
  }

  oauthFieldsLocked() {
    if (this.server?.authMode !== "oauth") return false;
    const service = this.plugin.getMcpOAuthService();
    try { return service.locked ? service.locked(this.server) : service.status(this.server) === "Connected"; }
    catch { return true; }
  }

  updateOAuthControls() {
    if (!this.draft || this.draft.authMode !== "oauth" || !this.oauthConnectButton) return;
    const service = this.plugin.getMcpOAuthService(), connected = this.oauthIsConnected();
    this.oauthConnectButton.setButtonText(this.oauthBusy ? "Cancel authorization" : connected ? "Disconnect" : "Connect")
      .setDisabled(this.saving || this.draft.enabled === false || !service.supported());
    this.oauthConnectButton.buttonEl.toggleClass("mod-warning", connected && !this.oauthBusy);
  }

  async connectOAuth() {
    if (!this.draft || this.saving || this.oauthBusy || this.draft.enabled === false) return;
    const service = this.plugin.getMcpOAuthService();
    if (!service.supported()) return;
    this.oauthBusy = true; this.render();
    try {
      const draft = copyMcpServer(this.draft);
      draft.credentialInput = this.credentialInput;
      draft.credentialAction = this.credentialAction;
      this.saving = true; this.render();
      let saved;
      try { saved = await this.plugin.saveMcpServerDraft(draft); }
      finally { this.saving = false; }
      // Closing while saving must not start a new authorization or restore the modal draft.
      if (!this.draft || !this.oauthBusy) return;
      this.server = copyMcpServer(saved); this.draft = copyMcpServer(saved);
      this.savedCredentialInput = service.read(saved)?.clientSecret || "";
      this.credentialInput = this.savedCredentialInput; this.credentialAction = "keep";
      this.onSaved?.(); this.render();
      const review = await service.prepare(this.server);
      if (!this.draft || !this.oauthBusy) return;
      this.oauthReviewModal = new McpOAuthReviewModal(this.app, this.server.name, review, async () => {
        try {
          const pending = service.authorize(this.server, (url) => { this.render(); window.open(url); });
          this.render(); await pending;
          if (this.draft) this.draft = copyMcpServer(this.server);
          this.oauthBusy = false; if (this.draft) this.render(); this.onSaved?.();
        } catch (error) { this.oauthBusy = false; if (this.draft) this.render(error instanceof McpOAuthError ? error.message : "OAuth connection failed."); }
      }, () => { service.cancel(this.server.id); this.oauthBusy = false; if (this.draft) this.render(); });
      this.oauthReviewModal.open();
    } catch (error) { this.oauthBusy = false; if (this.draft) this.render(error instanceof McpOAuthError || error instanceof McpCredentialError ? error.message : "Unable to save or connect the MCP server. Review the settings and retry."); }
  }
}

class McpOAuthReviewModal extends Modal {
  constructor(app, name, review, accept, cancel) { super(app); this.serverName = name; this.review = review; this.accept = accept; this.cancel = cancel; this.accepted = false; }
  onOpen() {
    this.contentEl.createEl("h2", { text: `Authorize ${this.serverName}` });
    new Setting(this.contentEl).setName("Authorization server").setDesc(new URL(this.review.issuer).host);
    new Setting(this.contentEl).setName("Requested access").setDesc(this.review.scope || "Server default scopes");
    if (this.review.resource && this.review.resource !== this.review.endpoint) {
      new Setting(this.contentEl).setName("MCP endpoint").setDesc(this.review.endpoint);
      new Setting(this.contentEl).setName("OAuth resource").setDesc(this.review.resource);
    }
    new Setting(this.contentEl).addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((button) => button.setButtonText("Continue in browser").setCta().onClick(() => { this.accepted = true; this.close(); void this.accept(); }));
  }
  onClose() { if (!this.accepted) this.cancel(); this.contentEl.empty(); }
}
module.exports = {
  BuiltinSkillResetModal,
  CoDriverSettingTab,
  McpServerSettingsModal,
  ProviderSettingsModal,
  NewCommandModal,
  NewSkillModal
};

function copyProvider(provider) {
  return JSON.parse(JSON.stringify(provider));
}

function copyMcpServer(server) {
  return JSON.parse(JSON.stringify(server));
}

function createMcpServerSubtitle(server, runtimeBlocked = false) {
  const transport = server.transport || MCP_STDIO_TRANSPORT;
  const target = transport === MCP_HTTP_TRANSPORT
    ? safeMcpEndpointLabel(server.endpoint)
    : (server.command || "No command");
  const toolCount = Array.isArray(server.tools) ? server.tools.length : 0;
  const suffix = runtimeBlocked ? " - unavailable" : "";
  return `${transport} - ${target} - ${toolCount} tool(s)${suffix}`;
}

function safeMcpEndpointLabel(endpoint) {
  if (!endpoint) return "No endpoint";
  try { return new URL(endpoint).host; } catch { return "Invalid endpoint"; }
}

function createBuiltInMcpServerSubtitle(server, enabled) {
  const toolCount = Array.isArray(server.tools) ? server.tools.length : 0;
  return `Built-in system server - ${toolCount} tool(s) - ${enabled ? "enabled" : "disabled"}`;
}

function getMcpDiscoverButtonLabel(runtimeBlocked, discovering) {
  if (runtimeBlocked) {
    return "Stdio MCP unavailable";
  }

  if (discovering) {
    return "Discovering tools";
  }

  return "Discover tools";
}

function getStdioMcpSupport(plugin) {
  if (typeof plugin?.getStdioMcpRuntimeSupport === "function") {
    return plugin.getStdioMcpRuntimeSupport();
  }

  return {
    supported: true,
    message: ""
  };
}

function isStdioMcpSupported(plugin) {
  return getStdioMcpSupport(plugin).supported !== false;
}

function getStdioMcpUnavailableMessage(plugin) {
  return getStdioMcpSupport(plugin).message || "Stdio MCP requires Obsidian desktop with Node child_process support. HTTP MCP servers remain available.";
}

function isMcpServerRuntimeBlocked(plugin, server) {
  if (typeof plugin?.isMcpServerRuntimeBlocked === "function") {
    return plugin.isMcpServerRuntimeBlocked(server) === true;
  }

  return server?.transport === MCP_STDIO_TRANSPORT && !isStdioMcpSupported(plugin);
}

function getProviderTypeLabel(type) {
  const option = PROVIDER_TYPE_OPTIONS.find((item) => item.value === type);
  return option?.label ?? "Provider";
}

function renderOptionalSlider(container, draft, options) {
  const enabled = draft[options.key] !== "";
  const currentValue = enabled ? Number(draft[options.key]) : options.defaultValue;
  let valueLabel;
  let sliderComponent;

  const setting = new Setting(container)
    .setName(options.name)
    .setDesc(options.desc)
    .addToggle((toggle) => {
      toggle
        .setValue(enabled)
        .onChange((value) => {
          draft[options.key] = value ? formatParameterNumber(options.defaultValue) : "";
          sliderComponent?.setDisabled?.(!value);
          if (sliderComponent?.sliderEl) {
            sliderComponent.sliderEl.disabled = !value;
          }
          if (value) {
            sliderComponent?.setValue(options.defaultValue);
          }
          valueLabel?.setText(value ? formatParameterNumber(options.defaultValue) : "Off");
        });
    })
    .addSlider((slider) => {
      sliderComponent = slider;
      slider
        .setLimits(options.min, options.max, options.step)
        .setValue(currentValue)
        .onChange((value) => {
          draft[options.key] = formatParameterNumber(value);
          valueLabel?.setText(formatParameterNumber(value));
        });
      slider.setDisabled?.(!enabled);
      if (slider.sliderEl) {
        slider.sliderEl.disabled = !enabled;
        slider.sliderEl.addEventListener("input", () => {
          const value = formatParameterNumber(slider.sliderEl.value);
          draft[options.key] = value;
          valueLabel?.setText(value);
        });
      }
    });

  valueLabel = setting.controlEl.createSpan({
    cls: "codriver-provider-parameter-value",
    text: enabled ? formatParameterNumber(currentValue) : "Off"
  });
}

function renderOptionalInteger(container, draft, options) {
  const enabled = draft[options.key] !== "";
  let textComponent;
  const setting = new Setting(container)
    .setName(options.name)
    .setDesc(`${options.desc} Empty sends no value.`)
    .addToggle((toggle) => {
      toggle
        .setValue(enabled)
        .onChange((value) => {
          draft[options.key] = value ? String(options.min ?? 1) : "";
          if (textComponent?.inputEl) {
            textComponent.inputEl.disabled = !value;
            textComponent.setValue(draft[options.key]);
          }
        });
    })
    .addText((text) => {
      textComponent = text;
      text.inputEl.type = "number";
      text.inputEl.min = String(options.min ?? 1);
      text.inputEl.disabled = !enabled;
      text
        .setPlaceholder("Off")
        .setValue(draft[options.key] ?? "")
        .onChange((value) => {
          draft[options.key] = value.trim();
        });
    });

  setting.settingEl.classList.add("codriver-provider-parameter-setting");
}

function renderRequiredInteger(container, draft, options) {
  const setting = new Setting(container)
    .setName(options.name)
    .setDesc(options.desc)
    .addText((text) => {
      text.inputEl.type = "number";
      text.inputEl.min = String(options.min ?? 1);
      text
        .setValue(draft[options.key] ?? "")
        .onChange((value) => {
          draft[options.key] = value.trim();
        });
    });

  setting.settingEl.classList.add("codriver-provider-parameter-setting");
}

function renderOptionalDropdown(container, draft, options) {
  new Setting(container)
    .setName(options.name)
    .setDesc(options.desc)
    .addDropdown((dropdown) => {
      dropdown.addOption("", "Provider default");
      for (const option of options.options) {
        dropdown.addOption(option.value, option.label);
      }

      dropdown
        .setValue(draft[options.key] ?? "")
        .onChange((value) => {
          draft[options.key] = value;
        });
    });
}

function renderReasoningSetting(container, draft) {
  new Setting(container)
    .setName("Reasoning")
    .setDesc("Should a model reason before answering.")
    .addDropdown((dropdown) => {
      dropdown.addOption("", "Provider default");
      dropdown.addOption("minimal", "Minimal");
      dropdown.addOption("low", "Low");
      dropdown.addOption("medium", "Medium");
      dropdown.addOption("high", "High");
      dropdown
        .setValue(draft.reasoningEffort ?? "")
        .onChange((value) => {
          draft.reasoningEffort = value;
        });
    });
}

function formatParameterNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return "";
  }

  return number.toFixed(2).replace(/\.?0+$/, "");
}

function createIconButton(container, icon, label, onClick, extraClass = "") {
  const button = container.createEl("button", {
    cls: `codriver-provider-icon-button ${extraClass}`.trim(),
    attr: {
      type: "button",
      title: label,
      "aria-label": label
    }
  });
  setIcon(button, icon);
  button.addEventListener("click", (event) => {
    event.preventDefault();
    void onClick();
  });
  return button;
}

function formatSkillFolderPathForDisplay(path) {
  const normalizedPath = normalizeSkillFolderPath(path);
  return Platform?.isWin ? normalizedPath.replaceAll("/", "\\") : normalizedPath;
}

function createDiagnosticLogUnavailableMessage(reason) {
  if (reason === "disabled") {
    return "Enable diagnostic logging before sharing the log.";
  }
  if (reason === "missing") {
    return "Diagnostic log has not been created yet.";
  }
  if (reason === "empty") {
    return "Diagnostic log is empty.";
  }

  return "Diagnostic log is unavailable.";
}

async function copyDiagnosticLogWithNotice(navigatorObject, content, reason = "unavailable") {
  const copied = await copyDiagnosticLog(navigatorObject, content);
  if (reason === "failed") {
    new Notice(copied
      ? "Unable to share the diagnostic log. Diagnostic log copied."
      : "Unable to share or copy the diagnostic log.");
    return;
  }

  new Notice(copied
    ? "File sharing is unavailable. Diagnostic log copied."
    : "File sharing is unavailable and the diagnostic log could not be copied.");
}

function createSkillErrorStatusText(result) {
  return `Loaded ${result.loaded.length} skills. ${formatSkillErrors(result.errors)}`;
}

function formatSkillErrors(errors) {
  const firstError = errors[0];
  if (!firstError) {
    return "";
  }

  return `${errors.length} skill(s) failed. First error: ${firstError.path}: ${firstError.message}`;
}

function renderSkillDetails(container, result) {
  container.empty();

  if (result.loaded.length > 0) {
    const loaded = container.createDiv({ cls: "codriver-setting-detail-group" });
    loaded.createDiv({ cls: "codriver-setting-detail-title", text: "Loaded skills" });
    for (const skill of result.loaded) {
      loaded.createDiv({ cls: "codriver-setting-detail-item", text: `${skill.name} (${skill.sourcePath})` });
    }
  }

  if (result.errors.length > 0) {
    const errors = container.createDiv({ cls: "codriver-setting-detail-group is-error" });
    errors.createDiv({ cls: "codriver-setting-detail-title", text: "Failed skills" });
    for (const error of result.errors) {
      errors.createDiv({ cls: "codriver-setting-detail-item", text: `${error.path}: ${error.message}` });
    }
  }
}
