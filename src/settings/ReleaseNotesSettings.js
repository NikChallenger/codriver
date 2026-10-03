function normalizeReleaseNotesVersion(value) {
  return typeof value === "string" && value.length <= 32 && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)
    && value.split(".").every((part) => Number.isSafeInteger(Number(part))) ? value : "";
}

function isReleaseNotesEligible(version, acknowledgedVersion) {
  const current = normalizeReleaseNotesVersion(version);
  if (!current) return false;
  const previous = normalizeReleaseNotesVersion(acknowledgedVersion);
  if (!previous) return true;
  const left = current.split(".").map(Number);
  const right = previous.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index];
  }
  return false;
}

module.exports = { normalizeReleaseNotesVersion, isReleaseNotesEligible };
