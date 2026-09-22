const MAX_PATHS = 200;
const MAX_CHARACTERS = 12000;
const MAX_OUTCOMES = 20;

// Keep a captured work list, never a reusable read result or a persisted workflow.
function capturePatchWorkList(state, toolName, result) {
  if (!state || state.stopped || result?.isError === true) return;
  const data = result?.structuredContent;
  if (!data || typeof data !== "object") return;
  const isList = toolName === "codriver_vault_list";
  const isSearch = toolName === "codriver_vault_search" || toolName === "codriver_vault_search_structured";
  const isOutcome = ["codriver_vault_move_file", "codriver_vault_create_note", "codriver_vault_patch_note"].includes(toolName);
  if (!isList && !isSearch && !isOutcome) return;
  const work = state.workList ??= { paths: [], outcomes: [], truncated: false };
  const entries = isList ? data.entries : (isSearch ? data.results : []);
  if (Array.isArray(entries)) {
    for (const entry of entries) {
      if (entry?.type === "folder" || typeof entry?.path !== "string" || work.paths.includes(entry.path)) continue;
      if (!boundedPath(entry.path) || work.paths.length >= MAX_PATHS ||
        JSON.stringify(work).length + JSON.stringify(entry.path).length + 1 > MAX_CHARACTERS) {
        work.truncated = true;
        continue;
      }
      work.paths.push(entry.path);
    }
  }
  if (isOutcome) {
    const outcome = { toolName };
    for (const key of ["path", "sourcePath", "destinationPath"]) {
      if (boundedPath(data[key])) outcome[key] = data[key];
    }
    if (toolName === "codriver_vault_patch_note" && data.applied !== true) return;
    if (Object.keys(outcome).length === 1) return;
    const encoded = JSON.stringify(outcome);
    if (!work.outcomes.some((item) => JSON.stringify(item) === encoded)) {
      if (work.outcomes.length >= MAX_OUTCOMES || JSON.stringify(work).length + encoded.length > MAX_CHARACTERS) {
        work.truncated = true;
      } else {
        work.outcomes.push(outcome);
      }
    }
  }
}

function boundedPath(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 1024 &&
    !/[\r\n\0]/.test(value) && !value.split(/[\\/]/).some((part) => part === ".." || part === ".");
}

module.exports = { capturePatchWorkList };
