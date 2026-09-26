const { ItemView, Keymap, MarkdownRenderer, Notice, Platform, setIcon, SuggestModal } = require("obsidian");
const { VIEW_TYPE_CODRIVER } = require("../constants");
const { formatBytes } = require("../attachments/AttachmentExtractor");
const {
  captureThinkingShimmerSnapshot,
  compareThinkingShimmerSnapshots,
  createThinkingShimmerRuntimeDetail
} = require("../diagnostics/ThinkingShimmerProbe");
const { createInlineDiff, createUnifiedDiffRows, createUnifiedTextChangeRows } = require("../ui/ProposalDiff");
const {
  CODRIVER_VAULT_APPEND_NOTE_TOOL_NAME,
  CODRIVER_VAULT_CREATE_NOTE_TOOL_NAME,
  CODRIVER_VAULT_DELETE_NOTE_TOOL_NAME,
  CODRIVER_VAULT_MOVE_FILE_TOOL_NAME,
  CODRIVER_VAULT_TRANSCRIBE_AUDIO_TOOL_NAME,
  CODRIVER_VAULT_SERVER_ID
} = require("../mcp/CodriverVaultMcpServer");

const TIMELINE_BOTTOM_STICKY_THRESHOLD_PX = 48;
const REASONING_BOTTOM_STICKY_THRESHOLD_PX = 2;
const THINKING_SHIMMER_DURATION_MS = 1800;
const THINKING_SHIMMER_PROBE_DELAY_MS = 320;

function findCommandTokenRange(value, commandName) {
  const escapedName = String(commandName ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!escapedName) return null;
  const match = new RegExp(`(^|\\s)(@${escapedName})(?=$|\\s)`, "i").exec(String(value ?? ""));
  if (!match) return null;
  const start = match.index + match[1].length;
  return { start, end: start + match[2].length };
}

class SessionLoadModal extends SuggestModal {
  constructor(app, sessions, onChooseSession) {
    super(app);
    this.sessions = sessions;
    this.onChooseSession = onChooseSession;
    this.setPlaceholder("Session history");
  }

  getSuggestions(query) {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) {
      return this.sessions;
    }

    return this.sessions.filter((session) => (
      (session.displayName ?? "").toLowerCase().includes(normalizedQuery) ||
      session.name.toLowerCase().includes(normalizedQuery) ||
      session.path.toLowerCase().includes(normalizedQuery)
    ));
  }

  renderSuggestion(session, el) {
    el.createDiv({ cls: "codriver-session-suggestion-name", text: session.displayName ?? session.name });
  }

  onChooseSuggestion(session) {
    void this.onChooseSession(session);
  }
}

function initializeChatSurface(surface, chatController, diagnostics = null) {
  surface.chatController = chatController;
  surface.diagnostics = diagnostics;
  surface.fileInputEl = null;
  surface.messageInputEl = null;
  surface.draftMessage = "";
  surface.draftCommandId = "";
  surface.commandMenuOpen = false;
  surface.commandSuggestionIndex = 0;
  surface.focusCommandInputAfterRender = false;
  surface.draftSelectionStart = null;
  surface.draftSelectionEnd = null;
  surface.contextPickerOpen = false;
  surface.mcpServerPickerOpen = false;
  surface.requestInfoOpen = false;
  surface.collapsedMcpToolCallIds = new Set();
  surface.autoCollapsingMcpToolCallIds = new Set();
  surface.expandedMcpToolCallIds = new Set();
  surface.mcpToolCallCollapseTimers = new Map();
  surface.proposalDiffModes = new Map();
  surface.proposalNoteContentCache = new Map();
  surface.internalLinkNavigationBindings = new WeakMap();
  surface.reasoningDisclosureState = new Map();
  surface.reasoningFinalCollapseApplied = new Set();
  surface.reasoningScrollState = new Map();
  surface.reasoningScrollFrameIds = new Map();
  surface.reasoningScrollTargets = new Map();
  surface.messageRenderState = new Map();
  surface.pendingRenderPromise = null;
  surface.pendingFullRender = false;
  surface.pendingProviderProgressMessageIds = new Set();
  surface.thinkingShimmerProbeSequence = 0;
  surface.thinkingShimmerProbeTimers = new Set();
}

class ChatView extends ItemView {
  constructor(leaf, chatController, diagnostics = null) {
    super(leaf);
    initializeChatSurface(this, chatController, diagnostics);
  }

  getViewType() {
    return VIEW_TYPE_CODRIVER;
  }

  getDisplayText() {
    return "CoDriver";
  }

  getIcon() {
    return "messages-square";
  }

