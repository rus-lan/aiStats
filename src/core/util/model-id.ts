const TRAILING_SUFFIX = /\[[^[\]]*\]$/;

export function normalizeModelId(id: string): string {
  return id.replace(TRAILING_SUFFIX, '');
}
