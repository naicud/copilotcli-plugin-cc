// What a delegated Copilot worker is told, and what it is allowed to do.
//
// Each delegation's first prompt is: persona preamble + work contract (from
// config/models.json, `${cwd}` and `${reportPath}` substituted) + the task +
// optional skill digests + the per-job report path. The persona also decides
// the worker's tool rules: a builder may edit the workspace, a reviewer may
// only write its own report file.

import path from "node:path";

/** Directory (relative to the workspace) holding per-job reports. */
export const REPORTS_DIR = ".cp-reports";

export const PERSONAS = {
  builder: {
    preamble:
      "You are executing a delegated coding task for a supervising agent. Work autonomously: nobody will answer questions mid-task. Make the change, verify it, and write the report the contract below requires.",
  },
  reviewer: {
    preamble:
      "You are a read-only reviewer working for a supervising agent. Do NOT modify any file in the workspace. Your only permitted write is the report file named below. Read the code, run read-only commands if useful, and put your findings in the report.",
  },
};

export const PERSONA_NAMES = Object.keys(PERSONAS);

/**
 * Workspace-relative report path for a job (unique per job, so parallel
 * fan-out tasks in one workspace never overwrite each other's report).
 * @param {string} jobId
 * @returns {string}
 */
export function reportRelPath(jobId) {
  return `${REPORTS_DIR}/${jobId}.md`;
}

/**
 * Absolute report path for a job.
 * @param {string} cwd
 * @param {string} jobId
 * @returns {string}
 */
export function reportPathFor(cwd, jobId) {
  return path.join(cwd, REPORTS_DIR, `${jobId}.md`);
}

/**
 * Substitute the contract placeholders.
 * @param {string} contract
 * @param {string} cwd
 * @param {string} jobId
 * @returns {string}
 */
export function renderContract(contract, cwd, jobId) {
  return String(contract ?? "")
    .replaceAll("${cwd}", cwd)
    .replaceAll("${reportPath}", reportRelPath(jobId));
}

/**
 * Full first prompt for a delegated job.
 * @param {{ contract: string, cwd: string, jobId: string, task: string, persona?: string, skillsDigest?: string }} opts
 * @returns {string}
 */
export function buildWorkerPrompt({ contract, cwd, jobId, task, persona = "builder", skillsDigest = "" }) {
  const preamble = (PERSONAS[persona] ?? PERSONAS.builder).preamble;
  return [
    preamble,
    renderContract(contract, cwd, jobId).trim(),
    "---",
    String(task).trim(),
    skillsDigest ? skillsDigest.trim() : null,
    `[REPORT] Mandatory report path for THIS job: ${reportPathFor(cwd, jobId)} — write it exactly there (this overrides any other report location).`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Nudge sent when a builder turn ended without producing anything.
 * @param {string} cwd
 * @param {string} jobId
 * @returns {string}
 */
export function nudgePrompt(cwd, jobId) {
  return `You ended your turn without producing any output. Carry out the assigned task NOW and write the report to ${reportPathFor(cwd, jobId)} as the contract requires.`;
}

/**
 * Tool rules for a worker: `--allow-tool` / `--deny-tool` patterns passed at
 * spawn, plus the regex rules applied to permission requests the CLI still
 * asks about.
 * @param {string} persona
 * @param {object} permissions - config/models.json `permissions`
 * @returns {{ allowTools: string[], denyTools: string[], rules: { autoApprove: string[], autoReject: string[] } }}
 */
export function workerToolPolicy(persona, permissions = {}) {
  const allowTools = [...(permissions.allowTools ?? [])];
  const denyTools = [...(permissions.denyTools ?? [])];
  const autoApprove = [...(permissions.autoApprove ?? [])];
  const autoReject = [...(permissions.autoReject ?? [])];
  if (persona === "reviewer") {
    // No blanket write grant: every edit surfaces as a permission request.
    // Reject rules are checked first, so the report directory is carved out
    // of the reject rule itself rather than approved after it.
    const writeGrants = new Set(["write", "edit", "create"]);
    const reportFile = `.*[\\\\/]${REPORTS_DIR.replace(".", "\\.")}[\\\\/][^\\\\/]+\\.md$`;
    return {
      allowTools: allowTools.filter((t) => !writeGrants.has(t)),
      denyTools,
      rules: {
        autoApprove: [`^(edit|create|write) ${reportFile}`, ...autoApprove],
        autoReject: [`^(edit|create|write|delete|move) (?!${reportFile})`, ...autoReject],
      },
    };
  }
  return { allowTools, denyTools, rules: { autoApprove, autoReject } };
}
