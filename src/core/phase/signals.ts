import type { AdapterTurn, Phase } from '../types.js';

/**
 * Tool names that only read/inspect the repo locally — no edits, no web. Covers both Claude
 * Code's capitalized names and Opencode's lowercase ones (`read`/`grep`/`glob`/`list`) — the two
 * adapters never share a toolcall name, so listing both casings side by side is unambiguous.
 */
export const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'read', 'grep', 'glob', 'list']);

/**
 * Tool names that reach the web (search/fetch/doc lookups). Any toolcall name containing
 * "context7" also counts — MCP server tool names vary by install (e.g.
 * `mcp__plugin_context7_context7__query-docs`), so an exact-name set can't cover them.
 */
export const WEB_TOOLS = new Set(['WebSearch', 'WebFetch', 'webfetch']);

/**
 * Tool names that change files on disk. Mirrors `EDIT_TOOL_NAMES` in
 * `adapter/claude-code/transcript.ts` and the Opencode adapter's own edit-tool set (kept as its
 * own constant here so phase code never depends on either adapter module). `patch` covers
 * Opencode's standalone `patch`-type parts, synthesized by its adapter into `patch`-named
 * toolcalls.
 */
export const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'edit', 'write', 'patch']);

/** Tool names that spawn subagents or manage a task list — signals of planning, not doing. */
export const SPAWN_TOOLS = new Set(['Agent', 'Task', 'TodoWrite', 'task', 'todowrite']);

const CONTEXT7_PATTERN = /context7/i;

function isWebToolName(name: string): boolean {
  return WEB_TOOLS.has(name) || CONTEXT7_PATTERN.test(name);
}

/**
 * True when a turn shows any signal of reaching the web: the adapter-reported `webRequests`
 * counter (CC's `usage.server_tool_use`), or a web-shaped toolcall.
 */
export function hasWebSignal(turn: AdapterTurn): boolean {
  return turn.webRequests > 0 || turn.toolcalls.some((toolcall) => isWebToolName(toolcall.name));
}

/** True when any toolcall in the turn is a file edit. */
export function hasEditSignal(turn: AdapterTurn): boolean {
  return turn.toolcalls.some((toolcall) => toolcall.isEdit);
}

const READING_AGENT_PATTERN = /^explore$/i;
const DEV_AGENT_PATTERN = /^(build|react-dev|go-dev|rust-dev|tauri-dev)$/i;
const REVIEW_AGENT_PATTERN = /(code-review|security-review|seo-page-auditor|review)/i;
const RESEARCH_AGENT_PATTERN = /^(desearch-researcher|desearch-synthesizer)$/i;
const PLANNER_AGENT_PATTERN = /^plan$/i;

/**
 * Maps a run's `agentType` to a phase. Ambiguous or unrecognized types (including the
 * deliberately-generic `general`/`general-purpose`) return undefined so the caller falls
 * through to weaker signals — none of these patterns overlap, so check order doesn't matter.
 * `reading` is returned bare for an Explore-type agent; upgrading it to `research` when the
 * turn itself shows web reach is the caller's job (it needs the per-turn signal, not just the
 * run-level agentType).
 *
 * All patterns are case-insensitive, which already covers Opencode's own (lowercase) agent
 * names without any extra cases: `explore`→reading, `build`→implementation, `plan`→planning;
 * `general` matches none of them and correctly falls through to undefined, same as CC's
 * `general-purpose`.
 */
export function phaseFromAgentType(agentType: string | undefined): Phase | undefined {
  if (agentType === undefined) return undefined;
  if (READING_AGENT_PATTERN.test(agentType)) return 'reading';
  if (DEV_AGENT_PATTERN.test(agentType)) return 'implementation';
  if (REVIEW_AGENT_PATTERN.test(agentType)) return 'review';
  if (RESEARCH_AGENT_PATTERN.test(agentType)) return 'research';
  if (PLANNER_AGENT_PATTERN.test(agentType)) return 'planning';
  return undefined;
}

