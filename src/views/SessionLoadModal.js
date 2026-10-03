const { SuggestModal } = require("obsidian");

class SessionLoadModal extends SuggestModal {
  constructor(app, sessions, onChooseSession) {
    super(app);
    this.sessions = sessions;
    this.onChooseSession = onChooseSession;
    this.setPlaceholder("Session history");
  }

  getSuggestions(query) {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return this.sessions;
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
    return this.onChooseSession(session);
  }
}

module.exports = { SessionLoadModal };