  async onOpen() {
    this.chatController.setStateChangeHandler((change) => this.scheduleRender(change));
    this.chatController.handleActiveFileChange();
    this.registerEvent(this.app.workspace.on("file-open", () => {
      this.proposalNoteContentCache.clear();
      this.chatController.handleActiveFileChange();
      this.render();
    }));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      this.chatController.handleVaultFileRename(file, oldPath);
      this.render();
    }));
    this.registerEvent(this.app.vault.on("delete", (file) => {
      this.chatController.handleVaultFileDelete(file);
      this.render();
    }));
    this.registerEvent(this.app.metadataCache.on("changed", (file) => {
      this.clearProposalNoteContentCache(file?.path);
      this.render();
    }));
    this.registerDomEvent(document, "click", (event) => this.handleDocumentClick(event));
    this.render();
  }

  async onClose() {
    this.chatController.setStateChangeHandler(null);
    this.clearAllMcpToolCallCollapseTimers();
    this.fileInputEl = null;
    this.messageInputEl = null;
    this.proposalNoteContentCache.clear();
    this.clearReasoningScrollFrames();
    this.clearThinkingShimmerProbeTimers();
    this.reasoningDisclosureState.clear();
    this.reasoningFinalCollapseApplied.clear();
    this.reasoningScrollState.clear();
    this.reasoningScrollTargets.clear();
    this.messageRenderState.clear();
    this.pendingProviderProgressMessageIds.clear();
    this.containerEl.empty();
  }

  scheduleRender(change = null) {
    const isProviderProgress = change?.type === "provider-progress" &&
      typeof change.messageId === "string" &&
      change.messageId;
    if (isProviderProgress) {
      if (!(this.pendingProviderProgressMessageIds instanceof Set)) {
        this.pendingProviderProgressMessageIds = new Set();
      }
      this.pendingProviderProgressMessageIds.add(change.messageId);
    } else {
      this.pendingFullRender = true;
    }
    if (this.pendingRenderPromise) {
      return this.pendingRenderPromise;
    }

    const renderPendingState = () => {
      const requiresFullRender = this.pendingFullRender === true;
      const progressMessageIds = this.pendingProviderProgressMessageIds instanceof Set
        ? [...this.pendingProviderProgressMessageIds]
        : [];
      this.pendingFullRender = false;
      this.pendingProviderProgressMessageIds?.clear?.();

      if (requiresFullRender) {
        this.render();
        return;
      }

      const updatedEveryMessage = progressMessageIds.length > 0 && progressMessageIds.every((messageId) => (
        this.renderProviderProgress(messageId)
      ));
      if (!updatedEveryMessage) {
        this.render();
      }
    };

    if (typeof requestAnimationFrame === "function") {
      this.pendingRenderPromise = new Promise((resolve) => {
        requestAnimationFrame(() => {
          this.pendingRenderPromise = null;
          renderPendingState();
          resolve();
        });
      });
      return this.pendingRenderPromise;
    }

    renderPendingState();
    return Promise.resolve();
  }

  handleDocumentClick(event) {
    if (!this.contextPickerOpen && !this.mcpServerPickerOpen && !this.requestInfoOpen && !this.commandMenuOpen) {
      return;
    }

    const target = event.target;
    const contextControls = this.containerEl.querySelector(".codriver-context-picker");
    const modelControls = this.containerEl.querySelector(".codriver-model-controls");
    const commandSuggestions = this.containerEl.querySelector(".codriver-skill-suggestions");
    if (
      target instanceof Node &&
      (contextControls?.contains(target) || modelControls?.contains(target) || commandSuggestions?.contains(target))
    ) {
      return;
    }

    this.contextPickerOpen = false;
    this.mcpServerPickerOpen = false;
    this.requestInfoOpen = false;
    this.commandMenuOpen = false;
    this.render();
  }

  render() {
    this.captureDraftMessage();
    const timelineScrollState = this.captureTimelineScrollState();
    const root = this.contentEl;
    this.clearReasoningScrollFrames();
    if (!(this.messageRenderState instanceof Map)) {
      this.messageRenderState = new Map();
    } else {
      this.messageRenderState.clear();
    }
    root.empty();
    root.addClass("codriver-chat-view");

    const timeline = this.renderTimeline(root);
    this.renderComposer(root);
    this.restoreTimelineScrollState(timeline, timelineScrollState);
  }

  captureDraftMessage() {
    if (this.messageInputEl) {
      this.draftMessage = this.getComposerValue(this.messageInputEl);
      const selection = this.getComposerSelection(this.messageInputEl);
      this.draftSelectionStart = selection.start;
      this.draftSelectionEnd = selection.end;
    }
  }

  renderTimeline(root) {
    const timeline = root.createDiv({ cls: "codriver-chat-timeline" });
    for (const timelineItem of this.chatController.getTimelineItems()) {
      if (timelineItem.type === "message") {
        this.renderMessage(timeline, timelineItem.item);
        continue;
      }

      if (timelineItem.type === "proposal") {
        this.renderApproval(timeline, timelineItem.item);
        continue;
      }

      if (timelineItem.type === "tool-call") {
        this.renderMcpToolCall(timeline, timelineItem.item);
        continue;
      }

      if (timelineItem.type === "attachment") {
        this.renderAttachment(timeline, timelineItem.item);
      }
    }

    return timeline;
  }

  renderAttachment(timeline, attachment) {
    const row = timeline.createDiv({
      cls: `codriver-attachment-row codriver-attachment-row-${attachment.status}`
    });
    const card = row.createDiv({
      cls: `codriver-attachment-card codriver-attachment-card-${attachment.status}`
    });
    const icon = card.createDiv({ cls: "codriver-attachment-icon" });
    setIcon(icon, getAttachmentIcon(attachment));

    const body = card.createDiv({ cls: "codriver-attachment-body" });
    body.createDiv({ cls: "codriver-attachment-name", text: attachment.name });
    body.createDiv({ cls: "codriver-attachment-meta", text: formatAttachmentMeta(attachment) });

    const removeButton = card.createEl("button", {
      cls: "codriver-attachment-remove",
      attr: {
        title: "Remove file"
      }
    });
    setIcon(removeButton, "x");
    removeButton.addEventListener("click", (event) => {
      event.stopPropagation();
      this.chatController.deleteAttachment(attachment.id);
      this.render();
    });
  }

  captureTimelineScrollState(timeline = null) {
    const effectiveTimeline = timeline ?? this.contentEl.querySelector(".codriver-chat-timeline");
    if (!effectiveTimeline) {
      return {
        stickToBottom: true,
        scrollBottomOffset: 0
      };
    }

    const distanceFromBottom = effectiveTimeline.scrollHeight - effectiveTimeline.scrollTop - effectiveTimeline.clientHeight;
    return {
      stickToBottom: distanceFromBottom <= TIMELINE_BOTTOM_STICKY_THRESHOLD_PX,
      scrollBottomOffset: Math.max(0, effectiveTimeline.scrollHeight - effectiveTimeline.scrollTop)
    };
  }

  restoreTimelineScrollState(timeline, state) {
    if (!timeline) {
      return;
    }

    const scroll = () => {
      if (!state || state.stickToBottom) {
        timeline.scrollTop = timeline.scrollHeight;
        return;
      }

      timeline.scrollTop = Math.max(0, timeline.scrollHeight - state.scrollBottomOffset);
    };

    scroll();

    if (state?.stickToBottom && typeof requestAnimationFrame === "function") {
      requestAnimationFrame(scroll);
    }
  }

  renderMessage(timeline, message) {
    const row = timeline.createDiv({
      cls: `codriver-message-row codriver-message-row-${message.role} codriver-message-row-${message.status ?? "complete"}`
    });

    if (message.role === "assistant") {
      const avatar = row.createDiv({ cls: "codriver-message-avatar" });
      setIcon(avatar, "bot");
    }

    const bubble = row.createDiv({
      cls: `codriver-chat-message codriver-chat-message-${message.role} codriver-chat-message-${message.status ?? "complete"}`
    });

    if (message.maxToolsWarning) {
      bubble.addClass("codriver-context-warning-card");
      this.renderMaxToolsWarning(bubble, message);
      return;
    }

    if (message.mcpLimitWarning) {
      bubble.addClass("codriver-context-warning-card");
      this.renderMcpCallLimitWarning(bubble, message);
      return;
    }

    if (message.contextBudgetWarning) {
      bubble.addClass("codriver-context-warning-card");
      this.renderContextBudgetWarning(bubble, message);
      return;
    }

    let meta = null;
    let thinkingStatus = null;
    if (message.role === "assistant") {
      meta = bubble.createDiv({ cls: "codriver-chat-message-meta" });
      meta.createSpan({ cls: "codriver-chat-message-author", text: message.author ?? "Assistant" });
      if (message.status === "loading") {
        thinkingStatus = this.renderThinkingStatus(meta, "codriver-thinking-status", message.id);
      }
    }

    const content = bubble.createDiv({ cls: "codriver-chat-message-content" });
    const reasoning = this.renderReasoning(content, message);
    let answer = null;
    if (message.content || message.commandName) {
      answer = content.createDiv({ cls: "codriver-chat-message-answer" });
      this.renderMessageContent(answer, message);
    }
    this.renderRequestStatus(content, message);

    if (message.status !== "loading" && message.status !== "streaming") {
      this.renderMessageActions(bubble, message);
    }

    if (typeof message.id === "string" && message.id) {
      if (!(this.messageRenderState instanceof Map)) {
        this.messageRenderState = new Map();
      }
      this.messageRenderState.set(message.id, {
        answer,
        bubble,
        content,
        contentText: String(message.content ?? ""),
        meta,
        reasoning,
        row,
        status: message.status ?? "complete",
        thinkingStatus,
        timeline
      });
    }
  }

  renderProviderProgress(messageId) {
    if (!(this.messageRenderState instanceof Map)) {
      return false;
    }
    const rendered = this.messageRenderState.get(messageId);
    const message = this.chatController.getTimelineItems()
      .find((item) => item.type === "message" && item.item?.id === messageId)
      ?.item;
    if (!rendered || !message || message.role !== "assistant") {
      return false;
    }

    const timelineScrollState = this.captureTimelineScrollState(rendered.timeline);
    this.updateRenderedMessageStatus(rendered, message);
    this.updateRenderedReasoning(rendered, message);
    this.updateRenderedAnswer(rendered, message);

    const shouldShowThinking = message.status === "loading";
    if (shouldShowThinking && !rendered.thinkingStatus) {
      rendered.thinkingStatus = this.renderThinkingStatus(rendered.meta, "codriver-thinking-status", message.id);
    } else if (!shouldShowThinking && rendered.thinkingStatus) {
      removeRenderedElement(rendered.thinkingStatus);
      rendered.thinkingStatus = null;
    }

    this.restoreTimelineScrollState(rendered.timeline, timelineScrollState);
    return true;
  }

  updateRenderedMessageStatus(rendered, message) {
    const nextStatus = message.status ?? "complete";
    if (rendered.status === nextStatus) {
      return;
    }
    rendered.row.removeClass?.(`codriver-message-row-${rendered.status}`);
    rendered.row.addClass?.(`codriver-message-row-${nextStatus}`);
    rendered.bubble.removeClass?.(`codriver-chat-message-${rendered.status}`);
    rendered.bubble.addClass?.(`codriver-chat-message-${nextStatus}`);
    rendered.status = nextStatus;
  }

  updateRenderedReasoning(rendered, message) {
    const blocks = normalizeVisibleReasoningBlocks(message.reasoningBlocks);
    if (blocks.length === 0) {
      return;
    }
    if (!rendered.reasoning) {
      rendered.reasoning = this.renderReasoning(rendered.content, message);
      return;
    }

    const reasoning = rendered.reasoning;
    const disclosureOpen = this.resolveReasoningDisclosureOpen(message);
    if (reasoning.disclosure.open !== disclosureOpen) {
      reasoning.disclosure.open = disclosureOpen;
    }

    let blocksChanged = reasoning.blockElements.length !== blocks.length;
    for (let index = 0; index < blocks.length; index += 1) {
      const blockText = blocks[index];
      const existingBlock = reasoning.blockElements[index];
      if (!existingBlock) {
        reasoning.blockElements.push(reasoning.viewport.createDiv({
          cls: "codriver-reasoning-block",
          text: blockText
        }));
        blocksChanged = true;
        continue;
      }
      if (existingBlock.textContent !== blockText) {
        existingBlock.textContent = blockText;
        blocksChanged = true;
      }
    }
    while (reasoning.blockElements.length > blocks.length) {
      removeRenderedElement(reasoning.blockElements.pop());
      blocksChanged = true;
    }

    if (blocksChanged) {
      this.queueReasoningTailFollow(reasoning.viewport, message, reasoning.disclosure.open);
    }
  }

  updateRenderedAnswer(rendered, message) {
    const contentText = String(message.content ?? "");
    if (rendered.contentText === contentText) {
      return;
    }
    removeRenderedElement(rendered.answer);
    rendered.answer = null;
    rendered.contentText = contentText;
    if (!contentText) {
      return;
    }
    rendered.answer = rendered.content.createDiv({ cls: "codriver-chat-message-answer" });
    this.renderMessageContent(rendered.answer, message);
  }

  renderReasoning(container, message) {
    const blocks = normalizeVisibleReasoningBlocks(message.reasoningBlocks);
    if (blocks.length === 0) {
      return null;
    }
    if (!(this.reasoningDisclosureState instanceof Map)) {
      this.reasoningDisclosureState = new Map();
    }
    if (!(this.reasoningFinalCollapseApplied instanceof Set)) {
      this.reasoningFinalCollapseApplied = new Set();
    }
    if (!(this.reasoningScrollState instanceof Map)) {
      this.reasoningScrollState = new Map();
    }
    if (!(this.reasoningScrollFrameIds instanceof Map)) {
      this.reasoningScrollFrameIds = new Map();
    }
    const disclosure = container.createEl("details", {
      cls: "codriver-reasoning-disclosure"
    });
    disclosure.open = this.resolveReasoningDisclosureOpen(message);
    const summary = disclosure.createEl("summary", {
      cls: "codriver-reasoning-summary"
    });
    summary.createSpan({ text: "Reasoning" });
    const body = disclosure.createDiv({
      cls: "codriver-reasoning-body"
    });
    const viewport = body.createDiv({
      cls: "codriver-reasoning-viewport",
      attr: {
        "aria-label": "Reasoning details",
        role: "region",
        tabindex: "0"
      }
    });
    const blockElements = blocks.map((block) => (
      viewport.createDiv({ cls: "codriver-reasoning-block", text: block })
    ));
    this.bindReasoningScrollState(viewport, message, disclosure.open);
    disclosure.addEventListener("toggle", () => {
      this.reasoningDisclosureState.set(message.id, disclosure.open);
      if (!disclosure.open) {
        this.cancelReasoningScrollFrame(message.id);
        return;
      }
      this.queueReasoningTailFollow(viewport, message, true);
    });
    return {
      blockElements,
      body,
      disclosure,
      viewport
    };
  }

  resolveReasoningDisclosureOpen(message) {
    if (!(this.reasoningDisclosureState instanceof Map)) {
      this.reasoningDisclosureState = new Map();
    }
    if (!(this.reasoningFinalCollapseApplied instanceof Set)) {
      this.reasoningFinalCollapseApplied = new Set();
    }
    if (!(this.reasoningScrollState instanceof Map)) {
      this.reasoningScrollState = new Map();
    }

    if (message.reasoningCollapsed === false) {
      this.reasoningFinalCollapseApplied.delete(message.id);
    } else if (!this.reasoningFinalCollapseApplied.has(message.id)) {
      this.reasoningDisclosureState.delete(message.id);
      this.reasoningScrollState.delete(message.id);
      this.cancelReasoningScrollFrame(message.id);
      this.reasoningFinalCollapseApplied.add(message.id);
      return false;
    }

    const rememberedState = this.reasoningDisclosureState.get(message.id);
    return typeof rememberedState === "boolean"
      ? rememberedState
      : message.reasoningCollapsed === false;
  }

  renderThinkingStatus(container, className, messageId = "") {
    const status = container.createDiv({
      cls: `${className} codriver-thinking-shimmer`,
      text: "Thinking"
    });
    const clock = typeof this.thinkingShimmerClock === "function"
      ? this.thinkingShimmerClock()
      : readAnimationClockMilliseconds();
    const phase = readNonNegativeNumber(clock) % THINKING_SHIMMER_DURATION_MS;
    status.style?.setProperty?.(
      "--codriver-thinking-shimmer-delay",
      `${-phase}ms`
    );
    this.queueThinkingShimmerProbe(status, messageId);
    return status;
  }

  queueThinkingShimmerProbe(status, messageId = "") {
    const diagnostics = this.diagnostics;
    if (!isDetailedDiagnosticLogger(diagnostics)) {
      return;
    }

    if (!(this.thinkingShimmerProbeTimers instanceof Set)) {
      this.thinkingShimmerProbeTimers = new Set();
    }
    this.thinkingShimmerProbeSequence = readNonNegativeNumber(this.thinkingShimmerProbeSequence) + 1;
    const probeId = this.thinkingShimmerProbeSequence;
    const normalizedMessageId = normalizeDiagnosticIdentifier(messageId);
    const environment = typeof this.thinkingShimmerProbeEnvironment === "function"
      ? this.thinkingShimmerProbeEnvironment()
      : globalThis;
    const clock = typeof this.thinkingShimmerProbeClock === "function"
      ? this.thinkingShimmerProbeClock
      : readAnimationClockMilliseconds;
    const startedAt = clock();
    const initialSnapshot = captureThinkingShimmerSnapshot(status, environment);
    this.writeThinkingShimmerDiagnostic("ui.thinking_shimmer.probe.created", {
      probeId,
      ...(normalizedMessageId ? { messageId: normalizedMessageId } : {}),
      ...createThinkingShimmerRuntimeDetail(environment, Boolean(Platform?.isMobileApp)),
      snapshot: initialSnapshot
    });

    const schedule = typeof this.thinkingShimmerProbeScheduler === "function"
      ? this.thinkingShimmerProbeScheduler
      : (callback, delay) => setTimeout(callback, delay);
    let timerId = null;
    const sample = () => {
      if (timerId !== null) {
        this.thinkingShimmerProbeTimers?.delete?.(timerId);
      }
      const sampledAt = clock();
      const sampledSnapshot = captureThinkingShimmerSnapshot(status, environment);
      this.writeThinkingShimmerDiagnostic("ui.thinking_shimmer.probe.sampled", {
        probeId,
        ...(normalizedMessageId ? { messageId: normalizedMessageId } : {}),
        comparison: compareThinkingShimmerSnapshots(
          initialSnapshot,
          sampledSnapshot,
          Math.max(0, sampledAt - startedAt)
        ),
        snapshot: sampledSnapshot
      });
    };
    timerId = schedule(sample, THINKING_SHIMMER_PROBE_DELAY_MS);
    if (timerId !== null && timerId !== undefined) {
      this.thinkingShimmerProbeTimers.add(timerId);
    }
  }

  writeThinkingShimmerDiagnostic(event, detail) {
    try {
      const result = this.diagnostics?.debug?.(event, detail);
      result?.catch?.(() => {});
    } catch {
      // Diagnostics must never affect chat rendering.
    }
  }

  clearThinkingShimmerProbeTimers() {
    if (!(this.thinkingShimmerProbeTimers instanceof Set)) {
      return;
    }
    const clear = typeof this.thinkingShimmerProbeClearer === "function"
      ? this.thinkingShimmerProbeClearer
      : clearTimeout;
    for (const timerId of this.thinkingShimmerProbeTimers) {
      clear(timerId);
    }
    this.thinkingShimmerProbeTimers.clear();
  }

  bindReasoningScrollState(body, message, disclosureOpen) {
    if (!(this.reasoningScrollState instanceof Map)) {
      this.reasoningScrollState = new Map();
    }
    if (!(this.reasoningScrollFrameIds instanceof Map)) {
      this.reasoningScrollFrameIds = new Map();
    }
    if (!(this.reasoningScrollTargets instanceof Map)) {
      this.reasoningScrollTargets = new Map();
    }

    const messageId = message.id;
    const remembered = this.reasoningScrollState.get(messageId) ?? {
      followTail: true,
      scrollTop: 0
    };
    const readScrollMetrics = () => ({
      clientHeight: readNonNegativeNumber(body.clientHeight),
      scrollHeight: readNonNegativeNumber(body.scrollHeight),
      scrollTop: readNonNegativeNumber(body.scrollTop)
    });
    const rememberScroll = () => {
      const metrics = readScrollMetrics();
      const distanceFromBottom = Math.max(
        0,
        metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight
      );
      const atBottom = distanceFromBottom <= REASONING_BOTTOM_STICKY_THRESHOLD_PX;
      const automaticScrollActive = this.reasoningScrollTargets.get(messageId)?.body === body;
      this.reasoningScrollState.set(messageId, {
        followTail: automaticScrollActive ? true : atBottom,
        scrollTop: metrics.scrollTop
      });
    };
    const stopAutomaticScroll = () => {
      this.cancelReasoningScrollFrame(messageId);
      this.reasoningScrollState.set(messageId, {
        followTail: false,
        scrollTop: readScrollMetrics().scrollTop
      });
    };

    body.addEventListener("scroll", rememberScroll);
    body.addEventListener("pointerdown", stopAutomaticScroll);
    body.addEventListener("pointerup", rememberScroll);
    body.addEventListener("touchstart", stopAutomaticScroll);
    body.addEventListener("touchend", rememberScroll);
    body.addEventListener("wheel", (event) => {
      if (readFiniteNumber(event?.deltaY) < 0) {
        stopAutomaticScroll();
      }
    });
    body.addEventListener("keydown", (event) => {
      if (["ArrowUp", "PageUp", "Home"].includes(event?.key)) {
        stopAutomaticScroll();
      }
    });

    const metrics = readScrollMetrics();
    const maximumScrollTop = Math.max(0, metrics.scrollHeight - metrics.clientHeight);
    body.scrollTop = Math.min(remembered.scrollTop, maximumScrollTop);
    this.queueReasoningTailFollow(body, message, disclosureOpen);
  }

  queueReasoningTailFollow(body, message, disclosureOpen) {
    if (!(this.reasoningScrollState instanceof Map)) {
      this.reasoningScrollState = new Map();
    }
    if (!(this.reasoningScrollFrameIds instanceof Map)) {
      this.reasoningScrollFrameIds = new Map();
    }
    if (!(this.reasoningScrollTargets instanceof Map)) {
      this.reasoningScrollTargets = new Map();
    }

    const messageId = message.id;
    const remembered = this.reasoningScrollState.get(messageId) ?? {
      followTail: true,
      scrollTop: readNonNegativeNumber(body.scrollTop)
    };
    if (
      disclosureOpen !== true ||
      message.reasoningStreaming !== true ||
      remembered.followTail !== true
    ) {
      return;
    }

    const targetScrollTop = Math.max(
      0,
      readNonNegativeNumber(body.scrollHeight) - readNonNegativeNumber(body.clientHeight)
    );
    const existingTarget = this.reasoningScrollTargets.get(messageId);
    if (existingTarget?.body === body) {
      existingTarget.targetScrollTop = targetScrollTop;
      return;
    }

    this.cancelReasoningScrollFrame(messageId);
    const scheduleFrame = typeof this.reasoningAnimationFrame === "function"
      ? this.reasoningAnimationFrame
      : typeof requestAnimationFrame === "function"
        ? requestAnimationFrame
        : null;
    if (!scheduleFrame) {
      body.scrollTop = targetScrollTop;
      this.reasoningScrollState.set(messageId, {
        followTail: true,
        scrollTop: targetScrollTop
      });
      return;
    }

    const target = {
      body,
      targetScrollTop
    };
    this.reasoningScrollTargets.set(messageId, target);
    const step = () => {
      if (this.reasoningScrollTargets.get(messageId) !== target) {
        return;
      }
      target.targetScrollTop = Math.max(
        0,
        readNonNegativeNumber(body.scrollHeight) - readNonNegativeNumber(body.clientHeight)
      );
      const currentScrollTop = readNonNegativeNumber(body.scrollTop);
      const distance = target.targetScrollTop - currentScrollTop;
      if (distance <= 0.5) {
        body.scrollTop = target.targetScrollTop;
        this.reasoningScrollState.set(messageId, {
          followTail: true,
          scrollTop: target.targetScrollTop
        });
        this.reasoningScrollFrameIds.delete(messageId);
        this.reasoningScrollTargets.delete(messageId);
        return;
      }

      const nextScrollTop = Math.min(
        target.targetScrollTop,
        currentScrollTop + Math.max(1, distance * 0.28)
      );
      body.scrollTop = nextScrollTop;
      this.reasoningScrollState.set(messageId, {
        followTail: true,
        scrollTop: nextScrollTop
      });
      const frameId = scheduleFrame(step);
      this.reasoningScrollFrameIds.set(messageId, frameId);
    };
    const frameId = scheduleFrame(step);
    this.reasoningScrollFrameIds.set(messageId, frameId);
  }

  cancelReasoningScrollFrame(messageId) {
    if (!(this.reasoningScrollFrameIds instanceof Map)) {
      return;
    }
    const frameId = this.reasoningScrollFrameIds.get(messageId);
    const cancelFrame = typeof this.reasoningCancelAnimationFrame === "function"
      ? this.reasoningCancelAnimationFrame
      : typeof cancelAnimationFrame === "function"
        ? cancelAnimationFrame
        : null;
    if (frameId !== undefined && cancelFrame) {
      cancelFrame(frameId);
    }
    this.reasoningScrollFrameIds.delete(messageId);
    this.reasoningScrollTargets?.delete?.(messageId);
  }

  clearReasoningScrollFrames() {
    if (!(this.reasoningScrollFrameIds instanceof Map)) {
      return;
    }
    for (const messageId of this.reasoningScrollFrameIds.keys()) {
      this.cancelReasoningScrollFrame(messageId);
    }
  }

  renderRequestStatus(container, message) {
    if (typeof message.requestStatusText === "string" && message.requestStatusText) {
      container.createDiv({
        cls: `codriver-request-status${message.status === "error" ? " is-error" : ""}`,
        text: message.requestStatusText
      });
    }
    if (typeof message.requestError === "string" && message.requestError) {
      container.createDiv({ cls: "codriver-request-error", text: message.requestError });
    }
  }

  renderMessageContent(container, message) {
    if (message.role === "user" && message.commandName) {
      container.createSpan({ cls: "codriver-message-command", text: `@${message.commandName}` });
      if (message.content) container.createSpan({ cls: "codriver-message-command-text", text: ` ${message.content}` });
      return;
    }
    if (!shouldRenderMarkdownMessage(message)) {
      container.textContent = message.content;
      return;
    }

    container.addClass("markdown-rendered");
    container.addClass("codriver-chat-message-markdown");

    const sourcePath = this.chatController.getContextState().path || "";
    this.bindInternalLinkNavigation(container, sourcePath);
    if (MarkdownRenderer && typeof MarkdownRenderer.render === "function") {
      try {
        const renderResult = MarkdownRenderer.render(this.app, message.content, container, sourcePath, this);
        if (renderResult && typeof renderResult.catch === "function") {
          void renderResult.catch(() => {
            container.textContent = message.content;
          });
        }
      } catch {
        container.textContent = message.content;
      }
      return;
    }

    if (MarkdownRenderer && typeof MarkdownRenderer.renderMarkdown === "function") {
      try {
        const renderResult = MarkdownRenderer.renderMarkdown(message.content, container, sourcePath, this);
        if (renderResult && typeof renderResult.catch === "function") {
          void renderResult.catch(() => {
            container.textContent = message.content;
          });
        }
      } catch {
        container.textContent = message.content;
      }
      return;
    }

    container.textContent = message.content;
  }

  bindInternalLinkNavigation(container, sourcePath) {
    if (!container || typeof container.addEventListener !== "function") {
      return;
    }

    if (!this.internalLinkNavigationBindings || typeof this.internalLinkNavigationBindings.get !== "function") {
      this.internalLinkNavigationBindings = new WeakMap();
    }

    const existingBinding = this.internalLinkNavigationBindings.get(container);
    if (existingBinding) {
      existingBinding.sourcePath = sourcePath;
      return;
    }

    const binding = { sourcePath };
    this.internalLinkNavigationBindings.set(container, binding);
    container.addEventListener("click", (event) => {
      this.handleInternalLinkClick(event, container, binding.sourcePath);
    });
  }

  handleInternalLinkClick(event, container, sourcePath) {
    if (!isPrimaryClick(event)) {
      return;
    }

    const target = event?.target;
    if (!target || typeof target.closest !== "function") {
      return;
    }

    const link = target.closest("a.internal-link");
    if (!link || typeof container.contains !== "function" || !container.contains(link)) {
      return;
    }

    const linktext = getInternalLinkTarget(link);
    const openLinkText = this.app?.workspace?.openLinkText;
    if (!linktext || typeof openLinkText !== "function") {
      return;
    }

    event.preventDefault();
    const newLeaf = isNewLeafLinkEvent(event);
    try {
      const navigation = openLinkText.call(this.app.workspace, linktext, sourcePath, newLeaf);
      if (navigation && typeof navigation.catch === "function") {
        void navigation.catch(() => {});
      }
    } catch {
      // Keep failed workspace navigation local to the clicked link.
    }
  }

  renderMessageActions(bubble, message) {
    const actions = bubble.createDiv({ cls: "codriver-message-actions" });
    actions.createSpan({ cls: "codriver-chat-message-time", text: message.time ?? "" });

    const copyButton = actions.createEl("button", {
      cls: "codriver-message-action-button",
      attr: {
        title: "Copy message"
      }
    });
    setIcon(copyButton, "copy");
    copyButton.addEventListener("click", async (event) => {
      event.stopPropagation();
      await this.copyMessageContent(message.content);
    });

    const deleteButton = actions.createEl("button", {
      cls: "codriver-message-action-button",
      attr: {
        title: "Delete message"
      }
    });
    setIcon(deleteButton, "trash-2");
    deleteButton.addEventListener("click", (event) => {
      event.stopPropagation();
      this.chatController.deleteMessage(message.id);
      this.render();
    });
  }

  renderContextBudgetWarning(card, message) {
    const warning = message.contextBudgetWarning;
    if (!warning || typeof warning.id !== "string") {
      return;
    }

    const header = card.createDiv({ cls: "codriver-context-warning-header" });
    const heading = header.createDiv({ cls: "codriver-context-warning-heading" });
    const icon = heading.createSpan({
      cls: "codriver-context-warning-icon",
      attr: {
        "aria-hidden": "true"
      }
    });
    setIcon(icon, "triangle-alert");
    heading.createSpan({ cls: "codriver-context-warning-title", text: warning.title || "Context size warning" });
    if (warning.statusText) {
      header.createSpan({ cls: "codriver-context-warning-status", text: warning.statusText });
    }

    const body = card.createDiv({ cls: "codriver-context-warning-body" });
    body.createDiv({
      cls: "codriver-context-warning-copy",
      text: warning.body || "This provider call is larger than Maximum context size. Review the estimate before continuing."
    });
    const values = body.createDiv({ cls: "codriver-context-warning-values" });
    this.renderRequestInfoRow(
      values,
      "Current call",
      `${formatNumber(warning.currentCharacters)} characters (~${formatNumber(warning.estimatedTokens)} tokens)`
    );
    this.renderRequestInfoRow(
      values,
      "Maximum",
      `${formatNumber(warning.maximumCharacters)} characters (~${formatNumber(warning.maximumTokens)} tokens)`
    );
    if (warning.error) {
      body.createDiv({ cls: "codriver-context-warning-error", text: warning.error });
    }

    if (warning.status !== "pending") return;

    const actions = card.createDiv({
      cls: "codriver-context-warning-actions",
      attr: {
        role: "group",
        "aria-label": "Context size warning actions"
      }
    });
    const definitions = [
      {
        decision: "continue",
        label: "Continue",
        title: "Continue this provider call once."
      },
      {
        decision: "continue-session",
        label: "Continue for session",
        title: "Continue and skip context size warnings for this user request."
      },
      {
        decision: "stop",
        label: "Stop",
        title: "Stop this provider call without sending it."
      }
    ];
    const buttons = definitions.map((definition) => {
      const button = actions.createEl("button", {
        cls: `codriver-approval-button codriver-context-warning-${definition.decision}`,
        text: definition.label,
        attr: {
          title: definition.title,
          "aria-label": definition.title
        }
      });
      button.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        for (const item of buttons) item.disabled = true;
        const result = await this.chatController.resolveContextBudgetWarning(warning.id, definition.decision);
        if (result?.ok === false && result.message) new Notice(result.message);
        this.render();
      });
      return button;
    });
  }

  renderMaxToolsWarning(card, message) {
    const warning = message.maxToolsWarning;
    if (!warning) return;
    const header = card.createDiv({ cls: "codriver-context-warning-header" });
    const heading = header.createDiv({ cls: "codriver-context-warning-heading" });
    const icon = heading.createSpan({ cls: "codriver-context-warning-icon", attr: { "aria-hidden": "true" } });
    setIcon(icon, "triangle-alert");
    heading.createSpan({ cls: "codriver-context-warning-title", text: warning.title || "Max tools warning" });
    const body = card.createDiv({ cls: "codriver-context-warning-body" });
    body.createDiv({
      cls: "codriver-context-warning-copy",
      text: warning.status === "pending"
        ? `${formatNumber(warning.totalTools)} MCP tools are available; Max tools is ${formatNumber(warning.maximumTools)}. ${formatNumber(warning.excludedTools)} would be excluded. Continue sends all tools for this request.`
        : message.content
    });
    if (warning.status !== "pending") return;
    const actions = card.createDiv({ cls: "codriver-context-warning-actions", attr: {
      role: "group", "aria-label": "Max tools warning actions"
    } });
    const buttons = [
      ["continue", "Continue", "Send all available MCP tools for this user request."],
      ["stop", "Stop", "Stop this request before sending its MCP tool catalog to the model."]
    ].map(([decision, label, title]) => {
      const button = actions.createEl("button", {
        cls: `codriver-approval-button codriver-context-warning-${decision}`,
        text: label, attr: { title, "aria-label": title }
      });
      button.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        for (const item of buttons) item.disabled = true;
        const result = await this.chatController.resolveMaxToolsWarning(warning.id, decision);
        if (result?.ok === false && result.message) new Notice(result.message);
        this.render();
      });
      return button;
    });
  }

  renderMcpCallLimitWarning(card, message) {
    const warning = message.mcpLimitWarning;
    if (!warning) return;
    const header = card.createDiv({ cls: "codriver-context-warning-header" });
    const heading = header.createDiv({ cls: "codriver-context-warning-heading" });
    const icon = heading.createSpan({ cls: "codriver-context-warning-icon", attr: { "aria-hidden": "true" } });
    setIcon(icon, "triangle-alert");
    heading.createSpan({ cls: "codriver-context-warning-title", text: warning.title || "Max calls warning" });
    const body = card.createDiv({ cls: "codriver-context-warning-body" });
    body.createDiv({
      cls: "codriver-context-warning-copy",
      text: warning.status === "pending"
        ? `Max calls (${formatNumber(warning.maximumCalls)}) was reached before the next automatic MCP tool call.`
        : (message.content || "Automatic MCP tool chain stopped.")
    });
    if (warning.status !== "pending") return;
    const actions = card.createDiv({ cls: "codriver-context-warning-actions", attr: {
      role: "group", "aria-label": "Max calls warning actions"
    } });
    const definitions = [
      ["continue", "Continue", "Run the next automatic MCP call, then warn again at the next limit."],
      ["continue-session", "Continue for session", "Continue this user request without further Max calls warnings."],
      ["stop", "Stop", "Stop the pending automatic MCP tool chain."]
    ];
    const buttons = definitions.map(([decision, label, title]) => {
      const button = actions.createEl("button", {
        cls: `codriver-approval-button codriver-context-warning-${decision}`,
        text: label, attr: { title, "aria-label": title }
      });
      button.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        for (const item of buttons) item.disabled = true;
        const result = await this.chatController.resolveMcpLimitWarning(warning.id, decision);
        if (result?.ok === false && result.message) new Notice(result.message);
        this.render();
      });
      return button;
    });
  }

  async copyMessageContent(content) {
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(content);
      } else if (this.app.clipboardManager?.setClipboard) {
        this.app.clipboardManager.setClipboard(content);
      } else {
        throw new Error("Clipboard is not available.");
      }

      new Notice("Message copied.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to copy message.";
      new Notice(message);
    }
  }

  renderApproval(timeline, proposal) {
    const approval = timeline.createDiv({
      cls: `codriver-approval codriver-approval-${proposal.status}`,
      attr: {
        "data-codriver-proposal-id": proposal.id,
        "aria-busy": proposal.applicationState === "applying" ? "true" : "false"
      }
    });
    const header = approval.createDiv({ cls: "codriver-approval-header" });
    const heading = header.createDiv({ cls: "codriver-approval-heading" });
    heading.createDiv({ cls: "codriver-approval-path", text: proposal.notePath });
    heading.createDiv({ cls: "codriver-approval-title", text: getProposalTitle(proposal) });
    if (proposal.contentUnavailable) {
      approval.createDiv({ cls: "codriver-approval-error", text: "Patch content is not stored in session history. Send a new request to prepare further changes." });
      this.renderApprovalCardActions(approval, proposal);
      return;
    }
    this.renderApprovalViewModeToggle(header, proposal);

    this.renderApprovalDiff(approval, proposal);

    if (proposal.error) {
      approval.createDiv({ cls: "codriver-approval-error", text: proposal.error });
    }
    if (proposal.continuationError) {
      approval.createDiv({ cls: "codriver-approval-error", text: proposal.continuationError });
    }

    if (proposal.applicationState === "applying") {
      const stopButton = approval.createEl("button", { text: "Stop continuation" });
      stopButton.addEventListener("click", () => {
        this.chatController.cancelProposalContinuation(proposal.id);
        this.render();
      });
      return;
    }

    this.renderApprovalCardActions(approval, proposal);

    const actions = approval.createDiv({ cls: "codriver-approval-actions" });
    if (proposal.status === "pending") {
      const acceptButton = actions.createEl("button", {
        cls: "codriver-approval-button codriver-approval-button-accept"
      });
      const acceptIcon = acceptButton.createSpan({ cls: "codriver-approval-button-icon" });
      setIcon(acceptIcon, "check");
      acceptButton.createSpan({ text: "Accept" });
      acceptButton.addEventListener("click", async () => {
        acceptButton.disabled = true;
        const result = await this.chatController.acceptProposal(proposal.id);
        this.clearProposalNoteContentCache(proposal.notePath);
        new Notice(result.message);
        this.render();
      });

      const rejectButton = actions.createEl("button", { cls: "codriver-approval-button codriver-approval-button-reject" });
      const rejectIcon = rejectButton.createSpan({ cls: "codriver-approval-button-icon" });
      setIcon(rejectIcon, "x");
      rejectButton.createSpan({ text: "Reject" });
      rejectButton.addEventListener("click", () => {
        this.chatController.rejectProposal(proposal.id);
        this.render();
      });
      return;
    }

    if (proposal.status === "accepted") {
      const rollbackButton = actions.createEl("button", { cls: "codriver-approval-button codriver-approval-button-rollback" });
      const rollbackIcon = rollbackButton.createSpan({ cls: "codriver-approval-button-icon" });
      setIcon(rollbackIcon, "rotate-ccw");
      rollbackButton.createSpan({ text: "Roll back" });
      rollbackButton.addEventListener("click", async () => {
        rollbackButton.disabled = true;
        const result = await this.chatController.rollbackProposal(proposal.id);
        this.clearProposalNoteContentCache(proposal.notePath);
        new Notice(result.message);
        this.render();
      });
    }
  }

  renderApprovalDiff(approval, proposal) {
    if (isTextProposal(proposal) && this.getProposalDiffMode(proposal) === "unified") {
      this.renderApprovalUnifiedDiff(approval, proposal);
      return;
    }

    if (proposal.kind !== "frontmatter" && hasProposalTextChanges(proposal)) {
      this.renderApprovalChangeList(approval, proposal);
      return;
    }

    const before = formatProposalValue(proposal.before);
    const after = formatProposalValue(proposal.after);
    const diff = createInlineDiff(before, after);
    const diffGrid = approval.createDiv({
      cls: "codriver-approval-diff codriver-approval-diff-side-by-side"
    });

    const beforePane = this.renderApprovalDiffPane(diffGrid, getProposalBeforeLabel(proposal), "before", diff.beforeTokens);
    const afterPane = this.renderApprovalDiffPane(diffGrid, getProposalAfterLabel(proposal), "after", diff.afterTokens);
    this.syncApprovalPaneScrolling(beforePane, afterPane);
  }

  renderApprovalViewModeToggle(parent, proposal) {
    if (!isTextProposal(proposal)) {
      return;
    }

    const currentMode = this.getProposalDiffMode(proposal);
    const isActive = currentMode === "side-by-side";
    const button = parent.createEl("button", {
      cls: `codriver-approval-view-toggle-button${isActive ? " is-active" : ""}`,
      text: "Side by side",
      attr: {
        type: "button",
        "aria-label": "Side by side proposal diff view",
        "aria-pressed": String(isActive),
        title: "Side by side"
      }
    });

    button.addEventListener("click", (event) => {
      event.preventDefault();
      this.proposalDiffModes.set(proposal.id, isActive ? "unified" : "side-by-side");
      this.renderWithProposalAnchor(proposal.id);
    });
  }

  renderWithProposalAnchor(proposalId) {
    const anchorState = this.captureProposalAnchorState(proposalId);
    this.render();
    this.restoreProposalAnchorState(anchorState);
  }

  captureProposalAnchorState(proposalId) {
    const timeline = this.contentEl.querySelector(".codriver-chat-timeline");
    const anchor = findProposalElement(timeline, proposalId);
    if (!timeline || !anchor) {
      return null;
    }

    return {
      proposalId,
      topOffset: anchor.getBoundingClientRect().top - timeline.getBoundingClientRect().top
    };
  }

  restoreProposalAnchorState(state) {
    if (!state) {
      return;
    }

    const scroll = () => {
      const timeline = this.contentEl.querySelector(".codriver-chat-timeline");
      const anchor = findProposalElement(timeline, state.proposalId);
      if (!timeline || !anchor) {
        return;
      }

      const nextOffset = anchor.getBoundingClientRect().top - timeline.getBoundingClientRect().top;
      timeline.scrollTop += nextOffset - state.topOffset;
    };

    scroll();

    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(scroll);
    }
  }

  getProposalDiffMode(proposal) {
    if (!isTextProposal(proposal)) {
      return "side-by-side";
    }

    return this.proposalDiffModes.get(proposal.id) === "side-by-side" ? "side-by-side" : "unified";
  }

  renderApprovalUnifiedDiff(approval, proposal) {
    const changes = getProposalTextChanges(proposal);
    const noteContent = this.getProposalNoteContent(proposal);
    const previewRows = typeof noteContent === "string"
      ? createUnifiedTextChangeRows(noteContent, getProposalPreviewTextChanges(proposal))
      : null;
    if (previewRows) {
      this.renderApprovalUnifiedDiffRows(approval, previewRows);
      return;
    }

    if (changes.length === 0) {
      const before = formatProposalValue(proposal.before);
      const after = formatProposalValue(proposal.after);
      this.renderApprovalUnifiedDiffRows(approval, createUnifiedDiffRows(before, after));
      return;
    }

    const rows = changes.flatMap((change) => {
      const reviewText = getProposalChangeReviewText(change);
      return createUnifiedDiffRows(reviewText.before, reviewText.after);
    });
    this.renderApprovalUnifiedDiffRows(approval, rows);
  }

  renderApprovalUnifiedDiffRows(parent, rows) {
    const diff = parent.createDiv({ cls: "codriver-approval-unified-diff" });
    diff.setAttribute("role", "table");
    diff.setAttribute("aria-label", "Unified proposal diff");

    if (rows.length === 0) {
      const empty = diff.createDiv({ cls: "codriver-approval-unified-empty" });
      empty.createSpan({ cls: "codriver-approval-empty", text: "(empty)" });
      return diff;
    }

    rows.forEach((row) => {
      const rowEl = diff.createDiv({
        cls: `codriver-approval-unified-row codriver-approval-unified-row-${row.type}`
      });
      rowEl.setAttribute("role", "row");
      this.renderApprovalUnifiedDiffCell(
        rowEl,
        formatDiffLineNumber(row.oldLineNumber),
        "codriver-approval-unified-line-number",
        "cell"
      );
      this.renderApprovalUnifiedDiffCell(
        rowEl,
        formatDiffLineNumber(row.newLineNumber),
        "codriver-approval-unified-line-number",
        "cell"
      );
      this.renderApprovalUnifiedDiffCell(rowEl, row.marker, "codriver-approval-unified-marker", "cell");
      this.renderApprovalUnifiedDiffCell(
        rowEl,
        row.content.length > 0 ? row.content : " ",
        `codriver-approval-unified-line${row.content.length === 0 ? " is-empty-line" : ""}`,
        "cell"
      );
    });

    return diff;
  }

  renderApprovalUnifiedDiffCell(rowEl, text, cls, role) {
    const cell = rowEl.createDiv({ cls: `codriver-approval-unified-cell ${cls}`, text });
    cell.setAttribute("role", role);
    return cell;
  }

  getProposalNoteContent(proposal) {
    if (!isTextProposal(proposal) || typeof proposal.notePath !== "string") {
      return null;
    }

    const notePath = normalizeProposalNotePath(proposal.notePath);
    if (!notePath) {
      return null;
    }

    const cached = this.proposalNoteContentCache.get(notePath);
    if (cached?.status === "ready") {
      return cached.content;
    }

    if (!cached) {
      this.loadProposalNoteContent(notePath);
    }

    return null;
  }

  loadProposalNoteContent(notePath) {
    const vault = this.app.vault;
    const file = vault?.getAbstractFileByPath?.(notePath);
    if (!file || file.extension !== "md") {
      this.proposalNoteContentCache.set(notePath, { status: "unavailable", content: null });
      return;
    }

    const reader = typeof vault.cachedRead === "function" ? vault.cachedRead : vault.read;
    if (typeof reader !== "function") {
      this.proposalNoteContentCache.set(notePath, { status: "unavailable", content: null });
      return;
    }

    this.proposalNoteContentCache.set(notePath, { status: "loading", content: null });
    Promise.resolve(reader.call(vault, file))
      .then((content) => {
        this.proposalNoteContentCache.set(notePath, {
          status: "ready",
          content: String(content ?? "")
        });
        void this.scheduleRender();
      })
      .catch(() => {
        this.proposalNoteContentCache.set(notePath, { status: "unavailable", content: null });
      });
  }

  clearProposalNoteContentCache(notePath = "") {
    const normalizedPath = normalizeProposalNotePath(notePath);
    if (normalizedPath) {
      this.proposalNoteContentCache.delete(normalizedPath);
      return;
    }

    this.proposalNoteContentCache.clear();
  }

  renderApprovalChangeList(approval, proposal) {
    const changes = getProposalTextChanges(proposal);
    const changeList = approval.createDiv({ cls: "codriver-approval-change-list" });

    changes.forEach((change, index) => {
      const hunk = changeList.createDiv({ cls: "codriver-approval-hunk" });
      if (changes.length > 1) {
        hunk.createDiv({ cls: "codriver-approval-hunk-title", text: `Change ${index + 1}` });
      }

      const diffGrid = hunk.createDiv({
        cls: "codriver-approval-diff codriver-approval-diff-side-by-side"
      });

      const beforePane = this.renderApprovalChangePane(diffGrid, "Current", "before", change);
      const afterPane = this.renderApprovalChangePane(diffGrid, "Proposed", "after", change);
      this.syncApprovalPaneScrolling(beforePane, afterPane);
    });
  }

  renderApprovalChangePane(diffGrid, label, side, change) {
    const pane = diffGrid.createDiv({ cls: `codriver-approval-pane codriver-approval-pane-${side}` });
    pane.createDiv({ cls: "codriver-approval-label", text: label });
    const content = pane.createDiv({ cls: "codriver-approval-code" });

    if (change.contextBefore) {
      content.createSpan({ text: change.contextBefore });
    }

    content.createSpan({
      cls: `codriver-approval-token codriver-approval-token-${side === "before" ? "removed" : "added"}`,
      text: side === "before" ? change.before : change.after
    });

    if (change.contextAfter) {
      content.createSpan({ text: change.contextAfter });
    }

    return content;
  }

  renderApprovalDiffPane(diffGrid, label, side, tokens) {
    const pane = diffGrid.createDiv({ cls: `codriver-approval-pane codriver-approval-pane-${side}` });
    pane.createDiv({ cls: "codriver-approval-label", text: label });
    const content = pane.createDiv({ cls: "codriver-approval-code" });

    if (tokens.length === 0) {
      content.createSpan({ cls: "codriver-approval-empty", text: "(empty)" });
      return content;
    }

    for (const token of tokens) {
      if (token.type === "equal") {
        content.createSpan({ text: token.value });
        continue;
      }

      content.createSpan({
        cls: `codriver-approval-token codriver-approval-token-${token.type}`,
        text: token.value
      });
    }

    return content;
  }

  syncApprovalPaneScrolling(...panes) {
    const scrollPanes = panes.filter(Boolean);
    if (scrollPanes.length < 2) {
      return;
    }

    let isSyncing = false;
    const releaseSync = () => {
      isSyncing = false;
    };

    for (const pane of scrollPanes) {
      pane.addEventListener("scroll", () => {
        if (isSyncing) {
          return;
        }

        isSyncing = true;
        for (const target of scrollPanes) {
          if (target === pane) {
            continue;
          }

          target.scrollTop = pane.scrollTop;
          target.scrollLeft = pane.scrollLeft;
        }

        if (typeof requestAnimationFrame === "function") {
          requestAnimationFrame(releaseSync);
        } else {
          releaseSync();
        }
      }, { passive: true });
    }
  }

  renderApprovalCardActions(approval, proposal) {
    const actions = approval.createDiv({ cls: "codriver-approval-card-actions codriver-message-actions" });
    actions.createSpan({ cls: "codriver-chat-message-time", text: proposal.time ?? "" });

    const deleteButton = actions.createEl("button", {
      cls: "codriver-message-action-button",
      attr: {
        title: "Delete proposal"
      }
    });
    setIcon(deleteButton, "trash-2");
    deleteButton.addEventListener("click", (event) => {
      event.stopPropagation();
      this.proposalDiffModes.delete(proposal.id);
      this.chatController.deleteProposal(proposal.id);
      this.render();
    });
  }

  renderMcpToolCall(timeline, toolCall) {
    const card = timeline.createDiv({
      cls: `codriver-mcp-call codriver-mcp-call-${toolCall.status} ${this.getMcpToolCallCollapseClass(toolCall)}`
    });
    if (toolCall.toolName === CODRIVER_VAULT_DELETE_NOTE_TOOL_NAME) {
      card.addClass("codriver-mcp-call-destructive");
    }
    if (this.isMcpToolCallToggleEligible(toolCall)) {
      card.addClass("is-collapsible");
    }

    const header = card.createDiv({ cls: "codriver-mcp-call-header" });
    if (this.isMcpToolCallToggleEligible(toolCall)) {
      header.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();

        if (isMcpToolCallInteractiveTarget(event.target, card)) {
          return;
        }

        this.toggleMcpToolCallCollapse(toolCall.id, card);
      });
    }
    const heading = header.createDiv({ cls: "codriver-mcp-call-heading" });
    const titleRow = heading.createDiv({ cls: "codriver-mcp-call-title-row" });
    titleRow.createDiv({ cls: "codriver-mcp-call-title", text: toolCall.toolTitle || toolCall.toolName });
    if (toolCall.status === "running") {
      titleRow.createSpan({
        cls: "codriver-mcp-call-status-text",
        text: "running"
      });
    }

    if (toolCall.automaticPermissionReadonly !== true) {
      const permission = header.createEl("label", { cls: "codriver-mcp-call-permission" });
      const checkbox = permission.createEl("input", {
        attr: {
          type: "checkbox",
          title: "Allow this tool without confirmation"
        }
      });
      checkbox.checked = toolCall.allowAutomaticExecution === true;
      checkbox.addEventListener("change", async () => {
        const result = await this.chatController.setMcpToolCallAutomaticPermission(toolCall.id, checkbox.checked);
        new Notice(result.message);
        this.render();
      });
      permission.createSpan({ text: "Allow automatically" });
    }

    if (this.isMcpToolCallToggleEligible(toolCall)) {
      const collapsedStatus = header.createSpan({
        cls: "codriver-mcp-call-collapsed-status-icon",
        attr: {
          "aria-label": getMcpToolCallStatusLabel(toolCall.status),
          title: getMcpToolCallStatusLabel(toolCall.status)
        }
      });
      if (toolCall.status === "running") {
        collapsedStatus.createSpan({ cls: "codriver-mcp-call-running-dot" });
      } else {
        setIcon(collapsedStatus, getMcpToolCallStatusIcon(toolCall.status));
      }
    }

    const body = card.createDiv({ cls: "codriver-mcp-call-body" });
    if (toolCall.toolName === CODRIVER_VAULT_CREATE_NOTE_TOOL_NAME && toolCall.createNoteReview) {
      this.renderCreateNoteReview(body, toolCall);
    }
    if (toolCall.toolName === CODRIVER_VAULT_DELETE_NOTE_TOOL_NAME) {
      this.renderDeleteNoteReview(body, toolCall);
    }
    if (toolCall.toolName === CODRIVER_VAULT_TRANSCRIBE_AUDIO_TOOL_NAME) {
      this.renderAudioTranscriptionReview(body, toolCall);
    }
    this.renderMcpMutationSummary(body, toolCall);
    this.renderMcpToolCallWritePreview(body, toolCall);
    this.renderMcpToolCallBlock(body, "Arguments", formatJsonValue(toolCall.arguments));

    if (toolCall.output) {
      this.renderMcpToolCallBlock(body, "Output", toolCall.output);
    }

    if (toolCall.outputWarning?.status === "pending") {
      const warning = body.createDiv({ cls: "codriver-mcp-output-warning", attr: { role: "alert" } });
      warning.createDiv({ cls: "codriver-mcp-output-warning-title", text: "Output chars warning" });
      warning.createDiv({
        text: `This tool returned ${formatNumber(toolCall.outputWarning.currentCharacters)} characters, above Output chars ${formatNumber(toolCall.outputWarning.maximumCharacters)}. Review Arguments and Output, then choose Continue to send the full result or Stop to send an error to the model.`
      });
    }

    if (toolCall.error) {
      body.createDiv({ cls: "codriver-mcp-call-error-text", text: toolCall.error });
    }

    this.renderMcpToolCallCardActions(card, toolCall);

    const actions = card.createDiv({
      cls: "codriver-mcp-call-actions",
      ...(toolCall.outputWarning?.status === "pending"
        ? { attr: { role: "group", "aria-label": "MCP output size warning actions" } }
        : {})
    });
    if (toolCall.outputWarning?.status === "pending") {
      const buttons = [
        ["continue", "Continue", "Send this complete MCP tool result to the model."],
        ["stop", "Stop", "Send a tool error to the model without this result."]
      ].map(([decision, label, title]) => {
        const button = actions.createEl("button", {
          cls: `codriver-approval-button codriver-context-warning-${decision}`,
          text: label, attr: { title, "aria-label": title }
        });
        button.addEventListener("click", async (event) => {
          event.preventDefault();
          event.stopPropagation();
          for (const item of buttons) item.disabled = true;
          const result = await this.chatController.resolveMcpLimitWarning(toolCall.outputWarning.id, decision);
          if (result?.ok === false && result.message) new Notice(result.message);
          this.render();
        });
        return button;
      });
    }
    if (toolCall.executionBlockMessage) {
      actions.createDiv({ cls: "codriver-mcp-call-error-text", text: toolCall.executionBlockMessage });
    }
    if (toolCall.status === "pending") {
      const approveButton = actions.createEl("button", { cls: "codriver-approval-button codriver-approval-button-accept" });
      approveButton.disabled = Boolean(toolCall.executionBlockMessage);
      const approveIcon = approveButton.createSpan({ cls: "codriver-approval-button-icon" });
      setIcon(approveIcon, toolCall.toolName === CODRIVER_VAULT_DELETE_NOTE_TOOL_NAME ? "trash-2" : "check");
      approveButton.createSpan({
        text: getMcpToolApproveButtonLabel(toolCall)
      });
      approveButton.addEventListener("click", async () => {
        approveButton.disabled = true;
        const approvePromise = this.chatController.approveMcpToolCall(toolCall.id);
        this.render();
        const result = await approvePromise;
        new Notice(result.message);
        this.render();
      });

      const rejectButton = actions.createEl("button", { cls: "codriver-approval-button codriver-approval-button-reject" });
      const rejectIcon = rejectButton.createSpan({ cls: "codriver-approval-button-icon" });
      setIcon(rejectIcon, "x");
      rejectButton.createSpan({ text: "Reject" });
      rejectButton.addEventListener("click", async () => {
        rejectButton.disabled = true;
        const result = await this.chatController.rejectMcpToolCall(toolCall.id);
        new Notice(result.message);
        this.render();
      });
    }

    if (
      toolCall.toolName === CODRIVER_VAULT_DELETE_NOTE_TOOL_NAME &&
      toolCall.status === "complete" &&
      ["available", "restoring"].includes(toolCall.deleteRecovery?.status)
    ) {
      const restoreButton = actions.createEl("button", {
        cls: "codriver-approval-button codriver-approval-button-rollback"
      });
      const restoreIcon = restoreButton.createSpan({ cls: "codriver-approval-button-icon" });
      setIcon(restoreIcon, "rotate-ccw");
      restoreButton.createSpan({
        text: toolCall.deleteRecovery.status === "restoring" ? "Restoring..." : "Restore note"
      });
      restoreButton.disabled = toolCall.deleteRecovery.status === "restoring";
      restoreButton.addEventListener("click", async (event) => {
        event.stopPropagation();
        restoreButton.disabled = true;
        const restorePromise = this.chatController.restoreDeletedNote(toolCall.id);
        this.render();
        const result = await restorePromise;
        new Notice(result.message);
        this.render();
      });
    }

    this.scheduleMcpToolCallAutoCollapse(toolCall, card);
  }

  getMcpToolCallCollapseClass(toolCall) {
    if (!this.isMcpToolCallToggleEligible(toolCall)) {
      this.clearMcpToolCallCollapseState(toolCall.id);
      return "";
    }

    if (this.collapsedMcpToolCallIds.has(toolCall.id)) {
      return "is-collapsed";
    }

    if (this.autoCollapsingMcpToolCallIds.has(toolCall.id)) {
      return "is-auto-collapsing";
    }

    if (this.expandedMcpToolCallIds.has(toolCall.id)) {
      return "";
    }

    this.collapsedMcpToolCallIds.add(toolCall.id);
    return "is-collapsed";
  }

  isMcpToolCallAutoCollapseEligible(toolCall) {
    return toolCall?.status === "complete";
  }

  isMcpToolCallToggleEligible(toolCall) {
    return ["queued", "running", "complete", "error", "cancelled", "rejected"].includes(toolCall?.status);
  }

  isMcpToolCallVisuallyCollapsed(toolCallId) {
    return this.collapsedMcpToolCallIds.has(toolCallId) ||
      this.autoCollapsingMcpToolCallIds.has(toolCallId);
  }

  scheduleMcpToolCallAutoCollapse(toolCall, card) {
    if (
      !this.isMcpToolCallAutoCollapseEligible(toolCall) ||
      this.collapsedMcpToolCallIds.has(toolCall.id) ||
      this.autoCollapsingMcpToolCallIds.has(toolCall.id) ||
      this.expandedMcpToolCallIds.has(toolCall.id)
    ) {
      return;
    }

    const existingState = this.mcpToolCallCollapseTimers.get(toolCall.id);
    if (existingState?.startTimer) {
      existingState.card = card;
      return;
    }

    if (existingState) {
      return;
    }

    const startTimer = window.setTimeout(() => {
      const state = this.mcpToolCallCollapseTimers.get(toolCall.id);
      if (state?.startTimer) {
        window.clearTimeout(state.startTimer);
      }
      this.mcpToolCallCollapseTimers.delete(toolCall.id);

      if (
        this.expandedMcpToolCallIds.has(toolCall.id) ||
        this.collapsedMcpToolCallIds.has(toolCall.id)
      ) {
        return;
      }

      this.autoCollapsingMcpToolCallIds.add(toolCall.id);
      const currentCard = state?.card ?? card;
      if (currentCard.isConnected) {
        currentCard.addClass("is-auto-collapsing");
      }

      const finishTimer = window.setTimeout(() => {
        const current = this.mcpToolCallCollapseTimers.get(toolCall.id);
        if (current?.finishTimer) {
          window.clearTimeout(current.finishTimer);
        }
        this.mcpToolCallCollapseTimers.delete(toolCall.id);
        this.autoCollapsingMcpToolCallIds.delete(toolCall.id);

        if (!this.expandedMcpToolCallIds.has(toolCall.id)) {
          this.collapsedMcpToolCallIds.add(toolCall.id);
        }

        const finalCard = current?.card ?? currentCard;
        if (finalCard.isConnected) {
          finalCard.removeClass("is-auto-collapsing");
          finalCard.addClass("is-collapsed");
        }
      }, 180);

      this.mcpToolCallCollapseTimers.set(toolCall.id, { finishTimer, card: currentCard });
    }, 500);

    this.mcpToolCallCollapseTimers.set(toolCall.id, { startTimer, card });
  }

  toggleMcpToolCallCollapse(toolCallId, card) {
    if (this.isMcpToolCallVisuallyCollapsed(toolCallId)) {
      this.expandMcpToolCall(toolCallId);
      card.removeClass("is-collapsed");
      card.removeClass("is-auto-collapsing");
      return;
    }

    this.clearMcpToolCallCollapseTimers(toolCallId);
    this.autoCollapsingMcpToolCallIds.delete(toolCallId);
    this.expandedMcpToolCallIds.delete(toolCallId);
    this.collapsedMcpToolCallIds.add(toolCallId);
    card.removeClass("is-auto-collapsing");
    card.addClass("is-collapsed");
  }

  expandMcpToolCall(toolCallId) {
    this.clearMcpToolCallCollapseTimers(toolCallId);
    this.autoCollapsingMcpToolCallIds.delete(toolCallId);
    this.collapsedMcpToolCallIds.delete(toolCallId);
    this.expandedMcpToolCallIds.add(toolCallId);
  }

  clearMcpToolCallCollapseState(toolCallId) {
    this.clearMcpToolCallCollapseTimers(toolCallId);
    this.autoCollapsingMcpToolCallIds.delete(toolCallId);
    this.collapsedMcpToolCallIds.delete(toolCallId);
    this.expandedMcpToolCallIds.delete(toolCallId);
  }

  clearMcpToolCallCollapseTimers(toolCallId) {
    const state = this.mcpToolCallCollapseTimers.get(toolCallId);
    if (state?.startTimer) {
      window.clearTimeout(state.startTimer);
    }
    if (state?.finishTimer) {
      window.clearTimeout(state.finishTimer);
    }
    this.mcpToolCallCollapseTimers.delete(toolCallId);
  }

  clearAllMcpToolCallCollapseTimers() {
    for (const toolCallId of this.mcpToolCallCollapseTimers.keys()) {
      this.clearMcpToolCallCollapseTimers(toolCallId);
    }
  }

  renderMcpToolCallBlock(container, label, value) {
    const block = container.createEl("details", { cls: "codriver-mcp-call-block" });
    block.createEl("summary", { cls: "codriver-mcp-call-block-summary", text: label });
    block.createEl("pre", { cls: "codriver-mcp-call-code", text: value || "(empty)" });
  }

  renderAudioTranscriptionReview(container, toolCall) {
    const review = toolCall.audioTranscriptionReview;
    if (!review) {
      return;
    }
    const panel = container.createDiv({ cls: "codriver-mcp-mutation-summary" });
    panel.createDiv({ cls: "codriver-mcp-mutation-label", text: "External audio transcription" });
    panel.createDiv({
      cls: "codriver-mcp-mutation-path",
      text: review.path || "(missing audio path)"
    });
    panel.createDiv({
      cls: "codriver-mcp-mutation-note",
      text: `Size: ${review.size} bytes. Model: ${review.model || "Unknown model"}.`
    });
    panel.createDiv({
      cls: "codriver-mcp-mutation-note",
      text: `Destination: ${review.providerName || "Unknown provider"} (${review.endpoint || "unknown endpoint"}).`
    });
    panel.createDiv({
      cls: "codriver-mcp-mutation-note",
      text: review.authenticationPath
        ? `Authentication: Obsidian Secret Storage entry ${review.authenticationPath}.`
        : "Authentication: no provider secret is configured."
    });
    panel.createDiv({
      cls: "codriver-mcp-mutation-note",
      text: "This sends the requested audio file outside the vault. The transcript is request-scoped and read-only."
    });
  }

  renderMcpMutationSummary(container, toolCall) {
    if (toolCall?.toolName !== CODRIVER_VAULT_MOVE_FILE_TOOL_NAME) {
      return;
    }

    const review = toolCall.moveFileReview ?? {};
    const sourcePath = String(review.sourcePath ?? toolCall.arguments?.sourcePath ?? "").trim() || "(missing source path)";
    const destinationPath = String(review.destinationPath ?? toolCall.arguments?.destinationPath ?? "").trim() || "(missing destination path)";
    const summary = container.createDiv({ cls: "codriver-mcp-mutation-summary" });
    summary.createDiv({ cls: "codriver-mcp-mutation-label", text: "Move or rename" });
    const pathRow = summary.createDiv({ cls: "codriver-mcp-mutation-path-row" });
    pathRow.createSpan({ cls: "codriver-mcp-mutation-path", text: sourcePath });
    pathRow.createSpan({ cls: "codriver-mcp-mutation-arrow", text: "\u2192" });
    pathRow.createSpan({ cls: "codriver-mcp-mutation-path", text: destinationPath });
    summary.createDiv({
      cls: "codriver-mcp-mutation-note",
      text: "Existing destinations are never overwritten. Internal link updates follow your Obsidian settings."
    });
    if (Array.isArray(review.missingParentFolders) && review.missingParentFolders.length > 0) {
      summary.createDiv({
        cls: "codriver-mcp-mutation-note",
        text: `Create folders: ${review.missingParentFolders.join(", ")}`
      });
      summary.createDiv({
        cls: "codriver-mcp-mutation-note",
        text: "Only empty folders created for this move are removed if execution fails."
      });
    }
    summary.createDiv({
      cls: "codriver-mcp-mutation-note",
      text: "After execution starts, CoDriver waits for Obsidian to report the final move state."
    });
  }

  renderMcpToolCallWritePreview(container, toolCall) {
    if (
      toolCall?.serverId !== CODRIVER_VAULT_SERVER_ID ||
      toolCall?.toolName !== CODRIVER_VAULT_APPEND_NOTE_TOOL_NAME
    ) {
      return;
    }

    const preview = container.createDiv({ cls: "codriver-mcp-write-preview" });
    preview.createDiv({ cls: "codriver-mcp-write-preview-title", text: "Append to end of note" });
    preview.createDiv({
      cls: "codriver-mcp-write-preview-path",
      text: typeof toolCall.arguments?.path === "string" ? toolCall.arguments.path : "(missing path)"
    });
    preview.createEl("pre", {
      cls: "codriver-mcp-call-code codriver-mcp-write-preview-content",
      text: typeof toolCall.arguments?.content === "string" ? toolCall.arguments.content : "(missing content)"
    });
  }

  renderCreateNoteReview(container, toolCall) {
    const review = toolCall.createNoteReview;
    const panel = container.createDiv({ cls: "codriver-create-note-review" });
    const target = panel.createDiv({ cls: "codriver-create-note-review-row" });
    target.createSpan({ cls: "codriver-create-note-review-label", text: "New note" });
    target.createEl("code", { cls: "codriver-create-note-review-path", text: review.path || "(missing path)" });

    if (Array.isArray(review.missingParentFolders) && review.missingParentFolders.length > 0) {
      const folders = panel.createDiv({ cls: "codriver-create-note-review-row" });
      folders.createSpan({ cls: "codriver-create-note-review-label", text: "Create folders" });
      folders.createSpan({
        cls: "codriver-create-note-review-value",
        text: review.missingParentFolders.join(", ")
      });
    }

    const content = panel.createEl("details", { cls: "codriver-mcp-call-block codriver-create-note-review-content" });
    content.open = review.contentUnavailable !== true && (
      toolCall.status === "pending" || toolCall.status === "queued" || toolCall.status === "running"
    );
    content.createEl("summary", {
      cls: "codriver-mcp-call-block-summary",
      text: `Content (${review.characterCount ?? 0} characters)`
    });
    content.createEl("pre", {
      cls: "codriver-mcp-call-code",
      text: review.contentUnavailable === true
        ? "Content is unavailable after session restore. Prepare the create-note request again."
        : (review.content || "(empty note)")
    });
  }

  renderDeleteNoteReview(container, toolCall) {
    const review = toolCall.deleteNoteReview ?? {};
    const path = review.path || toolCall.arguments?.path || "(missing path)";
    const panel = container.createDiv({ cls: "codriver-delete-note-review" });
    panel.createDiv({ cls: "codriver-delete-note-review-title", text: "Moves to vault trash" });
    panel.createEl("code", { cls: "codriver-delete-note-review-path", text: path });

    const metadata = [];
    if (Number.isFinite(review.size)) {
      metadata.push(formatBytes(review.size));
    }
    if (Number.isFinite(review.mtime)) {
      metadata.push(`Modified ${new Date(review.mtime).toLocaleString()}`);
    }
    if (metadata.length > 0) {
      panel.createDiv({ cls: "codriver-delete-note-review-metadata", text: metadata.join(" - ") });
    }

    const recovery = toolCall.deleteRecovery;
    const warningText = recovery?.status === "restored"
      ? "This note was restored to its original path. Existing links were not rewritten."
      : toolCall.status === "complete" && recovery?.status === "available"
        ? "The note is in local vault trash. Existing links were not rewritten. Use Restore note to return the unchanged trash item to its original path."
        : toolCall.status === "complete" && recovery?.status === "unavailable"
          ? "The note is in local vault trash, but CoDriver could not identify an exact recovery item. Restore it manually from the vault trash."
          : "This removes the note from the vault. Existing links are not rewritten and may become unresolved. If CoDriver identifies the exact local trash item, this card will offer a Restore note action.";
    panel.createDiv({
      cls: "codriver-delete-note-review-warning",
      text: warningText
    });

    if (recovery) {
      const recoveryState = panel.createDiv({ cls: "codriver-delete-note-recovery" });
      recoveryState.createSpan({
        cls: "codriver-delete-note-recovery-status",
        text: getDeleteRecoveryStatusLabel(recovery.status)
      });
      if (recovery.trashPath) {
        recoveryState.createEl("code", {
          cls: "codriver-delete-note-recovery-path",
          text: recovery.trashPath
        });
      }
      if (recovery.error) {
        recoveryState.createDiv({
          cls: "codriver-delete-note-recovery-error",
          text: recovery.error
        });
      }
    }
  }

  renderMcpToolCallCardActions(card, toolCall) {
    const actions = card.createDiv({ cls: "codriver-approval-card-actions codriver-message-actions" });
    actions.createSpan({ cls: "codriver-chat-message-time", text: toolCall.time ?? "" });

    if (
      toolCall.status === "running" &&
      toolCall.toolName !== CODRIVER_VAULT_MOVE_FILE_TOOL_NAME
    ) {
      const cancelButton = actions.createEl("button", {
        cls: "codriver-message-action-button",
        attr: {
          title: "Cancel tool call"
        }
      });
      setIcon(cancelButton, "square");
      cancelButton.addEventListener("click", (event) => {
        event.stopPropagation();
        const result = this.chatController.cancelMcpToolCall(toolCall.id);
        new Notice(result.message);
        this.render();
      });
    }

    if (toolCall.status !== "output-review" &&
      !(toolCall.status === "running" && toolCall.toolName === CODRIVER_VAULT_MOVE_FILE_TOOL_NAME)) {
      const deleteButton = actions.createEl("button", {
        cls: "codriver-message-action-button",
        attr: {
          title: "Delete tool call"
        }
      });
      setIcon(deleteButton, "trash-2");
      deleteButton.addEventListener("click", (event) => {
        event.stopPropagation();
        this.clearMcpToolCallCollapseState(toolCall.id);
        const result = this.chatController.deleteMcpToolCall(toolCall.id);
        if (result?.ok === false && result.message) new Notice(result.message);
        this.render();
      });
    }
  }

  isRichComposerInput(input) {
    return input?.getAttribute?.("contenteditable") === "true" || input?.attributes?.contenteditable === "true";
  }

  getComposerValue(input) {
    if (!input) return "";
    return this.isRichComposerInput(input)
      ? String(input.innerText ?? input.textContent ?? "")
      : String(input.value ?? "");
  }

  setComposerValue(input, value) {
    if (this.isRichComposerInput(input)) input.textContent = String(value ?? "");
    else input.value = String(value ?? "");
  }

  getComposerSelection(input) {
    const value = this.getComposerValue(input);
    if (!this.isRichComposerInput(input)) {
      const start = Number.isInteger(input?.selectionStart) ? input.selectionStart : value.length;
      const end = Number.isInteger(input?.selectionEnd) ? input.selectionEnd : start;
      return { start, end };
    }
    const selection = typeof window !== "undefined" ? window.getSelection?.() : null;
    if (!selection?.rangeCount || !input.contains?.(selection.anchorNode) || !input.contains?.(selection.focusNode)) {
      return { start: value.length, end: value.length };
    }
    const offsetFor = (node, offset) => {
      const range = document.createRange();
      range.selectNodeContents(input);
      range.setEnd(node, offset);
      return range.toString().length;
    };
    const anchor = offsetFor(selection.anchorNode, selection.anchorOffset);
    const focus = offsetFor(selection.focusNode, selection.focusOffset);
    return { start: Math.min(anchor, focus), end: Math.max(anchor, focus) };
  }

  setComposerSelection(input, start, end = start) {
    if (!this.isRichComposerInput(input)) {
      input.setSelectionRange?.(start, end);
      return;
    }
    if (typeof document === "undefined" || typeof window === "undefined") return;
    const selection = window.getSelection?.();
    if (!selection) return;
    const textNodes = [];
    const walker = document.createTreeWalker(input, 4);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) textNodes.push(node);
    const locate = (target) => {
      let consumed = 0;
      for (let index = 0; index < textNodes.length; index += 1) {
        const node = textNodes[index];
        const length = node.textContent?.length ?? 0;
        if (target < consumed + length) return { node, offset: Math.max(0, target - consumed) };
        if (target === consumed + length) {
          const nextNode = textNodes[index + 1];
          return nextNode ? { node: nextNode, offset: 0 } : { node, offset: length };
        }
        consumed += length;
      }
      const node = textNodes.at(-1) ?? input;
      return { node, offset: node === input ? input.childNodes.length : (node.textContent?.length ?? 0) };
    };
    const from = locate(start);
    const to = locate(end);
    const range = document.createRange();
    range.setStart(from.node, from.offset);
    range.setEnd(to.node, to.offset);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  handleAtomicCommandKeydown(event, input) {
    if (!this.draftCommandId || (event.key !== "Backspace" && event.key !== "Delete")) return false;
    const command = (this.chatController.getCommandChoices?.() ?? []).find((item) => item.id === this.draftCommandId);
    const value = this.getComposerValue(input);
    const token = command ? findCommandTokenRange(value, command.name) : null;
    if (!token) return false;
    const selection = this.getComposerSelection(input);
    const overlaps = selection.start < token.end && selection.end > token.start;
    const backspaceAdjacent = event.key === "Backspace" && selection.start === selection.end && (
      selection.start === token.end ||
      (selection.start === token.end + 1 && /\s/.test(value[token.end] ?? ""))
    );
    const deleteAdjacent = event.key === "Delete" && selection.start === selection.end && (
      selection.start === token.start ||
      (selection.start === token.start - 1 && /\s/.test(value[token.start - 1] ?? ""))
    );
    if (!overlaps && !backspaceAdjacent && !deleteAdjacent) return false;

    event.preventDefault();
    let removeStart = overlaps ? Math.min(selection.start, token.start) : token.start;
    let removeEnd = overlaps ? Math.max(selection.end, token.end) : token.end;
    if (backspaceAdjacent && selection.start === token.end + 1) removeEnd += 1;
    if (deleteAdjacent && selection.start === token.start - 1) removeStart -= 1;
    const before = value.slice(0, removeStart);
    let after = value.slice(removeEnd);
    if (/\s$/.test(before) && /^\s/.test(after)) after = after.slice(1);
    const nextValue = `${before}${after}`;
    this.setComposerValue(input, nextValue);
    this.draftMessage = nextValue;
    this.draftCommandId = "";
    this.draftSelectionStart = removeStart;
    this.draftSelectionEnd = removeStart;
    this.commandMenuOpen = false;
    this.focusCommandInputAfterRender = true;
    this.render();
    return true;
  }

  renderComposer(root) {
    const composer = root.createDiv({ cls: "codriver-chat-composer" });

    this.renderActiveSkills(composer);

    const suggestions = composer.createDiv({ cls: "codriver-skill-suggestions is-hidden" });
    const inputShell = composer.createDiv({ cls: "codriver-chat-input-shell" });
    this.renderDraftAttachments(inputShell);
    const selectedCommand = (this.chatController.getCommandChoices?.() ?? [])
      .find((command) => command.id === this.draftCommandId);
    const selectedRange = selectedCommand
      ? findCommandTokenRange(this.draftMessage, selectedCommand.name)
      : null;
    if (this.draftCommandId && !selectedRange) this.draftCommandId = "";
    const input = selectedRange
      ? inputShell.createDiv({
          cls: "codriver-chat-input codriver-chat-input-rich",
          attr: {
            contenteditable: "true",
            role: "textbox",
            "aria-multiline": "true",
            "aria-label": "Message",
            "data-placeholder": "Ask CoDriver... (type / for skills or @ for commands)"
          }
        })
      : inputShell.createEl("textarea", {
          cls: "codriver-chat-input",
          attr: {
            placeholder: "Ask CoDriver... (type / for skills or @ for commands)"
          }
        });
    if (selectedRange) {
      input.createSpan({ text: this.draftMessage.slice(0, selectedRange.start) });
      input.createSpan({
        cls: "codriver-inline-command",
        text: this.draftMessage.slice(selectedRange.start, selectedRange.end),
        attr: {
          contenteditable: "false",
          title: `Command: ${selectedCommand.name}`,
          "aria-label": `Command ${selectedCommand.name}`
        }
      });
      input.createSpan({ text: this.draftMessage.slice(selectedRange.end) });
    } else {
      input.value = this.draftMessage;
    }
    this.messageInputEl = input;
    let sendButton = null;

    const submitDraft = async () => {
      const currentValue = this.getComposerValue(input);
      if (!this.chatController.canSendDraft(currentValue) && !this.draftCommandId) {
        return;
      }

      const draft = currentValue;
      const commandId = this.draftCommandId;
      const providerDraft = commandId ? this.getCommandUserText(draft, commandId) : draft;
      try {
        const sendPromise = this.chatController.sendMessage(providerDraft, { commandId });
        this.setComposerValue(input, "");
        this.draftMessage = "";
        this.draftCommandId = "";
        this.commandMenuOpen = false;
        suggestions.addClass("is-hidden");
        this.render();
        await sendPromise;
        this.render();
      } catch (error) {
        this.draftMessage = draft;
        this.draftCommandId = commandId;
        this.render();
        const message = error instanceof Error ? error.message : "CoDriver request failed.";
        new Notice(message);
      }
    };

    inputShell.addEventListener("dragover", (event) => this.handleFileDragOver(event, inputShell));
    inputShell.addEventListener("dragleave", (event) => this.handleFileDragLeave(event, inputShell));
    inputShell.addEventListener("drop", (event) => this.handleFileDrop(event, inputShell));

    input.addEventListener("input", () => {
      const currentValue = this.getComposerValue(input);
      this.draftMessage = currentValue;
      this.syncDraftCommandFromInput(currentValue);
      this.renderSkillSuggestions(suggestions, input);
      this.updateCommandMenuFromInput(input);
      this.renderCommandSuggestions(suggestions, input);
      if (sendButton && !this.chatController.isSending()) {
        sendButton.disabled = !this.chatController.canSendDraft(currentValue) && !this.draftCommandId;
      }
    });
    input.addEventListener("keydown", (event) => {
      if (this.handleAtomicCommandKeydown(event, input)) return;
      if (this.handleCommandSuggestionKeydown(event, suggestions, input)) return;
      if (event.key !== "Enter" || event.shiftKey || event.isComposing) {
        return;
      }

      event.preventDefault();
      void submitDraft();
    });
    this.renderCommandSuggestions(suggestions, input);
    if (this.focusCommandInputAfterRender) {
      this.focusCommandInputAfterRender = false;
      input.focus();
      const currentValue = this.getComposerValue(input);
      const start = Number.isInteger(this.draftSelectionStart) ? this.draftSelectionStart : currentValue.length;
      const end = Number.isInteger(this.draftSelectionEnd) ? this.draftSelectionEnd : start;
      this.setComposerSelection(input, start, end);
    }

    const actionRow = composer.createDiv({ cls: "codriver-composer-actions" });
    const modelControls = actionRow.createDiv({ cls: "codriver-model-controls" });
    const contextPicker = modelControls.createDiv({ cls: "codriver-context-picker" });
    const fileInput = contextPicker.createEl("input", {
      cls: "codriver-file-input",
      attr: {
        type: "file",
        multiple: "true"
      }
    });
    this.fileInputEl = fileInput;
    fileInput.addEventListener("change", () => {
      const files = Array.from(fileInput.files ?? []);
      fileInput.value = "";
      void this.attachFiles(files);
    });

    this.renderContextPicker(contextPicker, fileInput);
    const modelPicker = modelControls.createDiv({ cls: "codriver-model-picker" });
    const modelSelect = modelPicker.createEl("select", {
      cls: "codriver-bottom-model-select",
      attr: {
        "aria-label": "Select model"
      }
    });
    const modelChoices = this.chatController.getModelChoices();
    if (modelChoices.length === 0) {
      modelSelect.createEl("option", {
        text: "No visible models",
        value: ""
      });
    } else {
      for (const provider of modelChoices) {
        const group = modelSelect.createEl("optgroup", {
          attr: { label: provider.providerName }
        });
        for (const model of provider.models) {
          group.createEl("option", {
            text: model,
            value: encodeModelOptionValue(provider.providerId, model)
          });
        }
      }
    }

    const selectedProviderId = this.chatController.getSelectedProviderId();
    const selectedModelId = this.chatController.getSelectedModelId();
    modelSelect.value = encodeModelOptionValue(selectedProviderId, selectedModelId);
    const modelPickerButton = modelPicker.createEl("button", {
      cls: "codriver-model-picker-button",
      attr: {
        type: "button",
        tabindex: "-1",
        "aria-hidden": "true",
        title: selectedModelId ? `Model: ${selectedModelId}` : "Select model"
      }
    });
    setIcon(modelPickerButton, "bot");
    modelPicker.createDiv({
      cls: "codriver-selected-model-name",
      text: selectedModelId || "No model",
      attr: {
        title: selectedModelId || "No model selected"
      }
    });
    modelSelect.addEventListener("change", () => {
      this.draftMessage = this.getComposerValue(input);
      const selection = decodeModelOptionValue(modelSelect.value);
      void this.chatController.selectModel(selection.modelId, selection.providerId);
      this.render();
    });
    this.renderMcpServerPicker(modelControls);
    this.renderRequestInfoButton(modelControls);

    const trailingActions = actionRow.createDiv({ cls: "codriver-composer-trailing-actions" });
    this.renderSessionActionButton(trailingActions, "message-square-plus", "New session", async () => {
      const result = await this.chatController.startNewSession();
      new Notice(result.message);
      this.render();
    });
    this.renderSessionActionButton(trailingActions, "history", "Session history", async () => {
      await this.openSessionLoadModal();
    });

    sendButton = trailingActions.createEl("button", {
      cls: "codriver-send-button",
      attr: {
        type: "button",
        "aria-label": this.chatController.isSending() ? "Stop response" : "Send message",
        title: this.chatController.isSending() ? "Stop response" : "Send message"
      }
    });
    setIcon(sendButton, this.chatController.isSending() ? "square" : "send");
    sendButton.toggleClass("is-stopping", this.chatController.isSending());
    sendButton.disabled = !this.chatController.isSending() && !this.chatController.canSendDraft(this.getComposerValue(input)) && !this.draftCommandId;
    sendButton.addEventListener("click", () => {
      if (this.chatController.isSending()) {
        this.chatController.cancelActiveRequest();
        this.render();
        return;
      }

      void submitDraft();
    });
  }

  renderDraftAttachments(container) {
    const draftAttachments = this.chatController.getDraftAttachments();
    if (draftAttachments.length === 0) {
      return;
    }

    const list = container.createDiv({ cls: "codriver-draft-attachments" });
    for (const attachment of draftAttachments) {
      const card = list.createDiv({
        cls: `codriver-attachment-card codriver-draft-attachment-card codriver-attachment-card-${attachment.status}`
      });
      const icon = card.createDiv({ cls: "codriver-attachment-icon" });
      setIcon(icon, getAttachmentIcon(attachment));

      const body = card.createDiv({ cls: "codriver-attachment-body" });
      body.createDiv({ cls: "codriver-attachment-name", text: attachment.name });
      body.createDiv({ cls: "codriver-attachment-meta", text: formatAttachmentMeta(attachment) });

      const removeButton = card.createEl("button", {
        cls: "codriver-attachment-remove",
        attr: {
          title: "Remove file"
        }
      });
      setIcon(removeButton, "x");
      removeButton.addEventListener("click", (event) => {
        event.stopPropagation();
        this.chatController.deleteDraftAttachment(attachment.id);
        this.render();
      });
    }
  }

  renderContextPicker(container, fileInput) {
    const button = container.createEl("button", {
      cls: "codriver-context-picker-button",
      attr: {
        type: "button",
        "aria-label": "Add context",
        title: "Add context",
        "aria-expanded": this.contextPickerOpen ? "true" : "false"
      }
    });
    button.toggleClass("is-active", this.contextPickerOpen);
    setIcon(button, "plus");
    button.disabled = this.chatController.isSending();
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.contextPickerOpen = !this.contextPickerOpen;
      this.mcpServerPickerOpen = false;
      this.requestInfoOpen = false;
      this.render();
    });

    if (!this.contextPickerOpen) {
      return;
    }

    const menu = container.createDiv({
      cls: "codriver-context-picker-menu",
      attr: { role: "menu" }
    });
    const activeNoteState = this.chatController.getActiveNoteContextState();
    const activeNoteButton = menu.createEl("button", {
      cls: "codriver-context-picker-item",
      attr: {
        type: "button",
        role: "menuitem"
      }
    });
    setIcon(activeNoteButton, "file-text");
    activeNoteButton.createSpan({ text: "Active note" });
    activeNoteButton.disabled = this.chatController.isSending() || !activeNoteState.available;
    activeNoteButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (activeNoteButton.disabled) {
        return;
      }
      this.chatController.addActiveNoteContext();
      this.contextPickerOpen = false;
      this.render();
    });

    const commandsButton = menu.createEl("button", { cls: "codriver-context-picker-item", attr: { type: "button", role: "menuitem" } });
    setIcon(commandsButton, "at-sign");
    commandsButton.createSpan({ text: "Commands" });
    commandsButton.disabled = this.chatController.isSending() || (this.chatController.getCommandChoices?.() ?? []).length === 0 || Boolean(this.draftCommandId);
    commandsButton.addEventListener("click", (event) => {
      event.preventDefault(); event.stopPropagation();
      if (commandsButton.disabled) return;
      this.contextPickerOpen = false;
      this.commandMenuOpen = true;
      this.commandSuggestionIndex = 0;
      this.focusCommandInputAfterRender = true;
      this.render();
    });

    const filesButton = menu.createEl("button", {
      cls: "codriver-context-picker-item",
      attr: {
        type: "button",
        role: "menuitem"
      }
    });
    setIcon(filesButton, "paperclip");
    filesButton.createSpan({ text: "Files" });
    filesButton.disabled = this.chatController.isSending();
    filesButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (filesButton.disabled) {
        return;
      }
      this.contextPickerOpen = false;
      menu.remove();
      fileInput.click();
    });
  }

  async attachFiles(fileList) {
    if (!fileList || fileList.length === 0) {
      return;
    }

    try {
      const attachPromise = this.chatController.attachDraftFiles(fileList);
      this.render();
      const result = await attachPromise;
      if (result.message) {
        new Notice(result.message);
      }
      this.render();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to attach files.";
      new Notice(message);
      this.render();
    }
  }

  handleFileDragOver(event, target) {
    if (!hasDraggedFiles(event)) {
      return;
    }

    event.preventDefault();
    target.addClass("is-dragging-file");
  }

  handleFileDragLeave(event, target) {
    if (event.relatedTarget && target.contains(event.relatedTarget)) {
      return;
    }

    target.removeClass("is-dragging-file");
  }

  handleFileDrop(event, target) {
    if (!hasDraggedFiles(event)) {
      return;
    }

    event.preventDefault();
    target.removeClass("is-dragging-file");
    void this.attachFiles(Array.from(event.dataTransfer?.files ?? []));
  }

  renderSessionActionButton(container, icon, title, onClick) {
    const button = container.createEl("button", {
      cls: "codriver-session-action-button",
      attr: {
        type: "button",
        "aria-label": title,
        title
      }
    });
    setIcon(button, icon);
    button.disabled = this.chatController.isSending();
    button.addEventListener("click", (event) => {
      event.preventDefault();
      void onClick();
    });
  }

  renderMcpServerPicker(container) {
    const button = container.createEl("button", {
      cls: "codriver-mcp-server-picker-button",
      attr: {
        title: "Connect MCP servers"
      }
    });
    button.toggleClass("is-active", this.mcpServerPickerOpen);
    setIcon(button, "plug");
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.mcpServerPickerOpen = !this.mcpServerPickerOpen;
      this.contextPickerOpen = false;
      this.requestInfoOpen = false;
      this.render();
    });

    if (!this.mcpServerPickerOpen) {
      return;
    }

    const menu = container.createDiv({ cls: "codriver-mcp-server-picker-menu" });
    const servers = this.chatController.getMcpServerChoices();
    if (servers.length === 0) {
      menu.createDiv({ cls: "codriver-mcp-server-picker-empty", text: "No MCP servers configured." });
      return;
    }

    for (const server of servers) {
      const row = menu.createEl("label", { cls: "codriver-mcp-server-picker-row" });
      if (server.available === false) {
        row.addClass("is-disabled");
      }
      const checkbox = row.createEl("input", {
        attr: {
          type: "checkbox"
        }
      });
      checkbox.checked = server.manuallyAttached === true;
      checkbox.disabled = server.available === false;
      checkbox.addEventListener("change", async (event) => {
        event.stopPropagation();
        this.mcpServerPickerOpen = true;
        const result = await this.chatController.setMcpServerManualAttachment(server.id, checkbox.checked);
        if (!result.ok) {
          new Notice(result.message);
        }
        this.render();
      });

      const body = row.createSpan({ cls: "codriver-mcp-server-picker-body" });
      body.createSpan({ cls: "codriver-mcp-server-picker-name", text: server.name });
      body.createSpan({
        cls: "codriver-mcp-server-picker-meta",
        text: server.available === false && server.disabledReason
          ? `${server.transport || "mcp"} - unavailable`
          : `${server.transport || "mcp"} - ${server.toolCount} tool(s)${server.skillRequired ? " - required by skill" : ""}`
      });
      if (server.available === false && server.disabledReason) {
        body.createSpan({
          cls: "codriver-mcp-server-picker-reason",
          text: server.disabledReason
        });
      }
    }
  }

  renderRequestInfoButton(container) {
    const button = container.createEl("button", {
      cls: "codriver-request-info-button",
      attr: {
        title: "Request info"
      }
    });
    button.toggleClass("is-active", this.requestInfoOpen);
    setIcon(button, "info");
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.requestInfoOpen = !this.requestInfoOpen;
      this.contextPickerOpen = false;
      this.mcpServerPickerOpen = false;
      this.render();
    });

    if (!this.requestInfoOpen) {
      return;
    }

    const info = this.chatController.getRequestInfo();
    const panel = container.createDiv({ cls: "codriver-request-info-panel" });

    const contextSection = panel.createDiv({ cls: "codriver-request-info-section" });
    const contextDetails = contextSection.createEl("details", {
      cls: "codriver-request-info-context-details"
    });
    contextDetails.open = false;
    contextDetails.addEventListener("click", (event) => event.stopPropagation());
    const contextSummary = contextDetails.createEl("summary", {
      cls: "codriver-request-info-section-title codriver-request-info-context-summary"
    });
    const contextHeading = contextSummary.createSpan({ cls: "codriver-request-info-context-heading" });
    contextHeading.createSpan({
      cls: "codriver-request-info-context-disclosure",
      attr: { "aria-hidden": "true" }
    });
    contextHeading.createSpan({ text: "Sent context" });
    contextSummary.createSpan({
      cls: "codriver-request-info-context-tokens",
      text: `~${formatNumber(info.context?.estimatedTokens)} tokens`
    });

    const contextRows = contextDetails.createDiv({ cls: "codriver-request-info-rows" });
    for (const section of info.context?.sections ?? []) {
      this.renderRequestInfoRow(
        contextRows,
        section.label,
        `${formatNumber(section.characters)} chars / ~${formatNumber(section.estimatedTokens)} tokens`
      );
    }

    const tokenSection = panel.createDiv({ cls: "codriver-request-info-section" });
    tokenSection.createDiv({ cls: "codriver-request-info-section-title", text: "Chat provider usage" });
    const tokenRows = tokenSection.createDiv({ cls: "codriver-request-info-rows" });
    const incompleteTokens = info.tokens?.incomplete === true;
    this.renderRequestInfoRow(tokenRows, "Provider calls", formatNumber(info.providerCallCount));
    this.renderRequestInfoRow(tokenRows, "Input", formatTokenValue(info.tokens?.input, info.tokens?.estimatedInput, incompleteTokens));
    this.renderRequestInfoRow(tokenRows, "Output", formatTokenValue(info.tokens?.output, null, incompleteTokens));
    if (Number.isFinite(info.tokens?.reasoning)) {
      this.renderRequestInfoRow(tokenRows, "Reasoning", formatTokenValue(info.tokens.reasoning, null, incompleteTokens));
    }
    if (Number.isFinite(info.tokens?.cached)) {
      this.renderRequestInfoRow(tokenRows, "Cached", formatTokenValue(info.tokens.cached, null, incompleteTokens));
    }
    if (Number.isFinite(info.tokens?.cacheCreation)) {
      this.renderRequestInfoRow(tokenRows, "Cache write", formatTokenValue(info.tokens.cacheCreation, null, incompleteTokens));
    }
    if (Number.isFinite(info.tokens?.cacheRead)) {
      this.renderRequestInfoRow(tokenRows, "Cache read", formatTokenValue(info.tokens.cacheRead, null, incompleteTokens));
    }
    if (Number.isFinite(info.tokens?.cacheCreation5m)) {
      this.renderRequestInfoRow(tokenRows, "Cache write (5m)", formatTokenValue(info.tokens.cacheCreation5m, null, incompleteTokens));
    }
    if (Number.isFinite(info.tokens?.cacheCreation1h)) {
      this.renderRequestInfoRow(tokenRows, "Cache write (1h)", formatTokenValue(info.tokens.cacheCreation1h, null, incompleteTokens));
    }
    if (Number.isFinite(info.tokens?.toolUsePrompt)) {
      this.renderRequestInfoRow(tokenRows, "Tool prompt", formatTokenValue(info.tokens.toolUsePrompt, null, incompleteTokens));
    }

    const transcription = info.transcription ?? {};
    if (Number.isFinite(transcription.callCount) && transcription.callCount > 0) {
      const transcriptionSection = panel.createDiv({ cls: "codriver-request-info-section" });
      transcriptionSection.createDiv({ cls: "codriver-request-info-section-title", text: "Audio attachment processing" });
      const transcriptionRows = transcriptionSection.createDiv({ cls: "codriver-request-info-rows" });
      this.renderRequestInfoRow(transcriptionRows, "Calls", formatNumber(transcription.callCount));
      if (transcription.provider?.name) {
        this.renderRequestInfoRow(transcriptionRows, "Provider", transcription.provider.name);
      }
      const hasTranscriptionTokens = [
        transcription.tokens?.input,
        transcription.tokens?.audioInput,
        transcription.tokens?.textInput,
        transcription.tokens?.output,
        transcription.tokens?.total
      ].some(Number.isFinite);
      if (hasTranscriptionTokens) {
        this.renderRequestInfoRow(transcriptionRows, "Input", formatReportedUsage(transcription.tokens?.input, transcription.incomplete));
        if (Number.isFinite(transcription.tokens?.audioInput)) {
          this.renderRequestInfoRow(transcriptionRows, "Audio input", formatReportedUsage(transcription.tokens.audioInput, transcription.incomplete));
        }
        if (Number.isFinite(transcription.tokens?.textInput)) {
          this.renderRequestInfoRow(transcriptionRows, "Text input", formatReportedUsage(transcription.tokens.textInput, transcription.incomplete));
        }
        this.renderRequestInfoRow(transcriptionRows, "Output", formatReportedUsage(transcription.tokens?.output, transcription.incomplete));
        this.renderRequestInfoRow(transcriptionRows, "Total", formatReportedUsage(transcription.tokens?.total, transcription.incomplete));
      } else if (Number.isFinite(transcription.billedSeconds)) {
        this.renderRequestInfoRow(
          transcriptionRows,
          "Billed duration",
          `${formatNumber(transcription.billedSeconds)} sec${transcription.incomplete ? " (incomplete)" : ""}`
        );
      } else {
        this.renderRequestInfoRow(transcriptionRows, "Usage", "Not reported");
      }
    }

    const contextWarning = info.contextWarning ?? {};
    if (contextWarning.outcome) {
      const warningSection = panel.createDiv({ cls: "codriver-request-info-section" });
      warningSection.createDiv({ cls: "codriver-request-info-section-title", text: "Context size warning" });
      const warningRows = warningSection.createDiv({ cls: "codriver-request-info-rows" });
      this.renderRequestInfoRow(warningRows, "Outcome", formatContextWarningOutcome(contextWarning.outcome));
      this.renderRequestInfoRow(
        warningRows,
        "Current call",
        `${formatNumber(contextWarning.currentCharacters)} chars / ~${formatNumber(contextWarning.estimatedTokens)} tokens`
      );
      this.renderRequestInfoRow(
        warningRows,
        "Maximum",
        `${formatNumber(contextWarning.maximumCharacters)} chars / ~${formatNumber(contextWarning.maximumTokens)} tokens`
      );
    }

    this.renderRequestContextBudgetControl(panel);
  }

  renderRequestInfoRow(container, label, value) {
    const row = container.createDiv({ cls: "codriver-request-info-row" });
    row.createSpan({ cls: "codriver-request-info-row-label", text: label });
    row.createSpan({ cls: "codriver-request-info-row-value", text: value });
  }

  renderRequestContextBudgetControl(panel) {
    if (typeof this.chatController.getRequestContextBudget !== "function") {
      return;
    }

    const budget = this.chatController.getRequestContextBudget();
    const section = panel.createDiv({ cls: "codriver-request-info-section codriver-request-info-budget-section" });
    section.createDiv({ cls: "codriver-request-info-section-title", text: "Maximum context size" });
    const value = section.createDiv({
      cls: "codriver-request-info-budget-value",
      text: formatContextBudgetValue(budget.maximumCharacters)
    });
    const slider = section.createEl("input", {
      cls: "codriver-request-info-budget-slider",
      attr: {
        type: "range",
        min: "0",
        max: String(budget.maxCharacters),
        step: String(budget.stepCharacters),
        value: String(budget.maximumCharacters),
        "aria-label": "Maximum context size"
      }
    });
    slider.value = String(budget.maximumCharacters);
    slider.addEventListener("input", () => {
      value.textContent = formatContextBudgetValue(Number(slider.value));
    });
    slider.addEventListener("change", async () => {
      const nextBudget = await this.chatController.setMaxRequestContextChars(Number(slider.value));
      slider.value = String(nextBudget.maximumCharacters);
      value.textContent = formatContextBudgetValue(nextBudget.maximumCharacters);
    });
  }

  async openSessionLoadModal() {
    try {
      const sessions = await this.chatController.listSavedSessions();
      if (sessions.length === 0) {
        new Notice("No saved CoDriver sessions found.");
        return;
      }

      new SessionLoadModal(this.app, sessions, async (session) => {
        const result = await this.chatController.loadSavedSession(session.path);
        new Notice(result.message);
        this.render();
      }).open();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to load sessions.";
      new Notice(message);
    }
  }

  renderSkillSuggestions(container, input) {
    container.empty();
    const value = this.getComposerValue(input);
    const matches = this.chatController.handleDraftInput(value);

    if (!value.startsWith("/") || matches.length === 0) {
      container.addClass("is-hidden");
      return;
    }

    container.removeClass("is-hidden");
    for (const skill of matches) {
      const activationLabel = this.chatController.getSkillActivationLabel(skill.id);
      const option = container.createDiv({
        cls: `codriver-skill-suggestion ${activationLabel ? "is-active" : ""}`
      });
      const header = option.createDiv({ cls: "codriver-skill-suggestion-header" });
      header.createDiv({ cls: "codriver-skill-suggestion-name", text: skill.name });
      if (activationLabel) {
        header.createDiv({ cls: "codriver-skill-suggestion-status", text: activationLabel });
      }
      option.createDiv({ cls: "codriver-skill-suggestion-description", text: skill.description });
      option.addEventListener("click", async () => {
        if (skill.requiresInput && skill.command) {
          this.setComposerValue(input, `/${skill.command} `);
          input.focus();
          container.addClass("is-hidden");
          return;
        }

        const result = await this.chatController.selectSkill(skill.id);
        if (result?.ok === false && result.message) {
          new Notice(result.message);
        }
        this.setComposerValue(input, "");
        this.render();
      });
    }
  }

  updateCommandMenuFromInput(input) {
    if (this.draftCommandId) { this.commandMenuOpen = false; return; }
    const trigger = this.getCommandTrigger(input);
    this.commandMenuOpen = Boolean(trigger);
    if (!trigger) this.commandSuggestionIndex = 0;
  }

  getCommandQuery(input) {
    return this.getCommandTrigger(input)?.query ?? "";
  }

  getCommandTrigger(input) {
    const value = String(input.value ?? "");
    const cursor = Number.isInteger(input.selectionStart) ? input.selectionStart : value.length;
    const match = value.slice(0, cursor).match(/(?:^|\s)@([a-z0-9-]*)$/i);
    if (!match) return null;
    return { query: match[1], start: cursor - match[1].length - 1, end: cursor };
  }

  renderCommandSuggestions(container, input) {
    if (!this.commandMenuOpen || this.draftCommandId) return;
    container.empty();
    const commands = this.chatController.getCommandChoices?.(this.getCommandQuery(input)) ?? [];
    if (!commands.length) { container.addClass("is-hidden"); return; }
    this.commandSuggestionIndex = Math.min(this.commandSuggestionIndex, commands.length - 1);
    container.removeClass("is-hidden");
    container.setAttribute?.("role", "listbox");
    commands.forEach((command, index) => {
      const option = container.createDiv({ cls: `codriver-skill-suggestion codriver-command-suggestion ${index === this.commandSuggestionIndex ? "is-selected" : ""}`, attr: { role: "option", "aria-selected": index === this.commandSuggestionIndex ? "true" : "false" } });
      option.createDiv({ cls: "codriver-skill-suggestion-name", text: `@${command.name}` });
      option.createDiv({ cls: "codriver-skill-suggestion-description", text: command.description });
      option.addEventListener("click", () => this.selectDraftCommand(command, input, container));
    });
  }

  selectDraftCommand(command, input, container) {
    const value = String(input.value ?? "");
    const trigger = this.getCommandTrigger(input);
    const selectionStart = Number.isInteger(input.selectionStart) ? input.selectionStart : value.length;
    const selectionEnd = Number.isInteger(input.selectionEnd) ? input.selectionEnd : selectionStart;
    const start = trigger?.start ?? selectionStart;
    const end = trigger?.end ?? selectionEnd;
    const before = value.slice(0, start);
    const after = value.slice(end);
    const leading = before && !/\s$/.test(before) ? " " : "";
    const trailing = !after || !/^\s/.test(after) ? " " : "";
    const inserted = `${leading}@${command.name}${trailing}`;
    input.value = `${before}${inserted}${after}`;
    const nextCursor = before.length + inserted.length;
    input.setSelectionRange?.(nextCursor, nextCursor);
    this.draftMessage = input.value;
    this.draftCommandId = command.id;
    this.draftSelectionStart = nextCursor;
    this.draftSelectionEnd = this.draftSelectionStart;
    this.commandMenuOpen = false;
    container.addClass("is-hidden");
    this.focusCommandInputAfterRender = true;
    this.render();
  }

  syncDraftCommandFromInput(value) {
    if (!this.draftCommandId) return;
    const command = (this.chatController.getCommandChoices?.() ?? []).find((item) => item.id === this.draftCommandId);
    if (!command || !findCommandTokenRange(value, command.name)) this.draftCommandId = "";
  }

  getCommandUserText(value, commandId) {
    const command = (this.chatController.getCommandChoices?.() ?? []).find((item) => item.id === commandId);
    const range = command ? findCommandTokenRange(value, command.name) : null;
    if (!range) return String(value ?? "").trim();
    const text = String(value ?? "");
    const before = text.slice(0, range.start);
    let after = text.slice(range.end);
    if (/\s$/.test(before) && /^\s/.test(after)) after = after.slice(1);
    return `${before}${after}`.trim();
  }

  handleCommandSuggestionKeydown(event, container, input) {
    if (!this.commandMenuOpen || this.draftCommandId) return false;
    const commands = this.chatController.getCommandChoices?.(this.getCommandQuery(input)) ?? [];
    if (!commands.length) return false;
    if (event.key === "Escape") { event.preventDefault(); this.commandMenuOpen = false; container.addClass("is-hidden"); return true; }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      this.commandSuggestionIndex = (this.commandSuggestionIndex + delta + commands.length) % commands.length;
      this.renderCommandSuggestions(container, input);
      return true;
    }
    if (event.key === "Enter" || event.key === "Tab") { event.preventDefault(); this.selectDraftCommand(commands[this.commandSuggestionIndex], input, container); return true; }
    return false;
  }

  renderContextLeadingSwap(chip, {
    contentClass = "",
    contentText = "",
    iconName = "",
    leadingClass = "",
    onRemove,
    removeClass = "",
    removeLabel
  }) {
    chip.addClass("codriver-removable-context");
    const leading = chip.createSpan({
      cls: `${leadingClass} codriver-context-leading`.trim()
    });
    const removeButton = leading.createEl("button", {
      cls: `${removeClass} codriver-context-leading-remove`.trim(),
      attr: {
        type: "button",
        title: removeLabel,
        "aria-label": removeLabel
      }
    });
    setIcon(removeButton, "x");
    removeButton.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      await onRemove();
      this.render();
    });

    const contentOptions = {
      cls: `${contentClass} codriver-context-leading-content`.trim()
    };
    if (contentText) {
      contentOptions.text = contentText;
    }
    if (iconName) {
      contentOptions.attr = { "aria-hidden": "true" };
    }
    const content = leading.createSpan(contentOptions);
    if (iconName) {
      setIcon(content, iconName);
    }

    return leading;
  }

  renderActiveSkills(root) {
    const activeNote = this.chatController.getActiveNoteContextState();
    const skills = this.chatController.getVisibleSkillContexts();
    const mcpServers = this.chatController.getVisibleMcpServerContexts();
    if (!activeNote.enabled && skills.length === 0 && mcpServers.length === 0) {
      return;
    }

    const row = root.createDiv({ cls: "codriver-active-skills" });
    if (activeNote.enabled) {
      const chip = row.createDiv({
        cls: "codriver-active-skill codriver-active-skill-context codriver-active-note-context",
        attr: {
          title: activeNote.path,
          "aria-label": `${activeNote.name} (current)`
        }
      });
      this.renderContextLeadingSwap(chip, {
        contentClass: "codriver-active-note-icon",
        iconName: "file-text",
        leadingClass: "codriver-active-note-leading",
        onRemove: () => this.chatController.removeActiveNoteContext(),
        removeClass: "codriver-active-note-remove",
        removeLabel: `Remove ${activeNote.name} from context`
      });
      chip.createSpan({ cls: "codriver-active-skill-name", text: activeNote.name });
      chip.createSpan({ cls: "codriver-active-note-current", text: "(current)" });
    }

    for (const skill of skills) {
      const chip = row.createDiv({ cls: `codriver-active-skill codriver-active-skill-${skill.source.toLowerCase()}` });
      if (skill.removable) {
        this.renderContextLeadingSwap(chip, {
          contentClass: "codriver-active-skill-source",
          contentText: skill.source,
          onRemove: () => this.chatController.deactivateSkill(skill.id),
          removeClass: "codriver-active-skill-remove",
          removeLabel: `Deactivate ${skill.name}`
        });
      } else {
        chip.createSpan({ cls: "codriver-active-skill-source", text: skill.source });
      }
      chip.createSpan({ cls: "codriver-active-skill-name", text: skill.name });

      if (skill.dependencyError) {
        const warning = chip.createSpan({
          cls: "codriver-active-skill-warning",
          attr: {
            title: skill.dependencyMessage || "Skill dependency unavailable",
            "aria-label": skill.dependencyMessage || "Skill dependency unavailable"
          }
        });
        setIcon(warning, "triangle-alert");
      }
    }

    for (const server of mcpServers) {
      const chip = row.createDiv({ cls: "codriver-active-skill codriver-active-skill-mcp" });
      if (server.removable) {
        this.renderContextLeadingSwap(chip, {
          contentClass: "codriver-active-skill-source",
          contentText: server.source,
          onRemove: async () => {
            const result = await this.chatController.setMcpServerManualAttachment(server.id, false);
            if (!result.ok || result.stillRequired) {
              new Notice(result.message);
            }
          },
          removeClass: "codriver-active-skill-remove",
          removeLabel: `Disconnect ${server.name}`
        });
      } else {
        chip.createSpan({ cls: "codriver-active-skill-source", text: server.source });
      }
      chip.createSpan({ cls: "codriver-active-skill-name", text: server.name });

      if (server.skillRequired) {
        const skillNames = Array.isArray(server.requiredBySkillNames)
          ? server.requiredBySkillNames.filter(Boolean)
          : [];
        chip.createSpan({
          cls: "codriver-active-skill-requirement",
          text: "Skill",
          attr: {
            title: skillNames.length > 0
              ? `Required by ${skillNames.join(", ")}`
              : "Required by an active skill"
          }
        });
      }
    }
  }
}

