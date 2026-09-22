const { Modal, Notice, Platform, PluginSettingTab, SecretComponent, Setting, setIcon } = require("obsidian");
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
  createCodriverVaultMcpServer
} = require("../mcp/CodriverVaultMcpServer");
const {
  AUDIO_TRANSCRIPTION_TOOLTIP,
  decodeAudioTranscriptionSelection,
  encodeAudioTranscriptionSelection,
  getAudioTranscriptionModelChoices,
  normalizeAudioTranscriptionSettings,
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
    description: "Maximum total model-facing MCP tools per request, including CoDriver Vault and external MCP tools. 0 means Unlimited."
  },
  {
    key: "maxAutomaticMcpToolCalls",
    label: "Max calls",
    fallback: 6,
    min: 1,
    max: 20,
    ariaLabel: "Maximum automatic MCP tool calls",
    description: "Maximum MCP tool calls CoDriver may run automatically while completing one user request."
  },
  {
    key: "mcpToolTimeoutSeconds",
    label: "Timeout, sec",
    fallback: 60,
    min: 5,
    max: 600,
    ariaLabel: "MCP tool timeout seconds",
    description: "Maximum time CoDriver waits for one MCP tool call before marking it as failed."
  },
  {
    key: "maxMcpToolResultChars",
    label: "Output chars",
    fallback: 60000,
    min: 1000,
    max: 240000,
    ariaLabel: "Maximum MCP tool result characters",
    description: "Maximum characters kept from one MCP tool result for the current chat card and immediate model follow-up. Longer output is marked as truncated."
  },
  {
    key: "maxRecentMcpToolResults",
    label: "Recent count",
    fallback: 4,
    min: 1,
    max: 20,
    ariaLabel: "Maximum remembered MCP tool results",
    description: "Maximum completed MCP tool results kept in this chat session for later turns."
  },
  {
    key: "maxRecentMcpToolResultContextChars",
    label: "Memory chars",
    fallback: 24000,
    min: 1000,
    max: 120000,
    ariaLabel: "Maximum remembered MCP tool result characters",
    description: "Maximum characters kept from each remembered MCP tool result when it is added to a later provider request."
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

    this.renderSessionHistorySettings(containerEl);
    this.renderDiagnosticLoggingSettings(containerEl);
    return returnFocusTarget;
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
        `${this.plugin.getDiagnosticLogPath() || "The CoDriver diagnostic log"}\nThis file is refreshed when CoDriver restarts.`
      );
      setting.descEl?.addClass("codriver-diagnostic-log-file-description");
      if (setting.descEl) setting.settingEl.appendChild(setting.descEl);
    }
    setting
      .addToggle((toggle) => {
        toggle
          .setValue(Boolean(this.plugin.settings.enableDiagnosticLogging))
          .onChange(async (value) => {
            this.plugin.settings.enableDiagnosticLogging = value;
            await this.plugin.saveSettings();
          });
      })
      .addDropdown((dropdown) => {
        dropdown
          .addOption("errors", "Errors only")
          .addOption("all", "All events")
          .setValue(this.plugin.settings.diagnosticLogLevel ?? "errors")
          .onChange(async (value) => {
            this.plugin.settings.diagnosticLogLevel = value;
            await this.plugin.saveSettings();
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
            this.plugin.settings.diagnosticLogTarget = value;
            await this.plugin.saveSettings();
            this.display();
          });
      });

    if (isMobileApp) {
      createIconButton(setting.controlEl, "share-2", "Share diagnostic log", () => (
        this.handleDiagnosticLogShare()
      ), "codriver-diagnostic-share-button");
    }
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
    if (!canShareDiagnosticLogFile(navigatorObject, file)) {
      await copyDiagnosticLogWithNotice(navigatorObject, result.content);
      return;
    }

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
    }
  }

  renderSettingsSectionHeader(container, title) {
    const header = container.createDiv({ cls: "codriver-settings-section-header" });
    header.createEl("h3", { text: title });
    return header.createDiv({ cls: "codriver-settings-section-actions" });
  }

  renderAudioTranscriptionSettings(container) {
    const current = normalizeAudioTranscriptionSettings(this.plugin.settings.audioTranscription);
    const choices = getAudioTranscriptionModelChoices(this.plugin.settings);
    const selectedValue = encodeAudioTranscriptionSelection(current.providerId, current.modelId);
    const availableValues = new Set();
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
              new Notice(result.message);
              return;
            }

            this.pendingAudioTranscriptionEnable = true;
            this.display();
          });
        toggle.toggleEl?.setAttribute("title", "Enable audio transcription");
        toggle.toggleEl?.setAttribute("aria-label", "Enable audio transcription");
      });
    setting.settingEl.classList.add("codriver-audio-transcription-setting");

    const select = setting.controlEl.createEl("select", {
      cls: "codriver-audio-transcription-select",
      attr: {
        "aria-label": "Select audio transcription model",
        title: AUDIO_TRANSCRIPTION_TOOLTIP
      }
    });
    select.createEl("option", {
      text: "Select model",
      value: ""
    });
    for (const provider of choices) {
      const group = select.createEl("optgroup", {
        attr: { label: provider.providerName }
      });
      for (const model of provider.models) {
        const value = encodeAudioTranscriptionSelection(provider.providerId, model);
        availableValues.add(value);
        group.createEl("option", {
          text: model,
          value
        });
      }
    }

    if (current.providerId && current.modelId && !availableValues.has(selectedValue)) {
      select.createEl("option", {
        text: `Unavailable: ${current.providerId} / ${current.modelId}`,
        value: selectedValue,
        attr: { disabled: "" }
      });
    }
    select.value = current.providerId && current.modelId ? selectedValue : "";
    select.disabled = !current.enabled && !this.pendingAudioTranscriptionEnable;
    select.addEventListener("change", async () => {
      const selection = decodeAudioTranscriptionSelection(select.value);
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
    createIconButton(actions, "trash-2", "Remove model", async () => {
      await this.plugin.removeProvider(provider.id);
      this.display();
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
    enabled.checked = server.enabled !== false && !runtimeBlocked;
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
    discoverButton.disabled = runtimeBlocked || discovering;
    createIconButton(actions, "pencil", "Edit MCP server", () => {
      new McpServerSettingsModal(this.app, this.plugin, server, () => this.display()).open();
    });
    createIconButton(actions, "trash-2", "Remove MCP server", async () => {
      await this.plugin.removeMcpServer(server.id);
      this.display();
    });

    if (runtimeBlocked) {
      group.createDiv({
        cls: "codriver-setting-status is-error",
        text: getStdioMcpUnavailableMessage(this.plugin)
      });
    }

    this.renderMcpToolRows(group, server, { disabled: runtimeBlocked });
  }

  renderBuiltInMcpServerRow(container) {
    const server = createCodriverVaultMcpServer({
      toolSettings: this.plugin.settings.codriverVaultToolSettings
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
    const tools = Array.isArray(server.tools) ? server.tools : [];
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
      const description = typeof tool.description === "string" ? tool.description.trim() : "";
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
      text: "Diagnostic logs can contain note paths and provider endpoint metadata. They exclude note bodies, prompts, tool argument values, tool output content, API keys, and secrets."
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
          .setButtonText("Share")
          .onClick(() => {
            button.setDisabled(true);
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
    this.onSaved = onSaved;
  }

  onOpen() {
    this.render();
  }

  render(statusText = "", statusOk = null) {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("codriver-provider-modal");

    contentEl.createEl("h2", { text: this.provider ? "Edit model" : "Add model" });

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
        text
          .setValue(this.draft.endpoint ?? "")
          .onChange((value) => {
            this.draft.endpoint = value.trim();
          });
      });
    endpointSetting.settingEl.classList.add("codriver-provider-endpoint-setting");

    if (this.draft.type === GEMINI_PROVIDER_TYPE) {
      new Setting(contentEl)
        .setName("API version")
        .setDesc("Gemini REST API version.")
        .addText((text) => {
          text
            .setValue(this.draft.apiVersion || DEFAULT_GEMINI_API_VERSION)
            .onChange((value) => {
              this.draft.apiVersion = value.trim();
            });
        });
    }

    new Setting(contentEl)
      .setName("API key")
      .setDesc("Stored in Obsidian secret storage.")
      .addComponent((componentEl) => {
        if (!SecretComponent || !this.app.secretStorage) {
          componentEl.createSpan({ text: "Secret storage is unavailable in this Obsidian version." });
          return;
        }

        return new SecretComponent(this.app, componentEl)
          .setValue(this.draft.apiKeySecretName ?? "")
          .onChange((value) => {
            this.draft.apiKeySecretName = value.trim();
          });
      });

    new Setting(contentEl)
      .setName("Default model")
      .addDropdown((dropdown) => {
        populateModelDropdown(dropdown, this.draft);
        dropdown.onChange((value) => {
          this.draft.model = value;
        });
      })
      .addButton((button) => {
        button
          .setButtonText("Test connection")
          .onClick(async () => {
            button.setDisabled(true);
            const result = await this.plugin.testProviderDraftConnection(this.draft);
            if (result.ok) {
              this.draft.models = result.models;
              this.draft.model = result.models.includes(this.draft.model)
                ? this.draft.model
                : result.models[0] ?? "";
            }
            button.setDisabled(false);
            this.render(result.message, result.ok);
          });
      });

    const status = contentEl.createDiv({
      cls: "codriver-setting-status",
      text: statusText || "Test connection to load models for this provider."
    });
    if (statusOk !== null) {
      status.addClass(statusOk ? "is-success" : "is-error");
    }

    this.renderGenerationParameters(contentEl);

    new Setting(contentEl)
      .addButton((button) => {
        button
          .setButtonText("Cancel")
          .onClick(() => this.close());
      })
      .addButton((button) => {
        button
          .setCta()
          .setButtonText("Save")
          .onClick(async () => {
            button.setDisabled(true);
            await this.plugin.saveProviderDraft(this.draft);
            this.close();
            this.onSaved?.();
          });
      });
  }

  changeProviderType(type) {
    const next = this.plugin.createProviderDraft(type);
    const existingId = this.provider?.id;
    this.draft = {
      ...next,
      id: existingId ?? next.id
    };
    this.render();
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

      const groundingSetting = new Setting(contentEl)
        .setName("Google Search grounding")
        .setDesc("Use Google Search for grounded responses.")
        .addToggle((toggle) => {
          toggle
            .setValue(this.draft.enableGoogleSearch === true)
            .onChange((value) => {
              this.draft.enableGoogleSearch = value;
              this.render();
            });
        });

      groundingSetting.settingEl.classList.add("codriver-gemini-grounding-setting");
      groundingSetting.controlEl.createSpan({
        cls: "codriver-gemini-custom-tools-label",
        text: "Custom tools"
      });
      groundingSetting.addToggle((toggle) => {
        toggle
          .setValue(this.draft.enableGroundedCustomTools === true)
          .setDisabled?.(this.draft.enableGoogleSearch !== true);
        toggle.toggleEl?.setAttribute("aria-label", "Custom tools");
        toggle.toggleEl?.setAttribute(
          "title",
          this.draft.enableGoogleSearch === true
            ? "Combine Google Search with enabled custom tools"
            : "Enable Google Search grounding to use custom tools"
        );
        toggle.onChange((value) => {
          this.draft.enableGroundedCustomTools = value;
        });
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
    this.onSaved = onSaved;
  }

  onOpen() {
    this.render();
  }

  render(statusText = "", statusOk = null) {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("codriver-provider-modal");

    contentEl.createEl("h2", { text: this.server ? "Edit MCP server" : "Add MCP server" });
    const stdioSupported = isStdioMcpSupported(this.plugin);
    const stdioBlocked = this.draft.transport === MCP_STDIO_TRANSPORT && !stdioSupported;
    const renderedTransport = stdioSupported
      ? (this.draft.transport ?? MCP_STDIO_TRANSPORT)
      : MCP_HTTP_TRANSPORT;

    if (statusText) {
      const status = contentEl.createDiv({
        cls: "codriver-setting-status",
        text: statusText
      });
      if (statusOk !== null) {
        status.addClass(statusOk ? "is-success" : "is-error");
      }
    }

    new Setting(contentEl)
      .setName("Name")
      .addText((text) => {
        text
          .setValue(this.draft.name ?? "")
          .onChange((value) => {
            this.draft.name = value;
          });
      });

    const transportSetting = new Setting(contentEl)
      .setName("Transport")
      .addDropdown((dropdown) => {
        if (stdioSupported) {
          dropdown.addOption(MCP_STDIO_TRANSPORT, "stdio");
        }
        dropdown.addOption(MCP_HTTP_TRANSPORT, "http");
        dropdown
          .setValue(renderedTransport)
          .onChange((value) => {
            this.draft.transport = value;
            this.render();
          });
      });
    transportSetting.settingEl.addClass("codriver-mcp-transport-setting");
    if (!stdioSupported) {
      transportSetting.controlEl.createDiv({
        cls: "codriver-setting-inline-note",
        text: "Stdio is not supported on mobile devices."
      });
    }

    if (renderedTransport === MCP_HTTP_TRANSPORT) {
      new Setting(contentEl)
        .setName("Endpoint")
        .setDesc("HTTP MCP server endpoint.")
        .addText((text) => {
          text.inputEl.classList.add("codriver-endpoint-input");
          text.inputEl.disabled = stdioBlocked;
          text
            .setPlaceholder("https://example.com/mcp")
            .setValue(this.draft.endpoint ?? "")
            .onChange((value) => {
              this.draft.endpoint = value;
            });
        });

      new Setting(contentEl)
        .setName("Headers")
        .setDesc("Optional HTTP headers, one Header-Name: value per line.")
        .addTextArea((text) => {
          text.inputEl.disabled = stdioBlocked;
          text
            .setPlaceholder("Authorization: Bearer ...")
            .setValue(this.draft.headers ?? "")
            .onChange((value) => {
              this.draft.headers = value;
            });
        });
    } else {
      new Setting(contentEl)
        .setName("Command")
        .setDesc("Executable command used to start the MCP server.")
        .addText((text) => {
          text.inputEl.disabled = stdioBlocked;
          text
            .setPlaceholder("npx")
            .setValue(this.draft.command ?? "")
            .onChange((value) => {
              this.draft.command = value;
            });
        });

      new Setting(contentEl)
        .setName("Arguments")
        .setDesc("Optional command arguments. Keep one shell-style argument string for now.")
        .addTextArea((text) => {
          text.inputEl.disabled = stdioBlocked;
          text
            .setPlaceholder("-y @example/mcp-server")
            .setValue(this.draft.args ?? "")
            .onChange((value) => {
              this.draft.args = value;
            });
        });

      new Setting(contentEl)
        .setName("Environment")
        .setDesc("Optional environment variables, one KEY=value per line.")
        .addTextArea((text) => {
          text.inputEl.disabled = stdioBlocked;
          text
            .setPlaceholder("API_KEY=...")
            .setValue(this.draft.env ?? "")
            .onChange((value) => {
              this.draft.env = value;
            });
        });
    }

    new Setting(contentEl)
      .setName("Enabled")
      .addToggle((toggle) => {
        toggle
          .setValue(this.draft.enabled !== false && !stdioBlocked)
          .onChange((value) => {
            this.draft.enabled = value;
          });
        toggle.setDisabled?.(stdioBlocked);
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
          .setButtonText("Save")
          .onClick(async () => {
            button.setDisabled(true);
            try {
              await this.plugin.saveMcpServerDraft(this.draft);
              this.close();
              this.onSaved?.();
            } catch (error) {
              const detail = error instanceof Error ? error.message : "Unable to save MCP server.";
              button.setDisabled(false);
              this.render(detail, false);
            }
          });
        button.setDisabled(stdioBlocked);
      });
  }
}

module.exports = {
  CoDriverSettingTab,
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
    ? (server.endpoint || "No endpoint")
    : (server.command || "No command");
  const toolCount = Array.isArray(server.tools) ? server.tools.length : 0;
  const suffix = runtimeBlocked ? " - unavailable" : "";
  return `${transport} - ${target} - ${toolCount} tool(s)${suffix}`;
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

function populateModelDropdown(dropdown, provider) {
  const models = Array.isArray(provider?.models) ? provider.models : [];

  if (models.length === 0) {
    dropdown.addOption("", "Load models first");
    dropdown.setValue("");
    return;
  }

  for (const model of models) {
    dropdown.addOption(model, model);
  }

  const selectedModel = provider?.model && models.includes(provider.model)
    ? provider.model
    : models[0];
  dropdown.setValue(selectedModel);
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
