function expandCommand(command, userText, options = {}) {
  if (!command || typeof command.prompt !== "string") return { ok: false, reason: "command-unavailable", message: "The selected command is unavailable. Reload commands and try again." };
  const text = String(userText ?? "").trim();
  const hasTextModifier = hasUnescaped(command.prompt, "{}");
  const hasActiveNoteModifier = hasUnescaped(command.prompt, "{activeNote}");
  if (hasTextModifier && !text && options.hasReadyAttachments !== true) {
    return { ok: false, reason: "command-input-required", message: "Add text or a ready file before sending this command." };
  }
  const activeNotePath = String(options.activeNotePath ?? "").trim();
  if (hasActiveNoteModifier && !activeNotePath) {
    return { ok: false, reason: "active-note-required", message: "Add Active note context before sending this command." };
  }

  const protectedText = command.prompt
    .replaceAll("\\{activeNote}", "\u0000ACTIVE_NOTE\u0000")
    .replaceAll("\\{}", "\u0000USER_TEXT\u0000");
  const activeNoteReplacement = typeof options.activeNoteReplacement === "string"
    ? options.activeNoteReplacement
    : `[[${activeNotePath}]]`;
  let expanded = protectedText
    .replaceAll("{activeNote}", activeNoteReplacement)
    .replaceAll("{}", text)
    .replaceAll("\u0000ACTIVE_NOTE\u0000", "{activeNote}")
    .replaceAll("\u0000USER_TEXT\u0000", "{}");
  if (!hasTextModifier && text) expanded = `${expanded.trim()}\n\n${text}`;
  expanded = expanded.trim();
  return { ok: true, content: expanded, promptCharacters: expanded.length };
}

function hasUnescaped(text, modifier) {
  for (let index = String(text).indexOf(modifier); index !== -1; index = String(text).indexOf(modifier, index + modifier.length)) {
    let slashes = 0;
    for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) slashes += 1;
    if (slashes % 2 === 0) return true;
  }
  return false;
}

module.exports = { expandCommand, hasUnescaped };
