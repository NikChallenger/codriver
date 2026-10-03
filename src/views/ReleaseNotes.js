const { Modal, Notice } = require("obsidian");
const { isReleaseNotesEligible } = require("../settings/ReleaseNotesSettings");
const bundledNotes = require("../generated/releaseNotes");

class ReleaseNotesModal extends Modal {
  constructor(app, notes, onClosed) {
    super(app);
    this.notes = notes;
    this.onClosed = onClosed;
  }

  onOpen() {
    this.contentEl.addClass("codriver-release-notes-modal");
    this.contentEl.createEl("h2", { text: `What's new in CoDriver ${this.notes.version}` });
    let list = null;
    for (const block of this.notes.blocks) {
      if (block.type === "li") {
        list ??= this.contentEl.createEl("ul");
        list.createEl("li", { text: block.text });
      } else {
        list = null;
        this.contentEl.createEl(block.type, { text: block.text });
      }
    }
    const close = this.contentEl.createEl("button", { text: "Got it", cls: "mod-cta", attr: { type: "button" } });
    close.addEventListener("click", () => this.close());
    close.focus();
  }

  onClose() {
    this.contentEl.empty();
    this.onClosed();
  }
}

class ReleaseNotes {
  constructor(app, { version, getAcknowledgedVersion, acknowledge, refresh }, notes = bundledNotes) {
    this.app = app;
    this.version = version;
    this.getAcknowledgedVersion = getAcknowledgedVersion;
    this.acknowledge = acknowledge;
    this.refresh = refresh;
    this.notes = notes;
    this.pending = false;
    this.disposed = false;
    this.modal = null;
  }

  isEligible() {
    return !this.disposed && this.notes.version === this.version && this.notes.blocks.length > 0
      && isReleaseNotesEligible(this.version, this.getAcknowledgedVersion());
  }

  render(root, returnFocus = () => {}) {
    if (!this.isEligible()) return;
    const banner = root.createDiv({ cls: "codriver-release-notes-banner", attr: { role: "region", "aria-label": "CoDriver update" } });
    banner.createSpan({ text: `CoDriver ${this.version} is here` });
    const actions = banner.createDiv({ cls: "codriver-release-notes-actions" });
    const details = actions.createEl("button", { text: "What's new", attr: { type: "button" } });
    const dismiss = actions.createEl("button", { text: "Dismiss", cls: "codriver-release-notes-dismiss", attr: { type: "button", "aria-label": "Dismiss update banner" } });
    details.disabled = dismiss.disabled = this.pending;
    details.addEventListener("click", () => { void this.accept(true, returnFocus); });
    dismiss.addEventListener("click", () => { void this.accept(false, returnFocus); });
  }

  async accept(openNotes, returnFocus = () => {}) {
    if (!this.isEligible() || this.pending) return;
    if (openNotes && !this.modal) {
      this.modal = new ReleaseNotesModal(this.app, this.notes, () => {
        this.modal = null;
        if (!this.disposed) returnFocus();
      });
      this.modal.open();
    }
    this.pending = true;
    this.refresh();
    try {
      await this.acknowledge(this.version);
    } catch {
      if (!this.disposed) new Notice("Could not save release notes acknowledgement. Please try again.");
    } finally {
      this.pending = false;
      if (!this.disposed) {
        this.refresh();
        if (!openNotes || !this.modal) returnFocus();
      }
    }
  }

  dispose() {
    this.disposed = true;
    this.modal?.close();
  }
}

module.exports = { ReleaseNotes, ReleaseNotesModal };
