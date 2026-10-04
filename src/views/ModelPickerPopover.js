let modelListSequence = 0;

class ModelPickerPopover {
  constructor(button, options, onClose = () => {}) {
    this.button = button;
    this.options = options;
    this.onClose = onClose;
    this.listeners = [];
    this.activeValue = options.selectedValue;
  }

  listen(target, name, handler, options) {
    target.addEventListener(name, handler, options);
    this.listeners.push(() => target.removeEventListener(name, handler, options));
  }

  open() {
    if (this.element || this.button.disabled) return;
    const doc = this.button.ownerDocument;
    this.window = doc.defaultView;
    this.mobile = doc.body.classList.contains("is-mobile");
    const listId = `codriver-model-list-${++modelListSequence}`;
    // Keep modal focus containment and stacking ownership intact.
    this.host = this.button.closest(".modal") ?? doc.body;
    this.element = this.host.createDiv({
      cls: "codriver-model-popover",
      attr: { id: `${listId}-dialog`, role: "dialog", "aria-label": this.options.label }
    });
    this.button.setAttribute("aria-expanded", "true");
    this.button.setAttribute("aria-controls", `${listId}-dialog`);
    this.list = this.element.createDiv({
      cls: "codriver-model-popover-list",
      attr: { id: listId, role: "listbox", "aria-label": "Models" }
    });
    this.search = this.element.createEl("input", {
      cls: "codriver-model-popover-search",
      attr: {
        type: "search", placeholder: "Search", "aria-label": "Search models",
        role: "combobox", "aria-autocomplete": "list", "aria-expanded": "true",
        "aria-controls": listId
      }
    });
    this.listen(this.search, "input", () => { this.activeValue = null; this.renderOptions(); });
    this.listen(this.element, "keydown", (event) => this.handleKeydown(event));
    for (const name of ["pointerdown", "focusin"]) {
      this.listen(doc, name, (event) => {
        if (!this.element.contains(event.target) && !this.button.contains(event.target)) this.close();
      });
    }
    this.listen(this.window, "resize", () => this.position());
    this.listen(doc, "scroll", () => this.position(), true);
    if (this.window.visualViewport) {
      this.listen(this.window.visualViewport, "resize", () => this.position());
      this.listen(this.window.visualViewport, "scroll", () => this.position());
    }
    this.renderOptions();
    if (this.element && !this.mobile) this.search.focus();
    this.position();
  }

  renderOptions() {
    const query = this.search.value.trim().toLocaleLowerCase();
    const groups = this.options.groups.map((group) => ({
      ...group,
      models: group.models.filter((model) => model.model.toLocaleLowerCase().includes(query))
    })).filter((group) => group.models.length);
    this.matches = groups.flatMap((group) => group.models.filter((model) => !model.disabled));
    if (!this.matches.some((model) => model.value === this.activeValue)) {
      this.activeValue = this.matches[0]?.value ?? null;
    }
    this.list.empty();
    this.search.removeAttribute("aria-activedescendant");
    if (!groups.length) {
      this.list.createDiv({ cls: "codriver-model-popover-empty", text: "No matching models", attr: { role: "status" } });
    }
    let activeOption = null;
    let index = 0;
    for (const group of groups) {
      const groupEl = this.list.createDiv({ attr: { role: "group", "aria-label": group.label || "Models" } });
      if (group.label) groupEl.createDiv({ cls: "codriver-model-popover-heading", text: group.label, attr: { "aria-hidden": "true" } });
      for (const model of group.models) {
        const active = model.value === this.activeValue && !model.disabled;
        const id = `${this.list.getAttribute("id")}-${index++}`;
        const option = groupEl.createEl("button", {
          cls: `codriver-model-popover-option${active ? " is-active" : ""}`,
          text: model.label,
          attr: {
            id, type: "button", role: "option", tabindex: "-1", title: model.label,
            "aria-selected": String(model.value === this.options.selectedValue),
            "aria-disabled": String(Boolean(model.disabled))
          }
        });
        option.disabled = Boolean(model.disabled);
        // Keep the search focused so a mobile keyboard does not resize before selection.
        option.addEventListener("pointerdown", (event) => event.preventDefault());
        option.addEventListener("click", () => this.choose(model));
        if (active) { this.search.setAttribute("aria-activedescendant", id); activeOption = option; }
      }
    }
    this.position();
    if (this.element) activeOption?.scrollIntoView?.({ block: "nearest" });
  }

