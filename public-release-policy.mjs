export const PUBLIC_REPOSITORY = "NikChallenger/codriver";
export const RELEASE_ASSET_FILES = Object.freeze(["main.js", "manifest.json", "styles.css"]);

// Each release explicitly approves the already-public notes it must preserve.
const PUBLIC_RETAINED_NOTES_BY_VERSION = Object.freeze({
  "0.6.1": Object.freeze(["docs/releases/0.5.1.md", "docs/releases/0.5.2.md", "docs/releases/0.5.3.md", "docs/releases/0.5.4.md", "docs/releases/0.5.5.md", "docs/releases/0.6.0.md"]),
  "0.5.2": Object.freeze(["docs/releases/0.5.1.md"]),
  "0.5.3": Object.freeze(["docs/releases/0.5.1.md", "docs/releases/0.5.2.md"]),
  "0.5.4": Object.freeze(["docs/releases/0.5.1.md", "docs/releases/0.5.2.md", "docs/releases/0.5.3.md"]),
  "0.6.0": Object.freeze(["docs/releases/0.5.1.md", "docs/releases/0.5.2.md", "docs/releases/0.5.3.md", "docs/releases/0.5.4.md", "docs/releases/0.5.5.md"]),
  "0.5.5": Object.freeze(["docs/releases/0.5.1.md", "docs/releases/0.5.2.md", "docs/releases/0.5.3.md", "docs/releases/0.5.4.md"])
});

export const PUBLIC_DESCRIPTION = "Chat with your vault through connected language model providers.";
export const PUBLIC_DIRECT_FILES = Object.freeze([
  ".gitignore",
  "LICENSE",
  "README.md",
  "THIRD_PARTY_NOTICES.md",
  "main.js",
  "manifest.json",
  "styles.css",
  "versions.json",
  "docs/assets/note_edit.png",
  "src/attachments/AttachmentExtractor.js",
  "src/attachments/AudioInspector.js",
  "src/attachments/AudioTranscriptionService.js",
  "src/attachments/PdfTextExtractor.js",
  "src/chat/ChangeApproval.js",
  "src/chat/ChatController.js",
  "src/chat/CorePrompt.js",
  "src/chat/McpToolCallParser.js",
  "src/chat/PatchWorkList.js",
  "src/chat/SessionStorage.js",
  "src/commands/CommandExpansion.js",
  "src/commands/CommandFileParser.js",
  "src/commands/CommandFolderLoader.js",
  "src/constants.js",
  "src/diagnostics/DiagnosticLogger.js",
  "src/diagnostics/DetailedLogContent.js",
  "src/diagnostics/DiagnosticLogSharing.js",
  "src/diagnostics/ThinkingShimmerProbe.js",
  "src/main.js",
  "src/mcp/CodriverVaultMcpServer.js",
  "src/mcp/McpArgumentValidator.js",
  "src/mcp/McpHttpClient.js",
  "src/mcp/McpCredentials.js",
  "src/mcp/McpOAuthDesktop.js",
  "src/mcp/McpOAuthProtocol.js",
  "src/mcp/McpOAuthService.js",
  "src/mcp/McpRequestCatalog.js",
  "src/mcp/McpRuntimeSupport.js",
  "src/mcp/McpStdioClient.js",
  "src/mcp/McpToolUtils.js",
  "src/providers/ProviderRegistry.js",
  "src/providers/StreamingTransport.js",
  "src/providers/anthropic/AnthropicClient.js",
  "src/providers/anthropic/AnthropicProvider.js",
  "src/providers/gemini/GeminiClient.js",
  "src/providers/gemini/GeminiProvider.js",
  "src/providers/openai-compatible/OpenAiCompatibleClient.js",
  "src/providers/openai-compatible/OpenAiCompatibleProvider.js",
  "src/providers/openai-compatible/OpenAiCompatibleTranscriptionAdapter.js",
  "src/settings/AudioTranscriptionSettings.js",
  "src/settings/CoDriverSettingTab.js",
  "src/settings/ConnectionRemoval.js",
  "src/settings/McpServerForm.js",
  "src/settings/ProviderCredentials.js",
  "src/settings/SecretInput.js",
  "src/settings/SecretStorageAccess.js",
  "src/settings/defaults.js",
  "src/settings/ReleaseNotesSettings.js",
  "src/skills/FrontmatterSkillMatcher.js",
  "src/skills/BuiltinSkills.js",
  "src/skills/SkillFileParser.js",
  "src/skills/SkillFolderLoader.js",
  "src/skills/SkillRegistry.js",
  "src/ui/BulkSelection.js",
  "src/ui/ProposalDiff.js",
  "src/vault/AudioPathResolver.js",
  "src/vault/CanvasDocument.js",
  "src/vault/VaultReader.js",
  "src/vault/VaultWriter.js",
  "src/vendor/jsdiff/LICENSE",
  "src/vendor/jsdiff/structuredPatch.js",
  "src/vendor/unpdf/LICENSE",
  "src/vendor/unpdf/index.js",
  "src/vendor/unpdf/pdfjs.mjs.base64",
  "src/views/ChatView.js",
  "src/views/ModelPickerPopover.js",
  "src/views/RemovalConfirmationModal.js",
  "src/views/ReleaseNotes.js",
  "src/views/SessionHistoryPopover.js",
  "src/views/SessionLoadModal.js",
  "src/views/CommandActionModal.js"
]);
export const PUBLIC_MAPPED_FILES = Object.freeze([
  ["scripts/public-release-policy.mjs", "public-release-policy.mjs"],
  ["scripts/reviewed-public-release.mjs", "reviewed-public-release.mjs"],
  ["scripts/build.mjs", "build.mjs"],
  ["public-repository/package.json", "package.json"],
  ["public-repository/.github/workflows/validate.yml", ".github/workflows/validate.yml"],
  ["public-repository/.github/workflows/release.yml", ".github/workflows/release.yml"]
]);
const LEGACY_PUBLIC_FILES = Object.freeze([
  "README.md",
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
  "manifest.json",
  "versions.json",
  "docs/assets/note_edit.png"
]);

