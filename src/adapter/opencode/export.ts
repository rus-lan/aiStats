import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { closeSync, openSync, readFileSync, unlinkSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** Opencode binary name/path, override for machines where it isn't on `$PATH` as `opencode`. */
const OPENCODE_BIN = process.env.OPENCODE_BIN ?? 'opencode';

/** Raw shape of `opencode export <id>` output. Fields are read defensively downstream — nothing here is assumed present beyond what JSON.parse guarantees. */
export interface ExportedPart {
  [key: string]: unknown;
}
export interface ExportedMessage {
  info: Record<string, unknown>;
  parts: ExportedPart[];
}
export interface ExportedSession {
  info: Record<string, unknown>;
  messages: ExportedMessage[];
}

/** Thrown when `opencode export` can't be run or doesn't return parseable JSON — the caller (adapter `parse()`) catches this and skips the session rather than failing the whole ingest run. */
export class OpencodeExportError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = 'OpencodeExportError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isExportedSession(value: unknown): value is ExportedSession {
  if (!isRecord(value)) return false;
  return isRecord(value['info']) && Array.isArray(value['messages']);
}

/**
 * Shells out to `opencode export <sessionId>`. Its stdout is redirected straight to a scratch
 * file rather than captured through a piped stdio stream: piping it (the obvious `execFile`
 * approach) reliably truncates large sessions on this machine — Opencode's export command exits
 * as soon as it's done writing without waiting out the pipe's backpressure, so a fast reader on a
 * `pipe` stdio silently gets a partial payload (confirmed: identical command, ~570KB via a real
 * file, ~146KB via a piped `child_process` stdout, both exit code 0 with no error). A real file
 * doesn't have that backpressure stall, so this reads back the whole thing correctly. Read back
 * as one whole `Buffer`, decoded in a single `toString('utf8')` call (never concatenated
 * string-by-string) so a multi-byte UTF-8 sequence never gets split across a chunk boundary.
 * stderr (Opencode prints an experimental-sqlite warning there on some builds) is ignored.
 */
export function exportSession(sessionId: string): Promise<ExportedSession> {
  return new Promise((resolve, reject) => {
    const tmpPath = path.join(os.tmpdir(), `aistats-oc-export-${randomUUID()}.json`);

    let fd: number;
    try {
      fd = openSync(tmpPath, 'w');
    } catch (cause) {
      reject(new OpencodeExportError(`opencode export ${sessionId}: couldn't open a scratch file`, cause));
      return;
    }

    const cleanup = (): void => {
      try {
        unlinkSync(tmpPath);
      } catch {
        // best-effort — a leftover temp file in os.tmpdir() isn't worth failing the ingest over
      }
    };

    const child = spawn(OPENCODE_BIN, ['export', sessionId], { stdio: ['ignore', fd, 'ignore'] });

    child.on('error', (cause) => {
      closeSync(fd);
      cleanup();
      reject(new OpencodeExportError(`opencode export ${sessionId} failed to start: ${cause.message}`, cause));
    });

    child.on('close', (code) => {
      closeSync(fd);
      if (code !== 0) {
        cleanup();
        reject(new OpencodeExportError(`opencode export ${sessionId} exited with code ${String(code)}`));
        return;
      }

      let parsed: unknown;
      try {
        const buf = readFileSync(tmpPath);
        parsed = JSON.parse(buf.toString('utf8'));
      } catch (cause) {
        cleanup();
        reject(new OpencodeExportError(`opencode export ${sessionId} returned invalid JSON`, cause));
        return;
      }
      cleanup();

      if (!isExportedSession(parsed)) {
        reject(new OpencodeExportError(`opencode export ${sessionId} returned an unexpected shape`));
        return;
      }
      resolve(parsed);
    });
  });
}
