export const SCHEMA_VERSION = 1;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  tool TEXT NOT NULL,
  projectKey TEXT NOT NULL,
  agentType TEXT,
  isSubagent INTEGER NOT NULL,
  parentRunId TEXT,
  model TEXT,
  tStart INTEGER NOT NULL,
  tEnd INTEGER NOT NULL,
  open INTEGER NOT NULL,
  tokens TEXT NOT NULL,
  costUsd REAL,
  cursor TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS turns (
  id TEXT PRIMARY KEY,
  runId TEXT NOT NULL,
  idx INTEGER NOT NULL,
  tStart INTEGER NOT NULL,
  tEnd INTEGER NOT NULL,
  durationMs INTEGER,
  tokens TEXT NOT NULL,
  model TEXT,
  phase TEXT NOT NULL,
  skill TEXT,
  blockId TEXT NOT NULL,
  isFixEpisodeStart INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS toolcalls (
  id TEXT PRIMARY KEY,
  turnId TEXT NOT NULL,
  name TEXT NOT NULL,
  tStart INTEGER NOT NULL,
  tEnd INTEGER,
  status TEXT NOT NULL,
  isEdit INTEGER NOT NULL,
  file TEXT
);

CREATE TABLE IF NOT EXISTS cursors (
  key TEXT PRIMARY KEY,
  ref TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_turns_runId ON turns (runId);
CREATE INDEX IF NOT EXISTS idx_toolcalls_turnId ON toolcalls (turnId);
CREATE INDEX IF NOT EXISTS idx_runs_tool ON runs (tool);
CREATE INDEX IF NOT EXISTS idx_runs_projectKey ON runs (projectKey);
`;

export const SCHEMA_VERSION_KEY = 'schemaVersion';