export function validateReleaseTag(tag) {
  const value = String(tag ?? "");
  if (!/^\d+\.\d+\.\d+$/.test(value)) {
    throw new Error("Release tag must be an exact semantic version such as 0.5.1.");
  }
  return value;
}

export function reviewBranchForVersion(version) {
  return `review/${validateReleaseTag(version)}`;
}

export function releaseNotesPathForTag(tag) {
  return `docs/releases/${validateReleaseTag(tag)}.md`;
}

export function publicTreeFilesForVersion(version) {
  return [
    ...PUBLIC_DIRECT_FILES,
    releaseNotesPathForTag(version),
    ...retainedReleaseNotesPaths(version),
    ...PUBLIC_MAPPED_FILES.map(([, target]) => target)
  ].map(normalizePath).sort();
}

export function retainedReleaseNotesPaths(version) {
  return [...(PUBLIC_RETAINED_NOTES_BY_VERSION[validateReleaseTag(version)] ?? [])];
}

export function legacyPublicFiles() {
  return [...LEGACY_PUBLIC_FILES];
}

export function assertExactPaths(actualPaths, expectedPaths, label) {
  const actual = [...new Set(actualPaths.map(normalizePath))].sort();
  const expected = [...new Set(expectedPaths.map(normalizePath))].sort();
  const unexpected = actual.filter((path) => !expected.includes(path));
  const missing = expected.filter((path) => !actual.includes(path));
  if (unexpected.length > 0 || missing.length > 0) {
    const details = [];
    if (unexpected.length > 0) details.push(`unexpected: ${unexpected.join(", ")}`);
    if (missing.length > 0) details.push(`missing: ${missing.join(", ")}`);
    throw new Error(`${label} does not match the approved allowlist (${details.join("; ")}).`);
  }
}

export function assertPathSubset(actualPaths, allowedPaths, label) {
  const allowed = new Set(allowedPaths.map(normalizePath));
  const unexpected = [...new Set(actualPaths.map(normalizePath))].sort().filter((path) => !allowed.has(path));
  if (unexpected.length > 0) {
    throw new Error(`${label} contains paths outside the approved boundary (unexpected: ${unexpected.join(", ")}).`);
  }
}

function normalizePath(path) {
  return String(path).replaceAll("\\", "/").replace(/^\.\//, "");
}
