// Worker-side skill digests.
// Claude Code injects the `skills:` listed in an agent's frontmatter into that
// subagent when it runs. A delegated Copilot worker never sees this plugin's
// skills (they are written for the Claude Code supervisor, and the worker runs
// in its own CLI process), so the guidance a task needs crosses the
// delegation boundary as plain prompt text:
//   - default: DEFAULT_BUILDER_SKILLS / DEFAULT_REVIEWER_SKILLS are appended to
//     every builder / reviewer prompt;
//   - per call: delegate/fanOut accept an opt-in `skills` argument.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SKILLS_DIR = path.join(__dirname, "..", "..", "skills");

/** Skill names shipped with the plugin (directory names under skills/). */
export const SKILL_NAMES = [
  "copilot-delegation",
  "copilot-routing",
  "copilot-prompting",
  "copilot-result-handling",
  "copilot-runtime",
];

/** Skills appended to every builder prompt. */
export const DEFAULT_BUILDER_SKILLS = [];
/** Skills appended to every reviewer prompt. */
export const DEFAULT_REVIEWER_SKILLS = [];
/** Upper bound for per-call skill lists (prompt-token hygiene). */
export const MAX_SKILLS_PER_CALL = 3;

const CACHE_TTL_MS = 10 * 60 * 1000;

/** @type {Map<string, { mtimeMs: number, loadedAt: number, body: string }>} */
const caches = new Map();

function stripFrontmatter(text) {
  if (!text.startsWith("---")) return text;
  const end = text.indexOf("\n---", 3);
  if (end === -1) return text;
  return text.slice(end + 4).replace(/^\s+/, "");
}

/**
 * Read a skill's markdown body (frontmatter stripped), cached by mtime like
 * the model catalog.
 * @param {string} name - one of SKILL_NAMES
 * @returns {string}
 */
export function loadSkillBody(name) {
  if (!SKILL_NAMES.includes(name)) {
    throw Object.assign(
      new Error(`unknown skill "${name}"; available: ${SKILL_NAMES.join("|")}`),
      { code: "SKILL_INVALID" }
    );
  }
  const file = path.join(SKILLS_DIR, name, "SKILL.md");
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    throw Object.assign(new Error(`skill "${name}" is missing its SKILL.md (${file})`), {
      code: "SKILL_UNAVAILABLE",
    });
  }
  const cached = caches.get(name);
  if (cached && cached.mtimeMs === stat.mtimeMs && Date.now() - cached.loadedAt < CACHE_TTL_MS) {
    return cached.body;
  }
  const body = stripFrontmatter(fs.readFileSync(file, "utf8")).trim();
  caches.set(name, { mtimeMs: stat.mtimeMs, loadedAt: Date.now(), body });
  return body;
}

/**
 * Validate and normalize a caller-supplied skill list: array of known names,
 * deduplicated, capped at MAX_SKILLS_PER_CALL.
 * @param {unknown} value
 * @param {{ label?: string }} [opts]
 * @returns {string[]}
 */
export function resolveSkillNames(value, { label = "skills" } = {}) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.some((s) => typeof s !== "string")) {
    throw Object.assign(new Error(`${label} must be an array of skill names`), {
      code: "SKILL_INVALID",
    });
  }
  const unique = [...new Set(value)];
  if (unique.length > MAX_SKILLS_PER_CALL) {
    throw Object.assign(
      new Error(`${label} supports at most ${MAX_SKILLS_PER_CALL} skills per call`),
      { code: "SKILL_TOO_MANY" }
    );
  }
  for (const name of unique) {
    if (!SKILL_NAMES.includes(name)) {
      throw Object.assign(
        new Error(`${label}: unknown skill "${name}"; available: ${SKILL_NAMES.join("|")}`),
        { code: "SKILL_INVALID" }
      );
    }
  }
  return unique;
}

/**
 * Render skill bodies as a compact prompt section. Unreadable skills are
 * flagged inline instead of failing the delegation (a broken install must not
 * take down unrelated work).
 * @param {string[]} names
 * @param {{ label?: string }} [opts]
 * @returns {string} empty string when no skill applies
 */
export function renderSkillDigest(names, { label = "PLUGIN SKILLS" } = {}) {
  if (!Array.isArray(names) || names.length === 0) return "";
  const parts = [`[${label}] Follow these operating notes alongside the task:`];
  for (const name of names) {
    let body;
    try {
      body = loadSkillBody(name);
    } catch (err) {
      parts.push(`# ${name}\n(unavailable: ${err.message})`);
      continue;
    }
    parts.push(`# ${name}\n${body}`);
  }
  return parts.join("\n\n");
}
