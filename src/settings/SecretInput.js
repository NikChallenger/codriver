function renderSecretInput(setting, options) {
  let inputEl;
  setting.settingEl.addClass("codriver-secret-input-row");
  setting.addText((text) => {
    text.setValue(options.value).setDisabled(options.disabled === true).setPlaceholder(options.placeholder || "")
      .onChange(options.onChange);
    inputEl = text.inputEl;
    inputEl.type = options.visible ? "text" : "password";
    inputEl.setAttribute("aria-label", options.label);
    inputEl.setAttribute("autocomplete", "off");
    inputEl.spellcheck = false;
  });
  setting.addButton((button) => {
    const update = () => {
      const label = `${options.visible ? "Hide" : "Show"} ${options.visibilityLabel}`;
      button.setIcon(options.visible ? "eye-off" : "eye").setTooltip(label);
      button.buttonEl.setAttribute("aria-label", label);
      button.buttonEl.setAttribute("aria-pressed", String(Boolean(options.visible)));
    };
    button.setDisabled(options.disabled === true).onClick(() => {
      options.visible = !options.visible;
      inputEl.type = options.visible ? "text" : "password";
      options.onVisibilityChange(options.visible);
      update();
    });
    update();
  });
  return inputEl;
}

module.exports = { renderSecretInput };
