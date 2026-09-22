import { AsyncLocalStorage } from "node:async_hooks";
import type { Camp } from "../models/camps";

/**
 * The camp of the current request (or background job). `withCamp` enters it;
 * every model call reads it back through `currentCampId()`. No context (a
 * fire-and-forget promise, a route that forgot to enter one) never throws —
 * it silently falls back to the ACTIVE camp, which is what keeps a
 * single-camp deployment behaving exactly as before this feature existed.
 */
const storage = new AsyncLocalStorage<string>();

let cached: Camp | null = null;

export function withCamp<T>(campId: string, fn: () => Promise<T>): Promise<T> {
  return storage.run(campId, fn);
}

/** The camp id in scope right now: the async context, else the active camp. Never throws once boot ran `refreshActiveCamp()`. */
export function currentCampId(): string {
  return storage.getStore() ?? activeCampId();
}

export function activeCampId(): string {
  if (!cached) throw new Error("activeCampId(): no active camp cached yet — call refreshActiveCamp() at boot first.");
  return cached._id;
}

export function activeCamp(): Camp {
  if (!cached) throw new Error("activeCamp(): no active camp cached yet — call refreshActiveCamp() at boot first.");
  return cached;
}

/** Re-reads `camps { active: true }` and refreshes the cache — call at boot and after create/activate. */
export async function refreshActiveCamp(): Promise<Camp> {
  const { getActiveCamp } = await import("../models/camps");
  const camp = await getActiveCamp();
  if (!camp) throw new Error("refreshActiveCamp(): no active camp in the registry — did migrateToCamps() run?");
  cached = camp;
  return camp;
}

/** True when the current context is a camp OTHER than the active one (a history / read-only session). */
export function inHistoryCamp(): boolean {
  return currentCampId() !== activeCampId();
}