function createChatTimelineRenderer(host, chatController, diagnostics = null, onRender = null, lifecycle = host) {
  const renderer = Object.create(ChatView.prototype);
  initializeChatSurface(renderer, chatController, diagnostics);
  renderer.app = host.app;
  renderer.containerEl = host.containerEl;
  renderer.contentEl = host.contentEl;
  renderer.render = typeof onRender === "function" ? onRender : () => {};
  for (const method of ["addChild", "register", "registerDomEvent", "registerEvent", "registerInterval"]) {
    if (typeof lifecycle?.[method] === "function") renderer[method] = lifecycle[method].bind(lifecycle);
  }
  return renderer;
}

function disposeChatTimelineRenderer(renderer) {
  renderer?.clearAllMcpToolCallCollapseTimers?.();
  renderer?.clearReasoningScrollFrames?.();
  renderer?.clearThinkingShimmerProbeTimers?.();
  renderer?.proposalNoteContentCache?.clear?.();
  renderer?.reasoningDisclosureState?.clear?.();
  renderer?.reasoningFinalCollapseApplied?.clear?.();
  renderer?.reasoningScrollState?.clear?.();
  renderer?.reasoningScrollTargets?.clear?.();
  renderer?.messageRenderState?.clear?.();
  renderer?.pendingProviderProgressMessageIds?.clear?.();
}

