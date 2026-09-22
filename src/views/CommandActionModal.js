const { Component, Notice, SuggestModal, setIcon } = require("obsidian");
const {
  createChatTimelineRenderer,
  decodeModelOptionValue,
  disposeChatTimelineRenderer,
  encodeModelOptionValue
} = require("./ChatView");

function filterCommandActionChoices(commands, options = {}) {
  const available = Array.isArray(commands) ? commands : [];
  return options.instant === true
    ? available.filter((command) => command?.requiresText !== true)
    : available;
}

const FLOATING_WINDOW_MARGIN = 12;
const FLOATING_WINDOW_MIN_WIDTH = 360;
const FLOATING_WINDOW_MIN_HEIGHT = 280;
const FLOATING_WINDOW_WIDTH = 602;
const FLOATING_WINDOW_HEIGHT = 546;
let floatingWindowSequence = 0;

function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}

function getFloatingWindowRect(rect, interaction, viewport) {
  const margin = FLOATING_WINDOW_MARGIN;
  const viewportWidth = Math.max(0, Number(viewport?.width) || 0);
  const viewportHeight = Math.max(0, Number(viewport?.height) || 0);
  const minWidth = Math.min(FLOATING_WINDOW_MIN_WIDTH, Math.max(0, viewportWidth - (margin * 2)));
  const minHeight = Math.min(FLOATING_WINDOW_MIN_HEIGHT, Math.max(0, viewportHeight - (margin * 2)));
  let left = Number(rect?.left) || 0;
  let top = Number(rect?.top) || 0;
  let width = Math.max(0, Number(rect?.width) || 0);
  let height = Math.max(0, Number(rect?.height) || 0);
  const deltaX = Number(interaction?.deltaX) || 0;
  const deltaY = Number(interaction?.deltaY) || 0;
  const direction = String(interaction?.direction || "");

  if (interaction?.type === "drag") {
    left = clamp(left + deltaX, margin, viewportWidth - width - margin);
    top = clamp(top + deltaY, margin, viewportHeight - height - margin);
    return { left, top, width, height };
  }

  if (direction.includes("e")) {
    width = clamp(width + deltaX, minWidth, viewportWidth - left - margin);
  }
  if (direction.includes("s")) {
    height = clamp(height + deltaY, minHeight, viewportHeight - top - margin);
  }
  if (direction.includes("w")) {
    const right = left + width;
    left = clamp(left + deltaX, margin, right - minWidth);
    width = right - left;
  }
  if (direction.includes("n")) {
    const bottom = top + height;
    top = clamp(top + deltaY, margin, bottom - minHeight);
    height = bottom - top;
  }

  return { left, top, width, height };
}

class CommandActionPickerModal extends SuggestModal {
  constructor(app, commands, onChooseCommand, options = {}) {
    super(app);
    this.commands = Array.isArray(commands) ? commands : [];
    this.onChooseCommand = onChooseCommand;
    this.setPlaceholder(options.placeholder || "Run command");
  }

  getSuggestions(query) {
    const normalized = String(query ?? "").trim().toLowerCase();
    if (!normalized) return this.commands;
    return this.commands.filter((command) => (
      command.name.toLowerCase().includes(normalized) ||
      command.description.toLowerCase().includes(normalized)
    ));
  }

  renderSuggestion(command, el) {
    el.createDiv({ cls: "codriver-command-action-suggestion-name", text: `@${command.name}` });
    el.createDiv({ cls: "codriver-command-action-suggestion-description", text: command.description });
  }

  onChooseSuggestion(command) {
    void this.onChooseCommand(command);
  }
}

class CommandActionModal {
  constructor(app, chatController, command, diagnostics = null, onDidClose = null, options = {}) {
    this.app = app;
    this.chatController = chatController;
    this.command = command;
    this.diagnostics = diagnostics;
    this.onDidClose = typeof onDidClose === "function" ? onDidClose : null;
    this.instant = options.instant === true;
    this.instantStarted = false;
    this.commandPending = true;
    this.draftText = "";
    this.messageInputEl = null;
    this.lifecycle = new Component();
    this.timelineRenderer = null;
    this.containerEl = null;
    this.contentEl = null;
    this.hostEl = null;
    this.ownerDocument = null;
    this.ownerWindow = null;
    this.pointerInteraction = null;
    this.isOpen = false;
    this.titleId = `codriver-command-window-title-${++floatingWindowSequence}`;
  }

