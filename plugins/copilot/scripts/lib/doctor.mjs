// Environment diagnostics for the Copilot plugin ("doctor").
// runDiagnostics collects independent environment checks; every check captures
// its own error so a report object is always produced (never throws). The
// result is plain serializable data — formatDoctorReport renders it for
// humans / MCP tool content.

import fs from "node:fs";
import { stateRoot, loadState } from "./state.mjs";
import { getCopilotVersion, detectAuth, discardEmptySession } from "./copilot-bin.mjs";
import { isProcessAlive } from "./process-identity.mjs";

const STATUS_TAG = { pass: "PASS", warn: "WARN", fail: "FAIL", skip: "SKIP" };

/** Oldest Copilot CLI release the ACP integration was verified against. */
export const MIN_COPILOT_VERSION = "1.0.102";

/**
 * Compare dotted versions numerically ("1.0.102" vs "1.0.100").
 * @returns {number} <0, 0, >0
 */
export function compareVersions(a, b) {
  const pa = String(a).split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0);
  const pb = String(b).split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Run all plugin health checks and aggregate them into one report.
 * Never throws: each check catches its own error into a "fail" entry.
 * @param {object} [opts]
 * @param {string} [opts.cwd] - workspace path (state root, ACP probe cwd)
 * @param {object|null} [opts.config] - parsed models.json
 * @param {boolean} [opts.checkBinaries=true] - probe the copilot binary and the ACP handshake
 * @returns {Promise<{ ok: boolean, platform: string, node: string, checks: Array<{name:string,status:"pass"|"warn"|"fail"|"skip",detail?:string}> }>}
 */
