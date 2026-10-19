import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PUBLIC_REPOSITORY, assertExactPaths, publicTreeFilesForVersion, validateReleaseTag } from "./public-release-policy.mjs";

const OWNER = "NikChallenger";
const SHA = /^[a-f0-9]{40}$/;

export function validateReviewPullRequest(pr, version, { merged = false, mainCommit } = {}) {
  validateReleaseTag(version);
  if (!pr || !Number.isSafeInteger(pr.number) || pr.number < 1 || pr.user?.login !== OWNER ||
      pr.head?.repo?.full_name !== PUBLIC_REPOSITORY || pr.base?.repo?.full_name !== PUBLIC_REPOSITORY ||
      pr.head?.ref !== `review/${version}` || pr.base?.ref !== "main" || !SHA.test(pr.head?.sha ?? "") ||
      !SHA.test(pr.base?.sha ?? "") || (merged ? !pr.merged || pr.merged_by?.login !== OWNER : pr.state !== "open")) {
    throw new Error("Expected the owner's unchanged public review-to-main pull request.");
  }
  if (merged && (!SHA.test(mainCommit ?? "") || pr.merge_commit_sha !== mainCommit)) {
    throw new Error("Merged review pull request does not identify current public main.");
  }
  return { number: pr.number, reviewedCommit: pr.head.sha, baseCommit: pr.base.sha, mainCommit: pr.merge_commit_sha };
}

export async function resolveReviewPullRequest(github, version, options = {}) {
  validateReleaseTag(version);
  const matches = [];
  for (let page = 1; page <= 10; page++) {
    const { data } = await github.rest.pulls.list({ owner: OWNER, repo: "codriver", base: "main",
      head: `${OWNER}:review/${version}`, state: options.merged ? "closed" : "open", per_page: 100, page });
    if (!Array.isArray(data)) throw new Error("Invalid public pull request catalog.");
    for (const item of data) {
      const { data: pr } = await github.rest.pulls.get({ owner: OWNER, repo: "codriver", pull_number: item.number });
      if (options.merged && !pr.merged) continue;
      matches.push(pr);
    }
    if (data.length < 100) break;
    if (page === 10) throw new Error("Public pull request catalog exceeds its bound.");
  }
  if (matches.length !== 1) throw new Error("Expected exactly one matching public release pull request.");
  const review = validateReviewPullRequest(matches[0], version, options);
  const ref = (await github.rest.git.getRef({ owner: OWNER, repo: "codriver", ref: `heads/review/${version}` })).data.object;
  if (ref.type !== "commit" || ref.sha !== review.reviewedCommit) throw new Error("Current review ref differs from the owner PR.");
  const main = (await github.rest.git.getRef({ owner: OWNER, repo: "codriver", ref: "heads/main" })).data.object;
  if (main.type !== "commit" || main.sha !== (options.merged ? options.mainCommit : review.baseCommit)) {
    throw new Error("Public main changed; refresh validation without changing reviewed content.");
  }
  return review;
}

function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) throw new Error("Could not verify the release Git boundary.");
  return result.stdout.trim();
}

export function verifyReviewedTree({ root, version, reviewedCommit, candidateCommit, requireMerge = false }) {
  validateReleaseTag(version);
  if (!SHA.test(reviewedCommit ?? "") || !SHA.test(candidateCommit ?? "")) throw new Error("Exact release commits required.");
  if (git(root, ["rev-parse", `refs/remotes/origin/review/${version}`]) !== reviewedCommit) {
    throw new Error("Public review branch changed or is missing; repeat Community Review.");
  }
  const entries = git(root, ["ls-tree", "-r", reviewedCommit]).split("\n").filter(Boolean);
  const paths = entries.map((entry) => {
    const match = entry.match(/^100644 blob [a-f0-9]{40}\t([^\t\r\n]+)$/);
    if (!match) throw new Error("Public snapshot contains an unsupported file mode or path.");
    return match[1];
  });
  assertExactPaths(paths, publicTreeFilesForVersion(version), "Reviewed public tree");
  if (git(root, ["rev-parse", `${reviewedCommit}^{tree}`]) !== git(root, ["rev-parse", `${candidateCommit}^{tree}`])) {
    throw new Error("Merge changed the exact Community-reviewed public tree.");
  }
  if (requireMerge) {
    const parents = git(root, ["rev-list", "--parents", "-n", "1", candidateCommit]).split(" ");
    if (parents.length !== 3 || parents[2] !== reviewedCommit) {
      throw new Error("Use an ordinary review-to-main merge commit; squash and rebase are unsupported.");
    }
  }
  return reviewedCommit;
}

