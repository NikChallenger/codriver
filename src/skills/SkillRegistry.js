class SkillRegistry {
  constructor() {
    this.skills = new Map();
    this.activeSkillIds = new Set();
  }

  register(skill) {
    const previous = this.skills.get(skill.id);
    const previousWasAlwaysActive = previous && (
      previous.invocation === "always" || previous.hidden || previous.required
    ) && previous.available !== false;
    const nextIsAlwaysActive = (
      skill.invocation === "always" || skill.hidden || skill.required
    ) && skill.available !== false;
    if (previousWasAlwaysActive && !nextIsAlwaysActive) {
      this.activeSkillIds.delete(skill.id);
    }

    this.skills.set(skill.id, skill);
    this.setEnabled(skill.id, skill.enabled !== false);
  }

  unregister(skillId) {
    const skill = this.skills.get(skillId);
    if (!skill || skill.required) {
      return false;
    }

    this.activeSkillIds.delete(skillId);
    return this.skills.delete(skillId);
  }

  activate(skillId) {
    const skill = this.skills.get(skillId);
    if (skill?.enabled !== false && skill?.available !== false) {
      this.activeSkillIds.add(skillId);
      return true;
    }
    return false;
  }

  deactivate(skillId) {
    const skill = this.skills.get(skillId);
    if (skill && skill.invocation !== "always" && !skill.hidden && !skill.required) {
      this.activeSkillIds.delete(skillId);
    }
  }

  setEnabled(skillId, enabled) {
    const skill = this.skills.get(skillId);
    if (!skill) {
      return false;
    }

    skill.enabled = enabled !== false;
    if (!skill.enabled) {
      this.activeSkillIds.delete(skillId);
      return true;
    }

    if (
      skill.available !== false &&
      (skill.invocation === "always" || skill.hidden || skill.required)
    ) {
      this.activeSkillIds.add(skillId);
    }
    return true;
  }

  isActive(skillId) {
    return this.activeSkillIds.has(skillId);
  }

  get(skillId) {
    return this.skills.get(skillId);
  }

  list() {
    return Array.from(this.skills.values());
  }

  listActive() {
    return Array.from(this.activeSkillIds)
      .map((id) => this.skills.get(id))
      .filter((skill) => skill?.enabled !== false && skill?.available !== false);
  }

  findByQuery(query) {
    const normalizedQuery = normalizeSkillQuery(query);
    return Array.from(this.skills.values()).filter((skill) => {
      if (
        skill.enabled === false ||
        skill.available === false ||
        skill.hidden ||
        skill.showInSlash === false
      ) {
        return false;
      }

      return (
        skill.command?.toLowerCase().includes(normalizedQuery) ||
        skill.name.toLowerCase().includes(normalizedQuery) ||
        skill.description.toLowerCase().includes(normalizedQuery)
      );
    });
  }
}

module.exports = {
  SkillRegistry
};

function normalizeSkillQuery(query) {
  const normalizedQuery = query.trim().toLowerCase();
  return normalizedQuery.startsWith("skill:")
    ? normalizedQuery.slice("skill:".length)
    : normalizedQuery;
}
