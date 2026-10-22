import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createTmpDir, cleanupTmpDir } from "./helpers.mjs";
import {
  sweepStateDirs,
  stateTtlMsFromEnv,
  reportTtlMsFromEnv,
  DEFAULT_STATE_TTL_MS,
  DEFAULT_REPORT_TTL_MS,
} from "../plugins/copilot/scripts/lib/hygiene.mjs";

let base;
let wsRoot;
const DAY = 24 * 60 * 60 * 1000;

function makeHashDir(name) {
  const dir = path.join(base, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function age(p, days) {
  const t = new Date(Date.now() - days * DAY);
  fs.utimesSync(p, t, t);
}

beforeEach(() => {
  base = createTmpDir("hygiene-base");
  wsRoot = createTmpDir("hygiene-ws");
});

afterEach(() => {
  cleanupTmpDir(base);
  cleanupTmpDir(wsRoot);
});

describe("hygiene sweepStateDirs", () => {
  it("removes a whole stale workspace dir with no live worker", () => {
    const dir = makeHashDir("aaaa1111");
    fs.writeFileSync(path.join(dir, "state.json"), '{"jobs":[]}');
    age(path.join(dir, "state.json"), 20);
    const res = sweepStateDirs({ baseDir: base, now: new Date(), stateTtlMs: 14 * DAY, reportTtlMs: null });
    assert.equal(res.removedDirs.length, 1);
    assert.ok(!fs.existsSync(dir));
    assert.equal(res.errors.length, 0);
  });

  it("keeps a fresh workspace dir", () => {
    const dir = makeHashDir("bbbb2222");
    fs.writeFileSync(path.join(dir, "state.json"), '{"jobs":[]}');
    const res = sweepStateDirs({ baseDir: base, now: new Date(), stateTtlMs: 14 * DAY, reportTtlMs: null });
    assert.deepEqual(res.removedDirs, []);
    assert.equal(res.keptDirs, 1);
    assert.ok(fs.existsSync(dir));
  });

  it("a live worker freezes an ancient dir; a dead worker pid does not", () => {
    const liveDir = makeHashDir("cccc3333");
    fs.writeFileSync(path.join(liveDir, "state.json"), JSON.stringify({ jobs: [{ id: "delegate-a", status: "running", workerPid: 111 }] }));
    const deadDir = makeHashDir("dddd4444");
    fs.writeFileSync(path.join(deadDir, "state.json"), JSON.stringify({ jobs: [{ id: "delegate-b", status: "running", workerPid: 222 }] }));
    for (const d of [liveDir, deadDir]) {
      age(path.join(d, "state.json"), 90);
      age(d, 90);
    }

    const res = sweepStateDirs({
      baseDir: base,
      now: new Date(),
      stateTtlMs: 14 * DAY,
      reportTtlMs: null,
      isAlive: (pid) => pid === 111,
    });
    assert.ok(fs.existsSync(liveDir), "live-worker dir must survive despite age");
    assert.ok(!fs.existsSync(deadDir), "dead-pid dir must be swept");
    assert.equal(res.removedDirs.length, 1);
  });

  it("prunes orphaned job files inside a kept dir, never referenced ones", () => {
    const dir = makeHashDir("eeee5555");
    const jobsDir = path.join(dir, "jobs");
    fs.mkdirSync(jobsDir);
    fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ jobs: [{ id: "task-keep" }] }));
    fs.writeFileSync(path.join(jobsDir, "task-keep.log"), "keep me");
    fs.writeFileSync(path.join(jobsDir, "task-gone.log"), "orphan");
    fs.writeFileSync(path.join(jobsDir, "task-gone.json"), "{}");
    age(path.join(jobsDir, "task-gone.log"), 20);
    age(path.join(jobsDir, "task-gone.json"), 20);
    age(path.join(jobsDir, "task-keep.log"), 20);

    const res = sweepStateDirs({ baseDir: base, now: new Date(), stateTtlMs: 14 * DAY, reportTtlMs: null });
    assert.deepEqual(res.removedJobFiles.sort(), ["task-gone.json", "task-gone.log"]);
    assert.ok(fs.existsSync(path.join(jobsDir, "task-keep.log")));
  });

  it("never touches young files even when orphaned (spawn-race safety)", () => {
    const dir = makeHashDir("ffff6666");
    const jobsDir = path.join(dir, "jobs");
    fs.mkdirSync(jobsDir);
    fs.writeFileSync(path.join(dir, "state.json"), '{"jobs":[]}');
    fs.writeFileSync(path.join(jobsDir, "task-new.log"), "just born");
    const res = sweepStateDirs({ baseDir: base, now: new Date(), stateTtlMs: 14 * DAY, reportTtlMs: null });
    assert.deepEqual(res.removedJobFiles, []);
    assert.ok(fs.existsSync(path.join(jobsDir, "task-new.log")));
  });

  it("removes crash-leftover .tmp.* files past the TTL", () => {
    const dir = makeHashDir("aaaa7777");
    const jobsDir = path.join(dir, "jobs");
    fs.mkdirSync(jobsDir);
    fs.writeFileSync(path.join(dir, "state.json.tmp.999"), "{}");
    fs.writeFileSync(path.join(jobsDir, "task-x.json.tmp.999"), "{}");
    age(path.join(dir, "state.json.tmp.999"), 20);
    age(path.join(jobsDir, "task-x.json.tmp.999"), 20);
    fs.writeFileSync(path.join(dir, "state.json"), '{"jobs":[]}');

    const res = sweepStateDirs({ baseDir: base, now: new Date(), stateTtlMs: 14 * DAY, reportTtlMs: null });
    assert.equal(res.removedTmpFiles.length, 2);
    assert.equal(fs.readdirSync(jobsDir).length, 0);
  });

  it("removes base-level crash leftovers (activity-buffer.json.tmp.*) but never the buffer itself", () => {
    fs.writeFileSync(path.join(base, "activity-buffer.json.tmp.4242"), "{}");
    fs.writeFileSync(path.join(base, "activity-buffer.json"), "{}");
    age(path.join(base, "activity-buffer.json.tmp.4242"), 20);
    const res = sweepStateDirs({ baseDir: base, now: new Date(), stateTtlMs: 14 * DAY, reportTtlMs: null });
    assert.ok(res.removedTmpFiles.includes("activity-buffer.json.tmp.4242"));
    assert.ok(!fs.existsSync(path.join(base, "activity-buffer.json.tmp.4242")));
    assert.ok(fs.existsSync(path.join(base, "activity-buffer.json")), "live buffer must survive");
  });

  describe("report reaper", () => {
    function workspaceWithReport(name, jobStatus) {
      const ws = path.join(wsRoot, `ws-${name}`);
      fs.mkdirSync(path.join(ws, ".cp-reports"), { recursive: true });
      const report = path.join(ws, ".cp-reports", `delegate-${name}.md`);
      fs.writeFileSync(report, `STATUS: COMPLETED\n${name}`);
      const dir = makeHashDir(`hash-${name}`);
      fs.writeFileSync(
        path.join(dir, "state.json"),
        JSON.stringify({ jobs: [{ id: `delegate-${name}`, directory: ws, status: jobStatus }] })
      );
      return { ws, report };
    }

    it("deletes consumed old reports in known workspaces only, then the empty dir", () => {
      const { ws, report } = workspaceWithReport("old1", "completed");
      age(report, 10);
      const res = sweepStateDirs({ baseDir: base, now: new Date(), stateTtlMs: 14 * DAY, reportTtlMs: 7 * DAY });
      assert.deepEqual(res.removedReports, [report]);
      assert.ok(!fs.existsSync(report));
      assert.ok(!fs.existsSync(path.join(ws, ".cp-reports")), "empty .cp-reports dir removed");
      assert.ok(fs.existsSync(ws), "the workspace itself is NEVER touched");
    });

    it("keeps fresh reports and workspaces with running jobs", () => {
      const fresh = workspaceWithReport("fresh", "completed");
      const running = workspaceWithReport("runningjob", "running");
      age(running.report, 30);
      const res = sweepStateDirs({ baseDir: base, now: new Date(), stateTtlMs: 14 * DAY, reportTtlMs: 7 * DAY });
      assert.deepEqual(res.removedReports, []);
      assert.ok(fs.existsSync(fresh.report));
      assert.ok(fs.existsSync(running.report));
    });

    it("reportTtlMs:null disables report cleanup entirely", () => {
      const { report } = workspaceWithReport("off", "completed");
      age(report, 365);
      const res = sweepStateDirs({ baseDir: base, now: new Date(), stateTtlMs: 14 * DAY, reportTtlMs: null });
      assert.deepEqual(res.removedReports, []);
      assert.ok(fs.existsSync(report));
    });

    it("ignores unknown workspaces (only plugin-known paths are swept)", () => {
      const stranger = path.join(wsRoot, "stranger-ws");
      fs.mkdirSync(path.join(stranger, ".cp-reports"), { recursive: true });
      const report = path.join(stranger, ".cp-reports", "x.md");
      fs.writeFileSync(report, "not ours");
      age(report, 400);
      const res = sweepStateDirs({ baseDir: base, now: new Date(), stateTtlMs: 14 * DAY, reportTtlMs: 7 * DAY });
      assert.deepEqual(res.removedReports, []);
      assert.ok(fs.existsSync(report));
    });
  });

  it("dryRun counts everything and deletes nothing", () => {
    const dir = makeHashDir("aaaa8888");
    fs.writeFileSync(path.join(dir, "state.json"), '{"jobs":[]}');
    age(path.join(dir, "state.json"), 40);
    const res = sweepStateDirs({
      baseDir: base,
      now: new Date(),
      stateTtlMs: 14 * DAY,
      reportTtlMs: null,
      dryRun: true,
    });
    assert.equal(res.removedDirs.length, 1);
    assert.ok(fs.existsSync(dir), "dry run must not delete");
  });

  it("refuses to sweep / or the home directory root itself", async () => {
    const os = await import("node:os");
    for (const dangerous of [os.homedir()]) {
      const res = sweepStateDirs({ baseDir: dangerous, now: new Date(), stateTtlMs: 14 * DAY, reportTtlMs: null });
      assert.match(res.errors[0], /refusing to sweep unsafe root/);
      assert.equal(res.scanned, 0);
    }
  });

  it("env knobs parse: defaults, overrides and disable-by-zero", () => {
    delete process.env.CP_STATE_TTL_DAYS;
    delete process.env.CP_REPORT_TTL_DAYS;
    assert.equal(stateTtlMsFromEnv(), DEFAULT_STATE_TTL_MS);
    assert.equal(reportTtlMsFromEnv(), DEFAULT_REPORT_TTL_MS);
    process.env.CP_STATE_TTL_DAYS = "3";
    process.env.CP_REPORT_TTL_DAYS = "0";
    assert.equal(stateTtlMsFromEnv(), 3 * DAY);
    assert.equal(reportTtlMsFromEnv(), null);
    process.env.CP_STATE_TTL_DAYS = "0";
    assert.equal(stateTtlMsFromEnv(), null, "0 disables the whole sweep");
    delete process.env.CP_STATE_TTL_DAYS;
    delete process.env.CP_REPORT_TTL_DAYS;
  });

  it("reaps abandoned cp-e2e/cp-demo/cp-bench temp workspaces in tmpdir", async () => {
    const os = await import("node:os");
    const tmpRoot = createTmpDir("hygiene-tmp");
    const stale = path.join(tmpRoot, "cp-e2e-abcd");
    const fresh = path.join(tmpRoot, "cp-demo-efgh");
    const foreign = path.join(tmpRoot, "not-ours-e2e-");
    fs.mkdirSync(stale);
    fs.mkdirSync(fresh);
    fs.mkdirSync(foreign);
    age(path.join(stale), 30);
    const res = sweepStateDirs({
      baseDir: base,
      now: new Date(),
      stateTtlMs: 14 * DAY,
      reportTtlMs: null,
      tmpDir: tmpRoot,
    });
    assert.ok(res.removedDirs.includes("cp-e2e-abcd"), "stale dev workspace reaped");
    assert.ok(!fs.existsSync(stale));
    assert.ok(fs.existsSync(fresh), "fresh dev workspace survives");
    assert.ok(fs.existsSync(foreign), "non-plugin dirs never touched");

    // dryRun leaves everything in place
    const dry = sweepStateDirs({
      baseDir: base,
      now: new Date(),
      stateTtlMs: 14 * DAY,
      reportTtlMs: null,
      tmpDir: tmpRoot,
      dryRun: true,
    });
    cleanupTmpDir(tmpRoot);
    assert.ok(Array.isArray(dry.removedDirs));
  });
});