module.exports = {
  ChatView,
  createChatTimelineRenderer,
  decodeModelOptionValue,
  disposeChatTimelineRenderer,
  encodeModelOptionValue
};

function encodeModelOptionValue(providerId, modelId) {
  if (!providerId || !modelId) {
    return "";
  }

  return JSON.stringify([providerId, modelId]);
}

function decodeModelOptionValue(value) {
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.length >= 2) {
      return {
        providerId: typeof parsed[0] === "string" ? parsed[0] : "",
        modelId: typeof parsed[1] === "string" ? parsed[1] : ""
      };
    }
  } catch {
    // Keep malformed UI values harmless.
  }

  return {
    providerId: "",
    modelId: ""
  };
}

function getProposalTitle(proposal) {
  if (proposal.applicationState === "applying") return "Applying note update";
  if (proposal.applicationState === "unavailable" && proposal.status === "accepted") return "Application state unavailable";
  if (proposal.status === "pending") {
    if (proposal.kind === "frontmatter") {
      return "Proposed frontmatter update";
    }

    return "Proposed note update";
  }

  if (proposal.status === "accepted") {
    if (proposal.applicationAuthorizationSource === "automatic-tool-permission") {
      return "Applied automatically";
    }

    return proposal.applicationState === "applied" ? "Applied" : "Accepted";
  }

  if (proposal.status === "rolled-back") {
    return "Rolled back";
  }

  if (proposal.status === "rejected") {
    return "Rejected";
  }

  return "Proposed note update";
}