export async function runDiagnostics({ cwd = process.cwd(), config = null, checkBinaries = true } = {}) {
  const checks = [];
  const add = (name, status, detail) => {
    checks.push(detail == null ? { name, status } : { name, status, detail });
  };
  const guarded = async (name, fn) => {
    try {
      await fn();
    } catch (err) {
      add(name, "fail", err?.message ? String(err.message) : String(err));
    }
  };

  // 1. copilot binary
  let version = null;
  if (!checkBinaries) {
    add("copilot-binary", "skip");
  } else {
    await guarded("copilot-binary", async () => {
      version = await getCopilotVersion();
      if (!version) throw new Error("copilot CLI not found (install: npm i -g @github/copilot or brew install --cask copilot-cli)");
      if (compareVersions(version, MIN_COPILOT_VERSION) < 0) {
        add("copilot-binary", "warn", `copilot ${version} is older than ${MIN_COPILOT_VERSION}, the oldest release this plugin was verified against — run \`copilot update\``);
      } else {
        add("copilot-binary", "pass", `copilot ${version}`);
      }
    });
  }

  // 2. node runtime version
  await guarded("node-version", () => {
    const major = Number.parseInt(String(process.versions.node).split(".")[0], 10);
    if (major >= 18) add("node-version", "pass", `node ${process.version}`);
    else add("node-version", "fail", `node ${process.version} unsupported (need >=18.18)`);
  });

  // 3. authentication (best effort, offline)
  await guarded("auth", () => {
    const auth = detectAuth();
    if (auth.source === "env") add("auth", "pass", `token from ${auth.variable}`);
    else if (auth.source === "login") add("auth", "pass", `logged in as ${auth.login}`);
    else add("auth", "warn", "no Copilot login found — run `copilot login` (or set COPILOT_GITHUB_TOKEN)");
  });

  // 4. ACP handshake + live model catalog
  if (!checkBinaries || !version) {
    add("acp", "skip", version ? undefined : "copilot binary unavailable");
  } else {
    await guarded("acp", async () => {
      const { startCopilotSession } = await import("../../mcp/lib/copilot-session.mjs");
      const { rememberLiveCatalog, buildCatalog, normalizeLiveModels, resolveSelection } = await import("../../mcp/lib/catalog.mjs");
      const started = Date.now();
      let session = null;
      try {
        session = await startCopilotSession({ cwd });
        rememberLiveCatalog(session.models);
        const catalog = buildCatalog(config ?? {}, normalizeLiveModels(session.models));
        add("acp", "pass", `session/new ok in ${Date.now() - started}ms — ${catalog.models.length} selectable model(s), default ${session.model ?? "?"}`);
        try {
          const sel = resolveSelection({}, catalog.models, config ?? {});
          add("default-model", "pass", `${sel.model.id} (tier ${sel.model.tier}${sel.model.multiplier != null ? `, ${sel.model.multiplier}x` : ""})${sel.effort ? ` effort ${sel.effort}` : ""}`);
        } catch (err) {
          add("default-model", "fail", err.message);
        }
      } finally {
        if (session) {
          await session.close({ graceMs: 1000 }).catch(() => {});
          discardEmptySession(session.id);
        }
      }
    });
  }

  // 5. live workers recorded as running
  await guarded("workers", () => {
    const running = (loadState(cwd).jobs ?? []).filter((j) => j.type === "delegate" && j.status === "running");
    if (running.length === 0) {
      add("workers", "pass", "no delegate job running in this workspace");
      return;
    }
    const alive = running.filter((j) => isProcessAlive(j.workerPid));
    const dead = running.length - alive.length;
    add(
      "workers",
      dead > 0 ? "warn" : "pass",
      `${alive.length} running worker(s)${dead > 0 ? `, ${dead} job(s) marked running without a live worker (wait on them to settle, or shutdown)` : ""}`
    );
  });

  // 6. state directory readable/writable
  await guarded("state-dir", () => {
    const root = stateRoot(cwd);
    fs.mkdirSync(root, { recursive: true });
    const state = loadState(cwd);
    if (!state || !Array.isArray(state.jobs)) throw new Error(`state at ${root} malformed (missing jobs array)`);
    add("state-dir", "pass", root);
  });

  // 7. disk hygiene preview: what the TTL reaper WOULD clean right now
  // (dry run — nothing is removed by doctor).
  await guarded("hygiene", async () => {
    const { sweepStateDirs } = await import("./hygiene.mjs");
    const p = sweepStateDirs({ dryRun: true });
    if (p.errors.length > 0) {
      add("hygiene", "warn", `sweep errors: ${p.errors.slice(0, 3).join("; ")}`);
      return;
    }
    const dirt = p.removedDirs.length + p.removedJobFiles.length + p.removedTmpFiles.length + p.removedReports.length;
    if (dirt === 0) {
      add("hygiene", "pass", `clean (${p.scanned} workspace dir(s), ${p.keptDirs} active kept)`);
    } else {
      add(
        "hygiene",
        "pass",
        `${dirt} item(s) past TTL will be cleaned on next sweep: ${p.removedDirs.length} state dir(s), ${p.removedJobFiles.length} job file(s), ${p.removedTmpFiles.length} tmp leftover(s), ${p.removedReports.length} report(s)`
      );
    }
  });

  return { ok: !checks.some((c) => c.status === "fail"), platform: process.platform, node: process.version, checks };
}

/**
 * Render a doctor report as human-readable multi-line text.
 * @param {{ ok: boolean, checks: Array<{name:string,status:string,detail?:string}> }} report
 * @returns {string}
 */
export function formatDoctorReport(report) {
  const list = Array.isArray(report.checks) ? report.checks : [];
  const bad = report.ok === false || list.some((c) => c.status === "fail");
  const lines = [`copilot plugin doctor — ${bad ? "PROBLEMS FOUND" : "ok"}`];
  for (const check of list) {
    const tag = STATUS_TAG[check.status] ?? String(check.status ?? "?").toUpperCase();
    lines.push(check.detail != null ? `[${tag}] ${check.name}: ${check.detail}` : `[${tag}] ${check.name}`);
  }
  return lines.join("\n");
}
