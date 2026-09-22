const DEFAULT_SKILL_FRONTMATTER_KEY = "codriver-skill";

class FrontmatterSkillMatcher {
  findMatches(skills, metadata) {
    const frontmatter = metadata.frontmatter ?? {};
    const requestedSkillNames = normalizeFrontmatterValues(frontmatter[DEFAULT_SKILL_FRONTMATTER_KEY]);

    return skills.filter((skill) => {
      if (skill.hidden || skill.required || skill.invocation !== "model") {
        return false;
      }

      return requestedSkillNames.includes(normalizeFrontmatterValue(skill.name));
    });
  }
}

function normalizeFrontmatterValues(value) {
  if (Array.isArray(value)) {
    return value.map(normalizeFrontmatterValue).filter(Boolean);
  }

  if (typeof value === "string") {
    return value.split(",").map(normalizeFrontmatterValue).filter(Boolean);
  }

  return [normalizeFrontmatterValue(value)].filter(Boolean);
}

function normalizeFrontmatterValue(value) {
  if (value === null || value === undefined) {
    return "";
  }

  return String(value).trim().toLowerCase();
}

module.exports = {
  DEFAULT_SKILL_FRONTMATTER_KEY,
  FrontmatterSkillMatcher,
  normalizeFrontmatterValues
};
