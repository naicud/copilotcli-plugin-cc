#!/usr/bin/env node
// Turn a REAL captured run of demo-delegate.mjs into an animated
// terminal-style SVG. Nothing is invented: the SVG replays the ANSI transcript
// line by line.
//
//   node plugins/copilot/scripts/demo-delegate.mjs > /tmp/cp-capture.log
//   node plugins/copilot/scripts/make-demo-svg.mjs /tmp/cp-capture.log docs/demo.svg [--static]
//
// --static renders every line visible (for checking the layout as an image).

import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const isStatic = args.includes("--static");
const [inputPath = "/tmp/cp-capture.log", outputPath = "docs/demo.svg"] = args.filter((a) => !a.startsWith("--"));

const PALETTE = {
  bg: "#0d1117",
  bar: "#161b22",
  border: "#30363d",
  fg: "#e6edf3",
  dim: "#7d8590",
  green: "#3fb950",
  yellow: "#d29922",
  cyan: "#79c0ff",
  red: "#f85149",
};

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Split one ANSI line into styled spans. */
function parseAnsi(line) {
  const spans = [];
  let cls = "fg";
  let bold = false;
  let buf = "";
  const flush = () => {
    if (buf) spans.push({ cls: bold ? `${cls} b` : cls, text: buf });
    buf = "";
  };
  const re = /\x1b\[([0-9;]*)m/g;
  let last = 0;
  let m;
  while ((m = re.exec(line))) {
    buf += line.slice(last, m.index);
    flush();
    for (const c of m[1].split(";").map(Number)) {
      if (c === 0) {
        cls = "fg";
        bold = false;
      } else if (c === 1) bold = true;
      else if (c === 2) cls = "dim";
      else if (c === 31 || c === 91) cls = "red";
      else if (c === 32 || c === 92) cls = "green";
      else if (c === 33 || c === 93) cls = "yellow";
      else if (c === 36 || c === 96) cls = "cyan";
      else if (c === 39) cls = "fg";
    }
    last = re.lastIndex;
  }
  buf += line.slice(last);
  flush();
  return spans;
}

const FONT = 13;
const LINE_H = 20;
const PAD_X = 24;
const BAR_H = 40;
// 100 columns fit the 1000px frame even with wide monospace fallbacks (~9.5px/glyph).
const MAX_COLS = 100;

/** Truncate by VISIBLE width, after parsing, so no escape is ever cut. */
function clipSpans(spans) {
  let used = 0;
  const out = [];
  for (const s of spans) {
    const text = s.text.replace(/[\x00-\x1f\x7f]/g, "");
    if (!text) continue;
    const remain = MAX_COLS - used;
    if (text.length > remain) {
      if (remain > 0) out.push({ cls: s.cls, text: `${text.slice(0, remain - 1)}…` });
      return out;
    }
    out.push({ cls: s.cls, text });
    used += text.length;
  }
  return out;
}

const raw = fs.readFileSync(inputPath, "utf8");
const lines = raw.replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, "").split("\n");
while (lines.length && lines.at(-1).trim() === "") lines.pop();
if (!lines.length) {
  console.error("empty capture");
  process.exit(1);
}
const parsed = lines.map((l) => clipSpans(parseAnsi(l)));

const W = 1000;
const H = BAR_H + 18 + (parsed.length + 1) * LINE_H + 22;
const PROMPT = "node plugins/copilot/scripts/demo-delegate.mjs";

let delay = 0.6;
let body = "";
parsed.forEach((spans, i) => {
  const y = BAR_H + 18 + (i + 1) * LINE_H;
  const plain = spans.map((s) => s.text).join("");
  // Section headers and progress frames get a longer beat, like the real run.
  delay += plain.startsWith("▸") ? 0.9 : plain.trimStart().startsWith("↻") ? 0.7 : 0.35;
  const tspans = spans.map((s) => `<tspan class="${s.cls}">${esc(s.text)}</tspan>`).join("");
  const anim = isStatic ? "" : ` class="ln" style="animation-delay:${delay.toFixed(2)}s"`;
  body += `  <text${anim} x="${PAD_X}" y="${y}">${tspans}</text>\n`;
});

const css = `
  text { font: ${FONT}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: pre; }
  .fg { fill: ${PALETTE.fg}; } .dim { fill: ${PALETTE.dim}; } .green { fill: ${PALETTE.green}; }
  .yellow { fill: ${PALETTE.yellow}; } .cyan { fill: ${PALETTE.cyan}; } .red { fill: ${PALETTE.red}; }
  .b { font-weight: 700; }
  .ln { opacity: 0; animation: appear 0.15s ease-out forwards; }
  @keyframes appear { to { opacity: 1; } }`;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Recorded run: Claude's MCP server delegates a task to a GitHub Copilot CLI worker, supervises it live, verifies the result and reports the AI credits used">
  <style>${css}
  </style>
  <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="12" fill="${PALETTE.bg}" stroke="${PALETTE.border}"/>
  <path d="M0.5 12.5 A12 12 0 0 1 12.5 0.5 H${W - 12.5} A12 12 0 0 1 ${W - 0.5} 12.5 V${BAR_H} H0.5 Z" fill="${PALETTE.bar}" stroke="${PALETTE.border}"/>
  <circle cx="22" cy="${BAR_H / 2}" r="6" fill="#ff5f57"/>
  <circle cx="42" cy="${BAR_H / 2}" r="6" fill="#febc2e"/>
  <circle cx="62" cy="${BAR_H / 2}" r="6" fill="#28c840"/>
  <text x="${W / 2}" y="${BAR_H / 2 + 4}" text-anchor="middle" class="dim" style="font-size:12px">copilotcli-plugin-cc — recorded delegation run</text>
  <text x="${PAD_X}" y="${BAR_H + 18}"><tspan class="green b">❯</tspan><tspan class="fg"> ${esc(PROMPT)}</tspan></text>
${body}</svg>
`;

fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
fs.writeFileSync(outputPath, svg);
console.log(`wrote ${outputPath} (${parsed.length} lines, ${(svg.length / 1024).toFixed(1)} KB)`);
