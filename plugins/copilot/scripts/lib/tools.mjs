// Names Claude Code gives this plugin's MCP tools.
//
// Claude Code qualifies plugin MCP tools as mcp__plugin_<plugin>_<server>__<tool>;
// the plugin is "copilot" and the server key in .mcp.json is "cp". Hooks and
// advice strings go through here so the model is always told a name it can
// actually call.

export const TOOL_PREFIX = "mcp__plugin_copilot_cp__";

/**
 * Fully-qualified name of one of this server's tools.
 * @param {string} tool - bare tool name, e.g. "delegate"
 * @returns {string}
 */
export function toolRef(tool) {
  return `${TOOL_PREFIX}${tool}`;
}

/**
 * Whether a qualified tool name is one of the given tools of this server.
 * @param {string} name - the `tool_name` a hook received
 * @param {string[]} tools - bare tool names to accept
 * @returns {boolean}
 */
export function matchesTool(name, tools) {
  if (typeof name !== "string" || !name.startsWith(TOOL_PREFIX)) return false;
  return tools.includes(name.slice(TOOL_PREFIX.length));
}
