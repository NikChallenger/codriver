const { Modal, Notice, Setting } = require("obsidian");

class RemovalConfirmationModal extends Modal {
  constructor(app, { kind, name, onDelete, onClosed }) {
    super(app);
    this.kind = kind;
    this.name = name;
    this.onDelete = onDelete;
    this.onClosed = onClosed;
    this.deleting = false;
    this.closed = false;
  }

  onOpen() {
    this.contentEl.empty();
    this.contentEl.createEl("p", { text: `Delete ${this.kind} "${this.name}"?` });
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
    try {
      await this.onDelete();
      this.close();
    } catch {
      new Notice(`Unable to delete ${this.kind}.`);
    } finally {
      this.deleting = false;
      if (!this.closed) {
        this.cancelButton.setDisabled(false);
        this.deleteButton.setDisabled(false);
      }
    }
  }

  onClose() {
    this.closed = true;
    this.contentEl.empty();
    this.onClosed?.();
  }
}

module.exports = { RemovalConfirmationModal };