  open() {
    if (this.isOpen) return;
    this.isOpen = true;
    this.ownerDocument = this.getOwnerDocument();
    this.ownerWindow = this.ownerDocument.defaultView || window;
    this.createFloatingWindow();
    this.timelineRenderer = createChatTimelineRenderer(
      this,
      this.chatController,
      this.diagnostics,
      () => this.render(),
      this.lifecycle
    );
    this.onOpen();
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.onClose();
  }

  getOwnerDocument() {
    return this.app.workspace?.activeLeaf?.view?.containerEl?.ownerDocument ||
      this.app.workspace?.containerEl?.ownerDocument ||
      document;
  }

  createFloatingWindow() {
    const doc = this.ownerDocument;
    this.hostEl = doc.createElement("div");
    this.hostEl.className = "codriver-command-floating-host";
    this.containerEl = doc.createElement("section");
    this.containerEl.className = "codriver-command-chat-modal codriver-command-floating-window";
    this.containerEl.setAttribute("role", "dialog");
    this.containerEl.setAttribute("aria-modal", "false");
    this.containerEl.setAttribute("aria-labelledby", this.titleId);
    this.contentEl = doc.createElement("div");
    this.containerEl.appendChild(this.contentEl);
    for (const direction of ["n", "e", "s", "w", "ne", "se", "sw", "nw"]) {
      const handle = doc.createElement("div");
      handle.className = `codriver-command-resize-handle is-${direction}`;
      handle.dataset.direction = direction;
      handle.setAttribute("aria-hidden", "true");
      this.containerEl.appendChild(handle);
    }
    this.hostEl.appendChild(this.containerEl);
    doc.body.appendChild(this.hostEl);
    this.placeFloatingWindow();
  }

  placeFloatingWindow() {
    const viewportWidth = this.ownerWindow.innerWidth;
    const viewportHeight = this.ownerWindow.innerHeight;
    const width = Math.min(FLOATING_WINDOW_WIDTH, Math.max(0, viewportWidth - (FLOATING_WINDOW_MARGIN * 2)));
    const height = Math.min(FLOATING_WINDOW_HEIGHT, Math.max(0, viewportHeight - (FLOATING_WINDOW_MARGIN * 2)));
    this.applyFloatingWindowRect({
      left: Math.max(FLOATING_WINDOW_MARGIN, (viewportWidth - width) / 2),
      top: Math.max(FLOATING_WINDOW_MARGIN, (viewportHeight - height) / 2),
      width,
      height
    });
  }

  applyFloatingWindowRect(rect) {
    if (!this.containerEl) return;
    this.containerEl.style.left = `${Math.round(rect.left)}px`;
    this.containerEl.style.top = `${Math.round(rect.top)}px`;
    this.containerEl.style.width = `${Math.round(rect.width)}px`;
    this.containerEl.style.height = `${Math.round(rect.height)}px`;
  }

