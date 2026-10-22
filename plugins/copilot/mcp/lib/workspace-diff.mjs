// Git workspace snapshots for the delegation runtime.
//
// Before a delegated task starts we record the workspace's HEAD commit; when
// supervision wants to know what the agent changed, `git diff` against that
// base plus `git status --porcelain` gives the answer without any manual git.
// Every function is best-effort and never throws.

import { execFileSync } from "node:child_process";

const GIT_TIMEOUT_MS = 10_000;

function runGit(cwd, args) {
  try {
    return {
      ok: true,
      out: execFileSync("git", ["-C", cwd, ...args], {
        encoding: "utf8",
        timeout: GIT_TIMEOUT_MS,
        windowsHide: true,
        // git writes "fatal: not a git repository" to stderr on probes; never
        // let it leak to our stdio (an MCP server must keep stderr clean).
        stdio: ["ignore", "pipe", "pipe"],
      }),
    };
  } catch (err) {
    return { ok: false, reason: err?.message ?? String(err) };
  }
}

/**
 * Record the current HEAD of a workspace (or null when it is not a git
 * repository / has no commits yet). Store the returned value on the job
 * record so a later `diff` call can compare against it.
 * @param {string} cwd
 * @returns {string|null}
 */
export function snapshotGitHead(cwd) {
  const res = runGit(cwd, ["rev-parse", "HEAD"]);
  return res.ok ? res.out.trim() || null : null;
}

/**
 * Describe what changed in a workspace since a snapshot.
 * @param {string} cwd
 * @param {{ base?: string|null }} [opts] - HEAD sha recorded before delegation
 * @returns {{
 *   isRepo: boolean,
 *   base: string|null,
 *   clean: boolean,
 *   stat: string|null,
 *   files: string[],
 *   note?: string,
 * }}
 */
export function diffSinceSnapshot(cwd, opts = {}) {
  const base = typeof opts.base === "string" && opts.base ? opts.base : null;
  const head = runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (!head.ok || head.out.trim() !== "true") {
    return {
      isRepo: false,
      base,
      clean: true,
      stat: null,
      files: [],
      note: "workspace is not a git repository",
    };
  }

  // Tracked changes (staged + unstaged) relative to the recorded base
  // (or current HEAD when no snapshot exists).
  const diffBase = base ?? "HEAD";
  const statRes = runGit(cwd, ["diff", "--stat", diffBase]);
  const nameOnly = runGit(cwd, ["diff", "--name-only", diffBase]);

  // Untracked files never appear in `git diff`; porcelain lists them (??).
  // --untracked-files=all names each new file instead of collapsing a new
  // directory into "src/", which is what a blast-radius check needs.
  const statusRes = runGit(cwd, ["status", "--porcelain=v1", "--untracked-files=all"]);

  const trackedFiles = nameOnly.ok
    ? nameOnly.out.split("\n").map((l) => l.trim()).filter(Boolean)
    : [];
  const statusFiles = statusRes.ok
    ? statusRes.out.split("\n").map((l) => l.slice(3).trim()).filter(Boolean)
    : [];
  const files = [...new Set([...trackedFiles, ...statusFiles])];

  return {
    isRepo: true,
    base,
    clean: files.length === 0,
    stat: statRes.ok && statRes.out.trim() ? statRes.out.trim() : null,
    files,
    ...(base ? {} : { note: "no snapshot on the job record; diffing against current HEAD" }),
  };
}
