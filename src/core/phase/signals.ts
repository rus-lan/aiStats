import type { AdapterTurn, Phase } from '../types.js';

/** Tool names that only read/inspect the repo locally — no edits, no web. */
export const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS']);

/**
 * Tool names that reach the web (search/fetch/doc lookups). Any toolcall name containing
 * "context7" also counts — MCP server tool names vary by install (e.g.
 * `mcp__plugin_context7_context7__query-docs`), so an exact-name set can't cover them.
 */
export const WEB_TOOLS = new Set(['WebSearch', 'WebFetch']);

/**
 * Tool names that change files on disk. Mirrors `EDIT_TOOL_NAMES` in
 * `adapter/claude-code/transcript.ts` — kept as its own constant here so phase code never
 * depends on the adapter module, and a future adapter (e.g. Opencode's `patch`/`edit`/`write`
 * parts) can map onto the same set without a cross-import.
 */
export const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/** Tool names that spawn subagents or manage a task list — signals of planning, not doing. */
export const SPAWN_TOOLS = new Set(['Agent', 'Task', 'TodoWrite']);

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

const SKILL_RULES: ReadonlyArray<{ pattern: RegExp; phase: Phase }> = [
  { pattern: /(code-review|security-review|review)/i, phase: 'review' },
  { pattern: /^verify$/i, phase: 'verify' },
  { pattern: /(feedhub-fix|autoresearch-fix|autoresearch:fix)/i, phase: 'fix' },
  { pattern: /(desearch|deep-research|autoresearch)/i, phase: 'research' },
  { pattern: /(grilling|grill-me|init|writing-plans|brainstorming)/i, phase: 'planning' },
];

/**
 * Maps an active turn `skill` to a phase. Order matters: the fix-flavoured autoresearch skills
 * (`autoresearch-fix`, `autoresearch:fix`) must be checked before the generic `autoresearch*`
 * research rule, or they'd be swallowed by it.
 */
export function phaseFromSkill(skill: string | undefined): Phase | undefined {
  if (skill === undefined) return undefined;
  for (const rule of SKILL_RULES) {
    if (rule.pattern.test(skill)) return rule.phase;
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
