let historyListSequence = 0;

class SessionHistoryPopover {
  constructor(button, sessions, onChoose, onClose) {
    this.button = button;
    this.sessions = sessions;
    this.onChoose = onChoose;
    this.onClose = onClose;
    this.listeners = [];
    this.selectedIndex = 0;
  }

  listen(target, name, handler, options) {
    target.addEventListener(name, handler, options);
    this.listeners.push(() => target.removeEventListener(name, handler, options));
  }

  open() {
    const doc = this.button.ownerDocument;
    this.window = doc.defaultView;
    this.element = doc.body.createDiv({
      cls: "codriver-session-history-popover",
      attr: { role: "dialog", "aria-label": "Session history" }
    });
    const listId = `codriver-history-${++historyListSequence}`;
    this.element.setAttribute("id", `${listId}-popover`);
    this.button.setAttribute("aria-expanded", "true");
    this.button.setAttribute("aria-controls", `${listId}-popover`);
    this.search = this.element.createEl("input", {
      cls: "codriver-session-history-search",
      attr: { type: "text", placeholder: "Session history", "aria-label": "Search sessions", "aria-controls": listId, "aria-haspopup": "listbox" }
    });
    // Keep intrinsic width based on all formatted labels while filtering.
    const sizing = this.element.createDiv({ cls: "codriver-session-history-sizing", attr: { "aria-hidden": "true" } });
    for (const session of this.sessions) {
      sizing.createDiv({ cls: "codriver-session-suggestion-name", text: session.displayName ?? session.name });
    }
    this.list = this.element.createDiv({ cls: "codriver-session-history-list", attr: { id: listId, role: "listbox", "aria-label": "Saved sessions" } });
    this.listen(this.search, "input", () => { this.selectedIndex = 0; this.renderOptions(); });
    this.listen(this.element, "keydown", (event) => this.handleKeydown(event));
    this.listen(doc, "pointerdown", (event) => {
      if (!this.element.contains(event.target) && !this.button.contains(event.target)) this.close(false);
    });
    this.listen(doc, "focusin", (event) => {
      if (!this.element.contains(event.target) && !this.button.contains(event.target)) this.close(false);
    });
    this.listen(this.window, "resize", () => this.position());
    this.listen(doc, "scroll", () => this.position(), true);
    if (this.window.visualViewport) {
      this.listen(this.window.visualViewport, "resize", () => this.position());
      this.listen(this.window.visualViewport, "scroll", () => this.position());
    }
    this.renderOptions();
    if (this.element) this.search.focus();
  }

  renderOptions() {
    const query = this.search.value.trim().toLowerCase();
    this.matches = this.sessions.filter((session) => (
      (session.displayName ?? "").toLowerCase().includes(query) ||
      session.name.toLowerCase().includes(query) || session.path.toLowerCase().includes(query)
    ));
    this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.matches.length - 1));
    this.list.empty();
    this.search.removeAttribute("aria-activedescendant");
    if (!this.matches.length) {
      this.list.createDiv({ cls: "codriver-session-history-empty", text: "No matching sessions.", attr: { role: "status" } });
    }
    let activeOption = null;
    this.matches.forEach((session, index) => {
      const selected = index === this.selectedIndex;
      const id = `${this.list.getAttribute("id")}-${index}`;
      const option = this.list.createEl("button", {
        cls: `codriver-session-history-option codriver-session-suggestion-name ${selected ? "is-selected" : ""}`,
        text: session.displayName ?? session.name,
        attr: { type: "button", role: "option", id, "aria-selected": String(selected) }
      });
      option.addEventListener("click", () => this.choose(session));
      if (selected) {
        this.search.setAttribute("aria-activedescendant", id);
        activeOption = option;
      }
    });
    this.position();
    if (this.element) activeOption?.scrollIntoView?.({ block: "nearest" });
  }

  handleKeydown(event) {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this.close(true);
      return;
    }
    if (event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return;
    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && this.matches.length) {
      event.preventDefault();
      this.selectedIndex = (this.selectedIndex + (event.key === "ArrowDown" ? 1 : -1) + this.matches.length) % this.matches.length;
      this.renderOptions();
      if (this.element) this.search.focus();
    } else if (event.key === "Enter" && event.target === this.search) {
      event.preventDefault();
      if (this.matches.length) this.choose(this.matches[this.selectedIndex]);
    }
  }

  position() {
    if (!this.element) return;
    if (!this.button.isConnected) { this.close(false); return; }
    const viewport = this.window.visualViewport;
    const left = viewport?.offsetLeft ?? 0;
    const top = viewport?.offsetTop ?? 0;
    const width = viewport?.width ?? this.window.innerWidth;
    const height = viewport?.height ?? this.window.innerHeight;
    const anchor = this.button.getBoundingClientRect();
    if (anchor.top > top + height || anchor.right < left || anchor.left > left + width) {
      this.close(false);
      return;
    }
    const availableHeight = Math.max(0, anchor.top - top - 16);
    if (availableHeight < 64) { this.close(false); return; }
    const availableWidth = Math.max(0, width - 16);
    this.element.style.maxWidth = `${availableWidth}px`;
    this.element.style.minWidth = `${Math.min(180, availableWidth)}px`;
    this.element.style.maxHeight = `${Math.min(360, availableHeight)}px`;
    const bounds = this.element.getBoundingClientRect();
    this.element.style.left = `${Math.max(left + 8, Math.min(anchor.right - bounds.width, left + width - bounds.width - 8))}px`;
    this.element.style.top = `${Math.max(top + 8, anchor.top - bounds.height - 8)}px`;
  }

  choose(session) {
    if (!this.element) return;
    this.close(true);
    void this.onChoose(session);
  }

  close(restoreFocus = false) {
    for (const remove of this.listeners.splice(0)) remove();
    this.element?.remove();
    this.element = null;
    this.button.setAttribute("aria-expanded", "false");
    this.button.removeAttribute("aria-controls");
    if (restoreFocus && this.button.isConnected) this.button.focus();
    this.onClose();
  }
}

module.exports = { SessionHistoryPopover };
