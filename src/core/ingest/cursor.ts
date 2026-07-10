import type { SourceRef } from '../types.js';

/** Stable store key for a source ref's cursor row — independent of `byteOffset`/`ocCursorTime` so re-deriving it always finds the same stored cursor. */
export function cursorKeyFor(ref: SourceRef): string {
  if (ref.path !== undefined) return `${ref.kind}:${ref.path}`;
  if (ref.ocSessionId !== undefined) return `${ref.kind}:${ref.ocSessionId}`;
  throw new Error(`cannot derive a cursor key from source ref: ${JSON.stringify(ref)}`);
}