function isTextProposal(proposal) {
  return proposal?.kind !== "frontmatter";
}

function getProposalBeforeLabel(proposal) {
  return proposal.kind === "frontmatter" ? "Current frontmatter" : "Current";
}

function getProposalAfterLabel(proposal) {
  return proposal.kind === "frontmatter" ? "Proposed frontmatter" : "Proposed";
}

function formatProposalValue(value) {
  if (typeof value === "string") {
    return value;
  }

  return JSON.stringify(value, null, 2);
}

function hasProposalTextChanges(proposal) {
  return getProposalTextChanges(proposal).length > 0;
}

function getProposalTextChanges(proposal) {
  if (!Array.isArray(proposal.changes)) {
    return [];
  }

  return proposal.changes
    .map((change) => {
      if (!change || typeof change.before !== "string" || typeof change.after !== "string") {
        return null;
      }

      return {
        before: change.before,
        after: change.after,
        contextBefore: typeof change.contextBefore === "string" ? change.contextBefore : "",
        contextAfter: typeof change.contextAfter === "string" ? change.contextAfter : ""
      };
    })
    .filter(Boolean);
}

function getProposalChangeReviewText(change) {
  return {
    before: `${change.contextBefore}${change.before}${change.contextAfter}`,
    after: `${change.contextBefore}${change.after}${change.contextAfter}`
  };
}

