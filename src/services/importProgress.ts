/**
 * Fine-grained progress of a running import analysis, keyed by a token the
 * browser generates per analyze request (the import id only exists after the
 * response). Purely informational: kept in memory and never persisted.
 */
export interface ImportPhase {
  key: string;
  pct: number;
  at: number;
}

const store = new Map<string, ImportPhase>();
const TTL_MS = 10 * 60 * 1000;

export function setImportProgress(id: string, key: string, pct: number): void {
  if (!id) return;
  const previous = store.get(id);
  const clamped = Math.max(0, Math.min(100, Math.round(pct)));
  // tasks settle out of order and the total grows while pushing — never go backwards
  store.set(id, { key, pct: Math.max(clamped, previous?.pct ?? 0), at: Date.now() });
  if (store.size > 200) for (const [k, v] of store) if (Date.now() - v.at > TTL_MS) store.delete(k);
}

export function getImportProgress(id: string): ImportPhase | null {
  const phase = store.get(id);
  if (!phase) return null;
  if (Date.now() - phase.at > TTL_MS) {
    store.delete(id);
    return null;
  }
  return phase;
}
