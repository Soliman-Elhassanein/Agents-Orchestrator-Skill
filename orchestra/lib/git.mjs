/**
 * Git plumbing. Every run works on its own branch in its own worktree; every executor gets a further worktree, so parallel agents never share a working tree and the
 * user's checkout is never touched until they land the result.
 */
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";

/**
 * Every commit Orchestra makes is authored by the user's own git identity — never a bot or agent
 * identity, so the only contributor on the user's repository is the user.
 */
let identityChecked = false;
function requireIdentity(cwd) {
  if (identityChecked) return;
  const get = (k) => spawnSync("git", ["config", k], { cwd, encoding: "utf8" }).stdout.trim();
  if (!get("user.email") || !get("user.name")) {
    throw new Error("git user.name / user.email are not set. Orchestra commits as you, so set them first:\n  git config --global user.name \"Your Name\"\n  git config --global user.email you@example.com");
  }
  identityChecked = true;
}

export function git(cwd, args, { allowFail = false } = {}) {
  if (["commit", "merge"].includes(args[0])) requireIdentity(cwd);
  const res = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (res.status !== 0 && !allowFail) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}:\n${res.stderr || res.stdout}`);
  }
  return { ok: res.status === 0, out: (res.stdout || "").trim(), err: (res.stderr || "").trim() };
}

export function repoRoot(cwd) {
  try {
    const res = git(cwd, ["rev-parse", "--show-toplevel"]);
    return res.out;
  } catch {
    return null;
  }
}

export function headSha(cwd) {
  return git(cwd, ["rev-parse", "HEAD"]).out;
}

export function addBranchWorktree(repo, path, branch, base) {
  git(repo, ["worktree", "add", "-b", branch, path, base]);
}

export function addExistingBranchWorktree(repo, path, branch) {
  git(repo, ["worktree", "add", path, branch]);
}

export function branchesWithPrefix(repo, prefix) {
  return git(repo, ["branch", "--list", `${prefix}*`, "--format=%(refname:short)"], { allowFail: true }).out.split("\n").filter(Boolean);
}

export function addDetachedWorktree(repo, path, ref) {
  git(repo, ["worktree", "add", "--detach", path, ref]);
}

export function removeWorktree(repo, path) {
  git(repo, ["worktree", "remove", "--force", path], { allowFail: true });
  if (existsSync(path)) rmSync(path, { recursive: true, force: true });
  git(repo, ["worktree", "prune"], { allowFail: true });
}

export function deleteBranch(repo, branch) {
  git(repo, ["branch", "-D", branch], { allowFail: true });
}

/** Stage and commit everything; returns false when there was nothing to commit. */
export function commitAll(cwd, message) {
  git(cwd, ["add", "-A"]);
  if (git(cwd, ["diff", "--cached", "--quiet"], { allowFail: true }).ok) return false;
  git(cwd, ["commit", "-q", "--no-verify", "-m", message]);
  return true;
}

/**
 * Where a run's worktrees live: `.orchestra/worktrees/<run-id>/`, one folder per executor, inside the
 * checkout but ignored by Git with the rest of `.orchestra/`.
 */
export function worktreesRoot(repo, runId) {
  return join(repo, ".orchestra", "worktrees", runId);
}

/** Where runs before version 3 kept their worktrees, so a resumed run can clear them. */
export function legacyWorktreesRoot(repo, runId) {
  const common = git(repo, ["rev-parse", "--git-common-dir"]).out;
  return join(isAbsolute(common) ? common : join(repo, common), "orchestra-worktrees", runId);
}

/** Commits on `branch` that `base` doesn't have — an executor that committed its own work still counts. */
export function aheadOf(cwd, base, branch = "HEAD") {
  const res = git(cwd, ["rev-list", "--count", `${base}..${branch}`], { allowFail: true });
  return res.ok ? Number(res.out) : 0;
}

export function changedFiles(cwd, from, to = "HEAD") {
  return git(cwd, ["diff", "--name-only", from, to], { allowFail: true }).out.split("\n").filter(Boolean);
}

export function mergeInProgress(cwd) {
  return git(cwd, ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"], { allowFail: true }).ok;
}

/** Conclude a merge after conflicts were resolved — even when the result equals one side. */
export function concludeMerge(cwd, message) {
  git(cwd, ["add", "-A"]);
  if (mergeInProgress(cwd)) git(cwd, ["commit", "-q", "--no-verify", "--no-edit", "-m", message]);
  else commitAll(cwd, message);
}

export function merge(cwd, branch, message) {
  const res = git(cwd, ["merge", "--no-ff", "--no-verify", "-m", message, branch], { allowFail: true });
  if (res.ok) return { ok: true, conflicts: [] };
  const conflicts = git(cwd, ["diff", "--name-only", "--diff-filter=U"], { allowFail: true }).out.split("\n").filter(Boolean);
  return { ok: false, conflicts };
}

export function unmergedPaths(cwd) {
  return git(cwd, ["diff", "--name-only", "--diff-filter=U"], { allowFail: true }).out.split("\n").filter(Boolean);
}

export function abortMerge(cwd) {
  git(cwd, ["merge", "--abort"], { allowFail: true });
}

export function diff(cwd, base) {
  return git(cwd, ["diff", `${base}..HEAD`], { allowFail: true }).out;
}

export function diffStat(cwd, base) {
  return git(cwd, ["diff", "--stat", `${base}..HEAD`], { allowFail: true }).out;
}

/**
 * Paths Orchestra itself writes in the user's checkout (records). They never count as "your uncommitted work" — one definition for run and land.
 */
export const ORCHESTRA_PATHS = [":!.orchestra"];

export function isClean(cwd) {
  return git(cwd, ["status", "--porcelain", "--", ".", ...ORCHESTRA_PATHS], { allowFail: true }).out === "";
}

export function currentBranch(cwd) {
  return git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"], { allowFail: true }).out;
}