  onOpen() {
    this.lifecycle.load();
    this.chatController.setStateChangeHandler((change) => this.timelineRenderer.scheduleRender(change));
    this.lifecycle.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      this.chatController.handleVaultFileRename(file, oldPath);
      this.render();
    }));
    this.lifecycle.registerEvent(this.app.vault.on("delete", (file) => {
      this.chatController.handleVaultFileDelete(file);
      this.render();
    }));
    this.lifecycle.registerEvent(this.app.metadataCache.on("changed", (file) => {
      this.timelineRenderer.clearProposalNoteContentCache(file?.path);
      this.render();
    }));
    this.lifecycle.registerDomEvent(this.containerEl, "pointerdown", (event) => this.handlePointerDown(event));
    this.lifecycle.registerDomEvent(this.ownerDocument, "pointermove", (event) => this.handlePointerMove(event));
    this.lifecycle.registerDomEvent(this.ownerDocument, "pointerup", () => this.finishPointerInteraction());
    this.lifecycle.registerDomEvent(this.ownerDocument, "pointercancel", () => this.finishPointerInteraction());
    this.lifecycle.registerDomEvent(this.ownerWindow, "resize", () => this.keepFloatingWindowInViewport());
    this.render();
    if (this.instant && !this.instantStarted) {
      this.instantStarted = true;
      void this.submitDraft();
    }
  }

  onClose() {
    this.captureDraftText();
    this.chatController.setStateChangeHandler(null);
    if (this.instant && this.chatController.isSending()) {
      this.chatController.cancelActiveRequest();
    }
    this.finishPointerInteraction();
    disposeChatTimelineRenderer(this.timelineRenderer);
    this.lifecycle.unload();
    this.messageInputEl = null;
    this.contentEl?.empty?.();
    this.hostEl?.remove();
    this.timelineRenderer = null;
    this.contentEl = null;
    this.containerEl = null;
    this.hostEl = null;
    void this.chatController.persistCurrentSession({ force: true });
    this.onDidClose?.();
  }

  handlePointerDown(event) {
    if (event.button !== 0) return;
    const resizeHandle = event.target?.closest?.(".codriver-command-resize-handle");
    const header = event.target?.closest?.(".codriver-command-chat-header");
    const closeButton = event.target?.closest?.(".codriver-command-chat-close");
    if (!resizeHandle && (!header || closeButton)) return;
    const rect = this.containerEl.getBoundingClientRect();
    this.pointerInteraction = {
      type: resizeHandle ? "resize" : "drag",
      direction: resizeHandle?.dataset?.direction || "",
      startX: event.clientX,
      startY: event.clientY,
      rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
    };
    this.containerEl.addClass(resizeHandle ? "is-resizing" : "is-dragging");
    event.preventDefault();
  }

  handlePointerMove(event) {
    if (!this.pointerInteraction) return;
    const nextRect = getFloatingWindowRect(
      this.pointerInteraction.rect,
      {
        type: this.pointerInteraction.type,
        direction: this.pointerInteraction.direction,
        deltaX: event.clientX - this.pointerInteraction.startX,
        deltaY: event.clientY - this.pointerInteraction.startY
      },
      { width: this.ownerWindow.innerWidth, height: this.ownerWindow.innerHeight }
    );
    this.applyFloatingWindowRect(nextRect);
    event.preventDefault();
  }

  finishPointerInteraction() {
    this.pointerInteraction = null;
    this.containerEl?.removeClass?.("is-dragging", "is-resizing");
  }

  keepFloatingWindowInViewport() {
    if (!this.containerEl) return;
    const rect = this.containerEl.getBoundingClientRect();
    const width = Math.min(rect.width, Math.max(0, this.ownerWindow.innerWidth - (FLOATING_WINDOW_MARGIN * 2)));
    const height = Math.min(rect.height, Math.max(0, this.ownerWindow.innerHeight - (FLOATING_WINDOW_MARGIN * 2)));
    this.applyFloatingWindowRect({
      left: clamp(rect.left, FLOATING_WINDOW_MARGIN, this.ownerWindow.innerWidth - width - FLOATING_WINDOW_MARGIN),
      top: clamp(rect.top, FLOATING_WINDOW_MARGIN, this.ownerWindow.innerHeight - height - FLOATING_WINDOW_MARGIN),
      width,
      height
    });
  }

  captureDraftText() {
    if (this.messageInputEl) this.draftText = String(this.messageInputEl.value ?? "");
  }

  render() {
    this.captureDraftText();
    const timelineScrollState = this.timelineRenderer.captureTimelineScrollState();
    const root = this.contentEl;
    this.timelineRenderer.clearReasoningScrollFrames();
    this.timelineRenderer.messageRenderState.clear();
    root.empty();
    root.addClass("codriver-chat-view");
    root.addClass("codriver-command-chat-surface");

    this.renderHeader(root);
    const timeline = this.timelineRenderer.renderTimeline(root);
    if (this.chatController.getTimelineItems().length === 0) {
      timeline.createDiv({
        cls: "codriver-command-chat-empty",
        text: this.instant
          ? `Running @${this.command.name}...`
          : `Start a new isolated session with @${this.command.name}.`
      });
    }
    if (!this.instant) this.renderComposer(root);
    this.timelineRenderer.restoreTimelineScrollState(timeline, timelineScrollState);
  }

  renderHeader(root) {
    const header = root.createDiv({ cls: "codriver-command-chat-header" });
    const title = header.createDiv({
      cls: "codriver-command-chat-title",
      attr: { id: this.titleId }
    });
    title.createSpan({ cls: "codriver-message-command", text: `@${this.command.name}` });
    const closeButton = header.createEl("button", {
      cls: "clickable-icon codriver-command-chat-close",
      attr: {
        type: "button",
        "aria-label": "Close command window",
        title: "Close"
      }
    });
    setIcon(closeButton, "x");
    closeButton.addEventListener("click", () => this.close());
  }

  renderComposer(root) {
    const composer = root.createDiv({ cls: "codriver-chat-composer codriver-command-chat-composer" });
    this.renderActiveNoteContext(composer);

    const input = composer.createEl("textarea", {
      cls: "codriver-chat-input",
      attr: {
        placeholder: this.commandPending
          ? `Message for @${this.command.name}${this.command.requiresText ? " (required)" : " (optional)"}`
          : "Follow up in this isolated session...",
        "aria-label": "Message"
      }
    });
    input.value = this.draftText;
    this.messageInputEl = input;
    input.addEventListener("input", () => {
      this.draftText = input.value;
      this.updateSendButton(sendButton);
    });
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
      event.preventDefault();
      void this.submitDraft();
    });

    const actions = composer.createDiv({ cls: "codriver-composer-actions" });
    const modelControls = actions.createDiv({ cls: "codriver-model-controls" });
    this.renderModelPicker(modelControls);
    const trailing = actions.createDiv({ cls: "codriver-composer-trailing-actions" });
    const sendButton = trailing.createEl("button", {
      cls: "codriver-send-button",
      attr: { type: "button" }
    });
    sendButton.addEventListener("click", () => {
      if (this.chatController.isSending()) this.chatController.cancelActiveRequest();
      else void this.submitDraft();
    });
    this.updateSendButton(sendButton);
  }

  renderActiveNoteContext(composer) {
    if (!this.command.requiresActiveNote) return;
    const activeNote = this.chatController.getActiveNoteContextState();
    if (activeNote.enabled && activeNote.path) {
      this.timelineRenderer.renderActiveSkills(composer);
      return;
    }

    if (!this.commandPending || !this.command.requiresActiveNote) return;
    const warning = composer.createDiv({ cls: "codriver-command-chat-context-warning" });
    warning.createSpan({ text: "This command requires Active note context." });
    if (activeNote.currentPath) {
      const add = warning.createEl("button", {
        text: "Add Active note",
        attr: { type: "button" }
      });
      add.addEventListener("click", () => {
        this.chatController.addActiveNoteContext();
        this.render();
      });
    }
  }

  renderModelPicker(container) {
    const picker = container.createDiv({ cls: "codriver-model-picker" });
    const select = picker.createEl("select", {
      cls: "codriver-bottom-model-select",
      attr: { "aria-label": "Select model" }
    });
    const choices = this.chatController.getModelChoices();
    if (choices.length === 0) {
      select.createEl("option", { text: "No visible models", value: "" });
    } else {
      for (const provider of choices) {
        const group = select.createEl("optgroup", { attr: { label: provider.providerName } });
        for (const model of provider.models) {
          group.createEl("option", {
            text: model,
            value: encodeModelOptionValue(provider.providerId, model)
          });
        }
      }
    }
    select.value = encodeModelOptionValue(
      this.chatController.getSelectedProviderId(),
      this.chatController.getSelectedModelId()
    );
    select.addEventListener("change", () => {
      this.captureDraftText();
      const selection = decodeModelOptionValue(select.value);
      void this.chatController.selectModel(selection.modelId, selection.providerId);
      this.render();
    });
    const icon = picker.createDiv({ cls: "codriver-model-picker-button" });
    setIcon(icon, "bot");
    picker.createDiv({
      cls: "codriver-selected-model-name",
      text: this.chatController.getSelectedModelId() || "No model"
    });
  }

  canSubmitDraft() {
    if (this.chatController.isSending() || !this.chatController.getSelectedModelId()) return false;
    const text = this.draftText.trim();
    if (!this.commandPending) return text.length > 0;
    if (this.command.requiresText && !text) return false;
    if (this.command.requiresActiveNote && !this.chatController.getActiveNotePathContextForRequest().path) return false;
    return true;
  }

  updateSendButton(button) {
    const sending = this.chatController.isSending();
    button.disabled = !sending && !this.canSubmitDraft();
    button.setAttribute("aria-label", sending ? "Stop response" : "Send message");
    button.setAttribute("title", sending ? "Stop response" : "Send message");
    button.toggleClass("is-stopping", sending);
    button.empty();
    setIcon(button, sending ? "square" : "send");
  }

  async submitDraft() {
    this.captureDraftText();
    if (!this.canSubmitDraft()) return;
    const text = this.draftText;
    const commandId = this.commandPending ? this.command.id : "";
    try {
      const result = await this.chatController.sendMessage(text, { commandId });
      if (commandId && this.hasSentSelectedCommand()) this.commandPending = false;
      if (result?.ok !== false || result?.reason !== "ignored") this.draftText = "";
    } catch (error) {
      if (commandId && this.hasSentSelectedCommand()) this.commandPending = false;
      new Notice(error instanceof Error ? error.message : "CoDriver request failed.");
    }
    this.render();
  }

  hasSentSelectedCommand() {
    return this.chatController.getMessages().some((message) => (
      message.role === "user" && message.commandName === this.command.name
    ));
  }
}

module.exports = {
  CommandActionModal,
  CommandActionPickerModal,
  filterCommandActionChoices,
  getFloatingWindowRect
};
