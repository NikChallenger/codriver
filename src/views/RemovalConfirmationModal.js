const { Modal, Notice, Setting } = require("obsidian");
const { ConnectionRemovalError } = require("../settings/ConnectionRemoval");

class RemovalConfirmationModal extends Modal {
  constructor(app, { kind, name, secretName, shared, onDelete, onRetry, onClosed }) {
    super(app);
    this.kind = kind;
    this.name = name;
    this.secretName = typeof secretName === "string" ? secretName : "";
    this.shared = shared === true;
    this.removeSecret = Boolean(this.secretName) && !this.shared;
    this.onRetry = onRetry;
    this.onDelete = onDelete;
    this.onClosed = onClosed;
    this.deleting = false;
    this.closed = false;
    this.abortController = new AbortController();
  }

  onOpen() {
    this.contentEl.empty();
    this.contentEl.createEl("p", { text: `Delete ${this.kind} "${this.name}"?` });
    if (this.secretName) {
      const secretInfo = this.contentEl.createDiv({ cls: "codriver-removal-secret-info" });
      const label = secretInfo.createEl("label", { cls: "codriver-removal-secret-label" });
      this.secretCheckbox = label.createEl("input", { attr: { type: "checkbox" } });
      this.secretCheckbox.checked = this.removeSecret;
      this.secretCheckbox.disabled = this.shared;
      this.secretCheckbox.addEventListener("change", () => { this.removeSecret = this.secretCheckbox.checked && !this.shared; });
      label.createSpan({ text: `Remove secret: ${this.secretName}` });
      if (this.shared) secretInfo.createEl("p", {
        text: "This secret is used by another CoDriver connection and will be kept."
      });
    }
    new Setting(this.contentEl)
      .addButton((button) => {
        this.cancelButton = button;
        button.setButtonText("Cancel").onClick(() => this.close());
      })
      .addButton((button) => {
        this.deleteButton = button;
        button.setButtonText("Delete").setWarning().onClick(() => this.deleteEntry());
      });
    this.cancelButton.buttonEl.focus();
  }

  async deleteEntry() {
    if (this.closed || this.deleting) return;
    this.deleting = true;
    this.cancelButton.setDisabled(true);
    this.deleteButton.setDisabled(true);
    if (this.secretCheckbox) this.secretCheckbox.disabled = true;
    try {
      const signal = this.abortController.signal;
      const result = this.cleanupPending ? await this.onRetry(signal) : await this.onDelete(this.removeSecret, signal);
      if (this.closed) return;
      if (result?.cleanupPending) {
        if (!this.cleanupPending) {
          this.contentEl.createEl("p", { text: "Connection deleted. Unable to remove the secret. Retry or close to keep it." });
        }
        this.cleanupPending = true;
        this.deleteButton.setButtonText("Retry secret cleanup");
        this.cancelButton.setButtonText("Close");
      } else this.close();
    } catch (error) {
      new Notice(error instanceof ConnectionRemovalError ? error.message : `Unable to delete ${this.kind}.`);
    } finally {
      this.deleting = false;
      if (!this.closed) {
        this.cancelButton.setDisabled(false);
        this.deleteButton.setDisabled(false);
        if (this.secretCheckbox) this.secretCheckbox.disabled = this.shared || this.cleanupPending === true;
      }
    }
  }

  onClose() {
    this.closed = true;
    this.abortController.abort();
    this.contentEl.empty();
    this.onClosed?.();
  }
}

module.exports = { RemovalConfirmationModal };
