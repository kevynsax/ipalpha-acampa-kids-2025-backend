import type { WSContext } from "hono/ws";
import type { CheckinWindow, Role } from "../types";

/**
 * Realtime hub: every logged-in client keeps a WebSocket open and receives
 *   - a full `snapshot` right after connecting, and
 *   - an `update` with the collections that changed after every write.
 * Payloads are whole collections (the dataset is small: ~150 kids, ~70 staff,
 * ~40 rooms, ~50 events), which keeps the client logic a simple "replace".
 */

export const COLLECTIONS = ["campers", "staff", "bedrooms", "categories", "roles", "events", "preparation", "instructions", "occurrences", "settings"] as const;
export type Collection = (typeof COLLECTIONS)[number];
export type Snapshot = Partial<Record<Collection, unknown>>;

export interface RealtimeClient {
  ws: WSContext;
  role: Role;
  userId: string;
  /** the person's phone — staff payloads are personalised (own record un-redacted) */
  phone: string;
}

const clients = new Set<RealtimeClient>();

export function addClient(client: RealtimeClient): void {
  clients.add(client);
}

export function removeClient(client: RealtimeClient): void {
  clients.delete(client);
}

export function clientCount(): number {
  return clients.size;
}

function safeSend(client: RealtimeClient, payload: string): void {
  try {
    if (client.ws.readyState === 1) client.ws.send(payload);
  } catch {
    clients.delete(client);
  }
}

// ── publish (debounced so a burst of writes becomes one message) ───────────

const pending = new Set<Collection>();
let timer: ReturnType<typeof setTimeout> | null = null;

/** Call after any write: the named collections are re-read and pushed to everyone. */
export function publish(...names: Collection[]): void {
  for (const n of names) pending.add(n);
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    void flush();
  }, 25);
}

async function flush(): Promise<void> {
  const names = [...pending];
  pending.clear();
  if (names.length === 0 || clients.size === 0) return;

  // lazy import: snapshot.ts imports the routes (serializers) and the routes import publish()
  const { loadCollections, snapshotKey } = await import("./snapshot");
  const at = new Date().toISOString();
  // one payload per distinct view (role, or role+person for staff)
  const byKey = new Map<string, string | null>();

  for (const client of clients) {
    const viewer = { activeRole: client.role, phone: client.phone };
    const key = snapshotKey(viewer);
    if (!byKey.has(key)) {
      try {
        const data = await loadCollections(viewer, names);
        byKey.set(key, Object.keys(data).length ? JSON.stringify({ type: "update", at, data }) : null);
      } catch (err) {
        console.error("realtime: failed to build update", err);
        byKey.set(key, null);
      }
    }
    const payload = byKey.get(key);
    if (payload) safeSend(client, payload);
  }
}

// ── staff access window: evict the ordinary team when it closes ─────────────

/**
 * Ordinary team members (see scope.staffHasAccess) may only use the app inside
 * `settings.staffAccessWindow`. When it closes — the timer fires or the admin
 * edits the window — their sessions are revoked and their sockets closed with
 * 4401, so the phone logs out and wipes its local copy at once.
 */
export async function evictStaffOutsideWindow(): Promise<void> {
  const [{ getSettings }, { findStaffByPhone }, { staffHasAccess }, { revokeUserSessions }] = await Promise.all([
    import("../models/settings"),
    import("../models/staff"),
    import("./scope"),
    import("./session"),
  ]);
  const settings = await getSettings();
  const now = new Date();
  for (const client of [...clients]) {
    if (client.role !== "staff" && client.role !== "health_staff") continue;
    const me = await findStaffByPhone(client.phone);
    if (!me || staffHasAccess(me._id, settings, now)) continue;
    await revokeUserSessions(client.userId);
    try {
      client.ws.send(JSON.stringify({ type: "error", code: "UNAUTHORIZED", message: "O período de acesso da equipe terminou." }));
      client.ws.close(4401, "access window closed");
    } catch {
      /* already gone */
    }
    clients.delete(client);
    console.log(`🚪 access window closed → logged out ${me.name}`);
  }
}

// ── check-in window: re-push at both edges ──────────────────────────────────

/**
 * A helper's scope flips when the window opens and when it closes, with no
 * write to trigger a publish. So we arm timers for both instants: when they
 * fire, the scoped collections are re-sent to every client — helpers receive
 * their extra data (or lose it), everyone else gets an identical payload.
 */
let edgeTimers: ReturnType<typeof setTimeout>[] = [];
const MAX_TIMEOUT = 2 ** 31 - 1;

export function scheduleCheckinWindow(w: CheckinWindow, staffAccess?: CheckinWindow): void {
  for (const t of edgeTimers) clearTimeout(t);
  edgeTimers = [];
  const now = Date.now();
  for (const edge of [w.from, w.until, staffAccess?.from ?? null, staffAccess?.until ?? null]) {
    if (!edge) continue;
    const wait = edge.getTime() - now + 500; // a hair after, so the check sees the new state
    if (wait <= 0 || wait > MAX_TIMEOUT) continue;
    edgeTimers.push(
      setTimeout(() => {
        console.log("⏰ check-in window edge reached → re-publishing scoped collections");
        publish("campers", "staff", "bedrooms", "roles", "events", "settings");
        void evictStaffOutsideWindow().catch((err) => console.error("realtime: evict failed", err));
        void import("./notify").then((m) => m.syncWelcomes()); // the team window may have just opened → welcome SMS
      }, wait),
    );
  }
}

// ── check-in reminder: one timer for the instant the admin picked (re-armed on every settings write and at boot)
let reminderTimer: ReturnType<typeof setTimeout> | null = null;

/** Arms (or clears) the check-in reminder timer. `null` / a past instant / beyond setTimeout's limit → nothing armed (the hourly safety net and boot catch up). */
export function scheduleCheckinReminder(at: Date | null): void {
  if (reminderTimer) clearTimeout(reminderTimer);
  reminderTimer = null;
  if (!at) return;
  const wait = at.getTime() - Date.now() + 500;
  if (wait > MAX_TIMEOUT) return;
  reminderTimer = setTimeout(() => {
    reminderTimer = null;
    console.log("⏰ check-in reminder instant reached");
    void import("./notify").then((m) => m.sendCheckinReminder());
  }, Math.max(0, wait));
}

// ── safety net: an instant further than setTimeout's limit (~24 days) can't be armed, so re-check hourly
setInterval(() => void import("./notify").then((m) => Promise.all([m.syncWelcomes(), m.sendCheckinReminder()])), 60 * 60_000);

// ── heartbeat (lets phones notice a dead connection and reconnect) ─────────

const PING_MS = 30_000;
setInterval(() => {
  const payload = JSON.stringify({ type: "ping", at: new Date().toISOString() });
  for (const client of clients) safeSend(client, payload);
}, PING_MS);