  handleKeydown(event) {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === "Escape") {
      event.preventDefault(); event.stopPropagation(); this.close(true); return;
    }
    if (event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!this.matches.length) return;
      const index = this.matches.findIndex((model) => model.value === this.activeValue);
      this.activeValue = this.matches[(index + (event.key === "ArrowDown" ? 1 : -1) + this.matches.length) % this.matches.length].value;
      this.renderOptions();
    } else if (event.key === "Enter" && event.target === this.search) {
      event.preventDefault();
      this.choose(this.matches.find((model) => model.value === this.activeValue));
    }
  }

  position() {
    if (!this.element) return;
    if (!this.button.isConnected) { this.close(); return; }
    const viewport = this.window.visualViewport;
    let left = viewport?.offsetLeft ?? 0;
    let top = viewport?.offsetTop ?? 0;
    let width = viewport?.width ?? this.window.innerWidth;
    let height = viewport?.height ?? this.window.innerHeight;
    if (this.host !== this.button.ownerDocument.body) {
      const hostBounds = this.host.getBoundingClientRect();
      const right = Math.min(left + width, hostBounds.right);
      const bottom = Math.min(top + height, hostBounds.bottom);
      left = Math.max(left, hostBounds.left);
      top = Math.max(top, hostBounds.top);
      width = Math.max(0, right - left);
      height = Math.max(0, bottom - top);
    }
    const anchor = this.button.getBoundingClientRect();
    const offscreen = anchor.bottom < top || anchor.top > top + height || anchor.right < left || anchor.left > left + width;
    if (offscreen && !this.mobile) {
      this.close(); return;
    }
    const above = anchor.top - top - 16;
    const below = top + height - anchor.bottom - 16;
    const upward = this.options.preferAbove ? above >= 120 || above >= below : below < 120 && above > below;
    let availableHeight = Math.max(0, upward ? above : below);
    const viewportFallback = this.mobile && (offscreen || availableHeight < 80);
    if (viewportFallback) availableHeight = Math.max(0, height - 16);
    if (availableHeight < 80) { this.close(); return; }
    this.element.style.width = `${Math.min(320, Math.max(0, width - 16))}px`;
    this.element.style.maxHeight = `${Math.min(360, availableHeight)}px`;
    const bounds = this.element.getBoundingClientRect();
    const targetLeft = Math.max(left + 8, Math.min(anchor.left, left + width - bounds.width - 8));
    const targetTop = viewportFallback ? top + 8 : upward ? anchor.top - bounds.height - 8 : anchor.bottom + 8;
    // A transformed owning modal can establish the fixed-position containing block.
    this.element.style.left = "0px";
    this.element.style.top = "0px";
    const origin = this.element.getBoundingClientRect();
    this.element.style.left = `${targetLeft - origin.left}px`;
    this.element.style.top = `${targetTop - origin.top}px`;
  }

  choose(model) {
    if (!this.element || !model || model.disabled || !this.matches.includes(model)) return;
    this.close(true);
    void this.options.onChoose(model.value);
  }

  close(restoreFocus = false) {
    if (!this.element) return;
    for (const remove of this.listeners.splice(0)) remove();
    this.element.remove();
    this.element = null;
    this.button.setAttribute("aria-expanded", "false");
    this.button.removeAttribute("aria-controls");
    if (restoreFocus && this.button.isConnected) this.button.focus();
    this.onClose();
  }
}

function bindModelPicker(owner, button, options) {
  button.setAttribute("aria-haspopup", "dialog");
  button.setAttribute("aria-expanded", "false");
  const open = () => {
    if (button.disabled) return;
    if (owner.modelPickerPopover?.button === button) { owner.modelPickerPopover.close(true); return; }
    owner.modelPickerPopover?.close();
    const popover = new ModelPickerPopover(button, options, () => {
      if (owner.modelPickerPopover === popover) owner.modelPickerPopover = null;
    });
    owner.modelPickerPopover = popover;
    popover.open();
  };
  button.addEventListener("click", open);
  button.addEventListener("keydown", (event) => {
    if (event.isComposing || event.keyCode === 229 || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); open(); }
  });
}

module.exports = { ModelPickerPopover, bindModelPicker };
