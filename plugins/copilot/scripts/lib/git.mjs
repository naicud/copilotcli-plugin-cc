// Git utilities for the Copilot companion.

import path from "node:path";
import { runCommand } from "./process.mjs";

/**
 * Get the git repository root for a given directory, in the platform's own
 * path form: git prints forward slashes on Windows ("C:/Users/..."), and the
 * workspace path keys the plugin's state, so it must match what node APIs
 * produce for the same directory.
 * @param {string} cwd
 * @returns {Promise<string|null>}
 */
export async function getGitRoot(cwd) {
  const { stdout, exitCode } = await runCommand(
    "git",
    ["rev-parse", "--show-toplevel"],
    { cwd }
  );
  const root = stdout.trim();
  return exitCode === 0 && root ? path.resolve(root) : null;
}

/**
 * Get the current branch name.
 * @param {string} cwd
 * @returns {Promise<string|null>}
 */
export async function getCurrentBranch(cwd) {
  const { stdout, exitCode } = await runCommand(
    "git",
    ["rev-parse", "--abbrev-ref", "HEAD"],
    { cwd }
  );
  return exitCode === 0 ? stdout.trim() : null;
}

/**
 * Get the diff for review.
 * - base given: the branch's own changes, `base...HEAD`;
 * - otherwise the whole working tree against HEAD, staged and unstaged
 *   alike (a plain `git diff` would silently skip staged changes); in a repo
 *   without commits yet, the staged plus unstaged diffs.
 * Untracked files have no diff; they are listed by getStatus/getChangedFiles.
 * @param {string} cwd
 * @param {{ base?: string, cached?: boolean }} opts
 * @returns {Promise<string>}
 */
export async function getDiff(cwd, opts = {}) {
  if (opts.base) return (await runCommand("git", ["diff", `${opts.base}...HEAD`], { cwd })).stdout;
  if (opts.cached) return (await runCommand("git", ["diff", "--cached"], { cwd })).stdout;
  const againstHead = await runCommand("git", ["diff", "HEAD"], { cwd });
  if (againstHead.exitCode === 0) return againstHead.stdout;
  const staged = await runCommand("git", ["diff", "--cached"], { cwd });
  const unstaged = await runCommand("git", ["diff"], { cwd });
  return [staged.stdout, unstaged.stdout].filter((d) => d.trim()).join("\n");
}

/**
 * Get a short diff stat for size estimation.
 * @param {string} cwd
 * @param {{ base?: string, cached?: boolean }} opts
 * @returns {Promise<string>}
 */
export async function getDiffStat(cwd, opts = {}) {
  const args = ["diff", "--shortstat"];
  if (opts.base) {
    args.push(`${opts.base}...HEAD`);
  } else if (opts.cached) {
    args.push("--cached");
  }
  const { stdout } = await runCommand("git", args, { cwd });
  return stdout.trim();
}

/**
 * Get git status (short format).
 * @param {string} cwd
 * @returns {Promise<string>}
 */
export async function getStatus(cwd) {
  const { stdout } = await runCommand(
    "git",
    ["status", "--short", "--untracked-files=all"],
    { cwd }
  );
  return stdout.trim();
}

/**
 * Get the list of changed files: the branch's files against `base`, or the
 * working tree's tracked changes against HEAD plus untracked files.
 * @param {string} cwd
 * @param {{ base?: string }} opts
 * @returns {Promise<string[]>}
 */
export async function getChangedFiles(cwd, opts = {}) {
  const lines = (out) => out.trim().split("\n").map((l) => l.trim()).filter(Boolean);
  if (opts.base) return lines((await runCommand("git", ["diff", "--name-only", `${opts.base}...HEAD`], { cwd })).stdout);
  let tracked = await runCommand("git", ["diff", "--name-only", "HEAD"], { cwd });
  if (tracked.exitCode !== 0) tracked = await runCommand("git", ["diff", "--name-only", "--cached"], { cwd });
  const untracked = await runCommand("git", ["ls-files", "--others", "--exclude-standard"], { cwd });
  return [...new Set([...lines(tracked.stdout), ...lines(untracked.stdout)])];
}