function getProposalPreviewTextChanges(proposal) {
  const changes = getProposalTextChanges(proposal);
  if (changes.length > 0) {
    return changes;
  }

  return [{
    before: formatProposalValue(proposal.before),
    after: formatProposalValue(proposal.after),
    contextBefore: "",
    contextAfter: ""
  }];
}

function formatDiffLineNumber(value) {
  return Number.isFinite(value) ? String(value) : "";
}

function normalizeProposalNotePath(value) {
  return String(value ?? "").trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

function findProposalElement(timeline, proposalId) {
  if (!timeline || typeof proposalId !== "string") {
    return null;
  }

  return Array.from(timeline.querySelectorAll(".codriver-approval"))
    .find((element) => element.getAttribute("data-codriver-proposal-id") === proposalId) ?? null;
}

function shouldRenderMarkdownMessage(message) {
  return (
    message.role === "assistant" &&
    message.status !== "loading" &&
    typeof message.content === "string" &&
    message.content.length > 0
  );
}

function normalizeVisibleReasoningBlocks(blocks) {
  return Array.isArray(blocks)
    ? blocks.filter((block) => typeof block === "string" && block.length > 0)
    : [];
}

function removeRenderedElement(element) {
  if (element && typeof element.remove === "function") {
    element.remove();
  }
}

function isPrimaryClick(event) {
  return Boolean(event) && (typeof event.button !== "number" || event.button === 0);
}

function getInternalLinkTarget(link) {
  if (!link || typeof link.getAttribute !== "function") {
    return "";
  }

  const hasDataHref = typeof link.hasAttribute === "function" && link.hasAttribute("data-href");
  if (hasDataHref) {
    const dataHref = link.getAttribute("data-href");
    return isSafeInternalLinkTarget(dataHref) ? dataHref : "";
  }

  const href = link.getAttribute("href");
  return isSafeInternalLinkTarget(href) ? href : "";
}

function isSafeInternalLinkTarget(value) {
  if (typeof value !== "string" || value.trim().length === 0 || /[\u0000-\u001F\u007F]/.test(value)) {
    return false;
  }

  const trimmed = value.trim();
  return (
    !trimmed.startsWith("#") &&
    !trimmed.startsWith("//") &&
    !/^[A-Za-z][A-Za-z\d+.-]*:/.test(trimmed)
  );
}

function isNewLeafLinkEvent(event) {
  if (Keymap && typeof Keymap.isModEvent === "function") {
    try {
      return Boolean(Keymap.isModEvent(event));
    } catch {
      // Fall back to the standard platform modifier flags.
    }
  }

  return event?.ctrlKey === true || event?.metaKey === true;
}

function hasDraggedFiles(event) {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}

function getAttachmentIcon(attachment) {
  if (attachment.kind === "audio") {
    return "audio-lines";
  }

  if (attachment.kind === "image") {
    return "image";
  }

  if (attachment.extension === "pdf") {
    return "file-text";
  }

  if (attachment.extension === "docx") {
    return "file-type";
  }

  return "file";
}

function formatAttachmentMeta(attachment) {
  const size = formatBytes(attachment.size);
  if (attachment.status === "pending") {
    return `${size} - Reading...`;
  }

  if (attachment.status === "error") {
    return `${size} - ${attachment.error || "Unable to read file"}`;
  }

  if (attachment.status === "metadata") {
    return `${size} - Visible from session history. Reattach to use as context.`;
  }

  if (attachment.kind === "audio") {
    const destination = attachment.details?.destination || "Not configured";
    const authentication = attachment.details?.authenticationDisclosure || "";
    if (attachment.details?.processingStatus === "processing") {
      return `${size} - Processing audio with ${destination}...`;
    }
    if (attachment.details?.processingStatus === "complete") {
      const parts = [size, `${attachment.characterCount ?? 0} transcript characters`, destination];
      if (attachment.truncated) {
        parts.push("truncated");
      }
      return parts.join(" - ");
    }
    if (attachment.details?.configurationError) {
      return `${size} - ${attachment.details.configurationError}`;
    }
    return `${size} - Audio will be processed by ${destination} when you send this message.${authentication ? ` ${authentication}.` : ""}`;
  }

  if (attachment.kind === "image") {
    return `${size} - image`;
  }

  const parts = [size, `${attachment.characterCount ?? 0} characters`];
  if (attachment.details?.pageCount) {
    parts.push(`${attachment.details.pageCount} pages`);
  }
  if (attachment.truncated) {
    parts.push("truncated");
  }

  return parts.join(" - ");
}

function isMcpToolCallInteractiveTarget(target, card) {
  if (!(target instanceof Element)) {
    return false;
  }

  const interactive = target.closest("button,input,label,summary,details,a,textarea,select");
  return Boolean(interactive && card.contains(interactive));
}

function formatTokenValue(value, fallbackEstimate = null, incomplete = false) {
  if (Number.isFinite(value)) {
    return incomplete ? `\u2265${formatNumber(value)}` : formatNumber(value);
  }

  if (Number.isFinite(fallbackEstimate) && fallbackEstimate > 0) {
    return `~${formatNumber(fallbackEstimate)}`;
  }

  return "n/a";
}

function formatReportedUsage(value, incomplete = false) {
  if (!Number.isFinite(value)) {
    return incomplete ? "Not reported (incomplete)" : "Not reported";
  }
  return incomplete ? `${formatNumber(value)} (incomplete)` : formatNumber(value);
}

function formatContextBudgetValue(characters) {
  const value = Number(characters);
  if (!Number.isFinite(value) || value <= 0) {
    return "Unlimited";
  }

  return `${formatNumber(value)} chars / ~${formatNumber(Math.ceil(value / 4))} tokens`;
}

function formatNumber(value) {
  if (!Number.isFinite(value)) {
    return "0";
  }

  return Math.round(value).toLocaleString();
}

function formatContextWarningOutcome(outcome) {
  const labels = {
    "waiting-for-decision": "Waiting for decision",
    "continued-once": "Continued once",
    "continued-for-session": "Continued for this request",
    "suppressed-for-request": "Continued for this request",
    stopped: "Stopped",
    invalidated: "No longer available"
  };
  return labels[outcome] || String(outcome ?? "");
}

function getMcpToolCallStatusLabel(status) {
  if (status === "pending") {
    return "Waiting for approval";
  }

  if (status === "queued") {
    return "queued";
  }

  if (status === "running") {
    return "Running";
  }

  if (status === "output-review") {
    return "Waiting for output review";
  }

  if (status === "complete") {
    return "Completed";
  }

  if (status === "rejected") {
    return "Rejected";
  }

  if (status === "cancelled") {
    return "Cancelled";
  }

  if (status === "error") {
    return "Error";
  }

  return "Tool call";
}

function getMcpToolCallStatusIcon(status) {
  if (status === "complete") {
    return "circle-check";
  }

  if (status === "rejected") {
    return "circle-x";
  }

  if (status === "cancelled") {
    return "ban";
  }

  if (status === "error") {
    return "circle-alert";
  }

  return "clock-3";
}

function getDeleteRecoveryStatusLabel(status) {
  if (status === "available") {
    return "Recovery available in this session";
  }
  if (status === "restoring") {
    return "Restoring note";
  }
  if (status === "restored") {
    return "Restored to original path";
  }
  return "Automatic recovery unavailable";
}

function getMcpToolApproveButtonLabel(toolCall) {
  if (toolCall?.toolName === CODRIVER_VAULT_CREATE_NOTE_TOOL_NAME) {
    return "Create note";
  }
  if (toolCall?.toolName === CODRIVER_VAULT_MOVE_FILE_TOOL_NAME) {
    return "Move file";
  }
  if (toolCall?.toolName === CODRIVER_VAULT_DELETE_NOTE_TOOL_NAME) {
    return "Move to trash";
  }
  if (toolCall?.toolName === CODRIVER_VAULT_TRANSCRIBE_AUDIO_TOOL_NAME) {
    return "Send audio";
  }
  return "Approve";
}

function formatJsonValue(value) {
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return String(value ?? "");
  }
}

function readFiniteNumber(value, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function readNonNegativeNumber(value) {
  return Math.max(0, readFiniteNumber(value));
}

function readAnimationClockMilliseconds() {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

function isDetailedDiagnosticLogger(diagnostics) {
  if (!diagnostics || typeof diagnostics.debug !== "function") {
    return false;
  }
  if (typeof diagnostics.isEnabled === "function" && !diagnostics.isEnabled()) {
    return false;
  }
  return typeof diagnostics.getLogLevel !== "function" || diagnostics.getLogLevel() !== "errors";
}

function normalizeDiagnosticIdentifier(value) {
  const identifier = typeof value === "string" ? value.trim() : "";
  return /^[A-Za-z0-9._-]{1,160}$/.test(identifier) ? identifier : "";
}
