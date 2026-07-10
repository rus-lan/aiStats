import { statSync } from 'node:fs';
import type { Adapter, AdapterRun, DiscoverOpts, SourceRef, ToolName } from '../../core/types.js';
import { cursorKeyFor } from '../../core/ingest/cursor.js';
import { listAllMainTranscripts, subagentFilesByNameFor, subagentFilesFor } from './paths.js';
import { parseMainTranscript } from './transcript.js';
import { parseSubagentRun } from './subagents.js';

export class ClaudeCodeAdapter implements Adapter {
  readonly tool: ToolName = 'cc';

  discover(opts: DiscoverOpts): Promise<SourceRef[]> {
    const refs: SourceRef[] = [];
    for (const filePath of listAllMainTranscripts()) {
      const stat = statSync(filePath);
      const key = cursorKeyFor({ kind: 'cc-jsonl', path: filePath });
      const stored = opts.cursors.get(key);
      const startOffset = stored?.byteOffset ?? 0;
      if (stat.size <= startOffset) continue;
      if (opts.since !== undefined && stat.mtimeMs < opts.since) continue;
      refs.push({ kind: 'cc-jsonl', path: filePath, byteOffset: startOffset });
    }
    return Promise.resolve(refs);
  }

  parse(ref: SourceRef): Promise<AdapterRun[]> {
    if (ref.path === undefined) throw new Error('cc adapter: source ref is missing a path');
    const { run, spawns } = parseMainTranscript(ref.path, ref.byteOffset ?? 0);
    const runs: AdapterRun[] = [run];
    for (const spawn of spawns) {
      const files =
        spawn.agentId !== undefined
          ? subagentFilesFor(ref.path, spawn.agentId)
          : spawn.teammateName !== undefined
            ? subagentFilesByNameFor(ref.path, spawn.teammateName)
            : undefined;
      if (files === undefined) continue;
      runs.push(parseSubagentRun(files.jsonlPath, files.metaPath, run.sessionId, files.agentId, run.runKey));
    }
    return Promise.resolve(runs);
  }
}