export function verifyPublicMetadata(root, version) {
  validateReleaseTag(version);
  const read = (path) => JSON.parse(readFileSync(resolve(root, path), "utf8"));
  const manifest = read("manifest.json"), pkg = read("package.json"), versions = read("versions.json");
  const runtime = readFileSync(resolve(root, "src/constants.js"), "utf8").match(/^const CODRIVER_PLUGIN_VERSION = "([^"]+)";$/m)?.[1];
  if (manifest.id !== "codriver" || manifest.version !== version || pkg.version !== version || runtime !== version ||
      manifest.description !== "Chat with your vault through connected language model providers." ||
      pkg.description !== manifest.description || versions[version] !== manifest.minAppVersion ||
      JSON.stringify(pkg.scripts) !== JSON.stringify({ build: "node build.mjs" }) ||
      !readFileSync(resolve(root, `docs/releases/${version}.md`), "utf8").trim()) {
    throw new Error("Public release metadata or notes do not match the reviewed version.");
  }
}

export async function ensurePublicReleaseTag({ github, version, mainCommit, reviewedCommit }) {
  validateReleaseTag(version);
  if (!SHA.test(mainCommit ?? "") || !SHA.test(reviewedCommit ?? "")) throw new Error("Exact public main and review commits required.");
  const get = async (ref) => (await github.rest.git.getRef({ owner: OWNER, repo: "codriver", ref })).data.object;
  async function verifyReview() {
    const review = await get(`heads/review/${version}`);
    if (review.type !== "commit" || review.sha !== reviewedCommit) throw new Error("Public review changed before release mutation.");
  }
  const main = await get("heads/main");
  if (main.type !== "commit" || main.sha !== mainCommit) throw new Error("Public main changed before tagging.");
  for (let page = 1; page <= 10; page++) {
    const { data } = await github.rest.repos.listReleases({ owner: OWNER, repo: "codriver", per_page: 100, page });
    if (!Array.isArray(data)) throw new Error("Invalid release catalog.");
    if (data.some((release) => release.tag_name === version && release.draft !== true)) {
      throw new Error("Published releases are immutable.");
    }
    if (data.length < 100) break;
    if (page === 10) throw new Error("Release catalog exceeds its bound.");
  }
  await verifyReview();
  const current = await get("heads/main");
  if (current.type !== "commit" || current.sha !== mainCommit) throw new Error("Public main changed before release mutation.");
  let object;
  try { object = await get(`tags/${version}`); }
  catch (error) { if (error.status !== 404) throw error; }
  if (!object) {
    try { await github.rest.git.createRef({ owner: OWNER, repo: "codriver", ref: `refs/tags/${version}`, sha: mainCommit }); }
    catch (error) { if (error.status !== 422) throw error; }
    object = await get(`tags/${version}`);
  }
  for (let depth = 0; object?.type === "tag" && depth < 8; depth++) {
    object = (await github.rest.git.getTag({ owner: OWNER, repo: "codriver", tag_sha: object.sha })).data.object;
  }
  if (object?.type !== "commit" || object.sha !== mainCommit) throw new Error("Conflicting public tag will not be changed.");
  const fresh = await get("heads/main");
  if (fresh.type !== "commit" || fresh.sha !== mainCommit) throw new Error("Public main changed during tagging; stop release preparation.");
  await verifyReview();
}