/**
 * Agent types under a `*-fix` naming convention (e.g. `feedhub-fix`). `phaseFromAgentType`
 * deliberately has no case for these — a `*-fix` agent's turns still look like plain
 * `implementation` at the tool-mix level (edits, no verify), so the fix reclassification lives
 * in `infer.ts`'s impl-vs-fix pass instead, checked directly against the run's own agentType.
 */
export function isFixAgentType(agentType: string | undefined): boolean {
  return agentType !== undefined && /-fix$/i.test(agentType);
}

/**
 * `strong` marks the rules ISSUE #13 keeps trustworthy even for a subagent run: review/verify/fix
 * are deliberate, unambiguous command tags (`code-review`, `security-review`, `verify`,
 * `feedhub-fix`, `autoresearch-fix`, `autoresearch:fix`) that stay true regardless of who's
 * running under them. `research`/`planning` are NOT strong — a subagent inherits its parent's
 * active skill for its whole run, so e.g. an Explore subagent spawned under `/init` would
 * otherwise classify 100% as planning instead of reading (see `phaseFromStrongSkill` below).
 */
const SKILL_RULES: ReadonlyArray<{ pattern: RegExp; phase: Phase; strong: boolean }> = [
  { pattern: /(code-review|security-review|review)/i, phase: 'review', strong: true },
  { pattern: /^verify$/i, phase: 'verify', strong: true },
  { pattern: /(feedhub-fix|autoresearch-fix|autoresearch:fix)/i, phase: 'fix', strong: true },
  { pattern: /(desearch|deep-research|autoresearch)/i, phase: 'research', strong: false },
  { pattern: /(grilling|grill-me|init|writing-plans|brainstorming)/i, phase: 'planning', strong: false },
];

/**
 * Maps an active turn `skill` to a phase. Order matters: the fix-flavoured autoresearch skills
 * (`autoresearch-fix`, `autoresearch:fix`) must be checked before the generic `autoresearch*`
 * research rule, or they'd be swallowed by it. Main-loop runs only — see `phaseFromStrongSkill`
 * for the subagent-safe subset.
 */
export function phaseFromSkill(skill: string | undefined): Phase | undefined {
  if (skill === undefined) return undefined;
  for (const rule of SKILL_RULES) {
    if (rule.pattern.test(skill)) return rule.phase;
  }
  return undefined;
}

/**
 * ISSUE #13: same mapping as `phaseFromSkill`, restricted to the `strong` review/verify/fix rules
 * — the only skill signal a SUBAGENT run should let override its own `agentType`/tool-mix. A
 * skill tag is an attribute of the whole (possibly hours-long) main-loop session, inherited
 * unchanged by every subagent spawned under it; trusting it for `research`/`planning` too would
 * let one main-loop command eclipse every subagent's own, more specific signal.
 */
export function phaseFromStrongSkill(skill: string | undefined): Phase | undefined {
  if (skill === undefined) return undefined;
  for (const rule of SKILL_RULES) {
    if (rule.strong && rule.pattern.test(skill)) return rule.phase;
  }
  return undefined;
}

/**
 * Classifies a turn purely from its own toolcalls + verify/web signals, independent of any
 * skill/agentType label. Priority: web reach > local-read-only > verify-bash-without-edit >
 * edit-present > spawn/todo-only. Returns undefined when none of these match (e.g. a plain text
 * turn with no toolcalls at all), leaving the decision to `inferPhases`'s last-resort default.
 */
export function phaseFromToolMix(turn: AdapterTurn): Phase | undefined {
  if (hasWebSignal(turn)) return 'research';

  const hasEdit = hasEditSignal(turn);
  const allReadOnly = turn.toolcalls.length > 0 && turn.toolcalls.every((toolcall) => READ_TOOLS.has(toolcall.name));
  if (!hasEdit && allReadOnly) return 'reading';

  if (turn.hadVerify && !hasEdit) return 'verify';
  if (hasEdit) return 'implementation';

  const hasSpawnOrTodo = turn.toolcalls.some((toolcall) => SPAWN_TOOLS.has(toolcall.name));
  if (hasSpawnOrTodo) return 'planning';

  return undefined;
}
