import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createTmpDir, cleanupTmpDir } from "./helpers.mjs";
import { runCommand } from "../plugins/copilot/scripts/lib/process.mjs";
import { getGitRoot, getCurrentBranch, getStatus, getDiff, getChangedFiles } from "../plugins/copilot/scripts/lib/git.mjs";

let tmpDir;

beforeEach(async () => {
  tmpDir = createTmpDir("git-test");
  // Initialize a git repo
  await runCommand("git", ["init"], { cwd: tmpDir });
  await runCommand("git", ["config", "user.email", "test@test.com"], { cwd: tmpDir });
  await runCommand("git", ["config", "user.name", "Test"], { cwd: tmpDir });
  // Create initial commit
  fs.writeFileSync(path.join(tmpDir, "README.md"), "# Test\n");
  await runCommand("git", ["add", "."], { cwd: tmpDir });
  await runCommand("git", ["commit", "-m", "init"], { cwd: tmpDir });
});

afterEach(() => {
  cleanupTmpDir(tmpDir);
});

describe("git", () => {
  it("getGitRoot returns the repo root", async () => {
    const root = await getGitRoot(tmpDir);
    assert.ok(root);
    assert.ok(root.length > 0);
  });

  it("getCurrentBranch returns branch name", async () => {
    const branch = await getCurrentBranch(tmpDir);
    assert.ok(branch === "main" || branch === "master");
  });

  it("getStatus returns empty for clean repo", async () => {
    const status = await getStatus(tmpDir);
    assert.equal(status, "");
  });

  it("getStatus shows untracked files", async () => {
    fs.writeFileSync(path.join(tmpDir, "new-file.txt"), "hello\n");
    const status = await getStatus(tmpDir);
    assert.ok(status.includes("new-file.txt"));
  });

  it("working-tree review covers staged, unstaged and untracked changes", async () => {
    fs.writeFileSync(path.join(tmpDir, "README.md"), "# Test\nstaged line\n");
    await runCommand("git", ["add", "README.md"], { cwd: tmpDir });
    fs.writeFileSync(path.join(tmpDir, "README.md"), "# Test\nstaged line\nunstaged line\n");
    fs.writeFileSync(path.join(tmpDir, "new.js"), "x\n");
    const diff = await getDiff(tmpDir);
    assert.match(diff, /\+staged line/);
    assert.match(diff, /\+unstaged line/);
    assert.deepEqual((await getChangedFiles(tmpDir)).sort(), ["README.md", "new.js"]);
  });

  it("branch review diffs base...HEAD only", async () => {
    await runCommand("git", ["checkout", "-q", "-b", "feature"], { cwd: tmpDir });
    fs.writeFileSync(path.join(tmpDir, "feature.js"), "f\n");
    await runCommand("git", ["add", "."], { cwd: tmpDir });
    await runCommand("git", ["commit", "-q", "-m", "feature"], { cwd: tmpDir });
    fs.writeFileSync(path.join(tmpDir, "dirty.js"), "d\n");
    const base = (await runCommand("git", ["rev-parse", "HEAD~1"], { cwd: tmpDir })).stdout.trim();
    assert.deepEqual(await getChangedFiles(tmpDir, { base }), ["feature.js"]);
    assert.match(await getDiff(tmpDir, { base }), /feature\.js/);
  });
});
