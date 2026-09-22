import { Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";
import { findById, toPublicUser } from "../models/users";
import { revokeSession, verifySessionToken } from "../services/session";
import { addClient, clientCount, removeClient, type RealtimeClient } from "../services/realtime";
import { loadCollections } from "../services/snapshot";
import { roleNoLongerValid, staffSessionExpired } from "../middleware/auth";
import { activeCampId, withCamp } from "../services/campContext";
import { canSwitchCamps } from "../services/campAccess";
import type { Role } from "../types";

/**
 * GET /api/realtime?token=<jwt>  →  WebSocket
 *
 * Browsers can't send an Authorization header on a WebSocket upgrade, so the
 * session token travels in the query string. After the upgrade the server
 * sends `{ type: "snapshot", data }` with every collection the role can read,
 * then `{ type: "update", data }` whenever something changes.
 */
const realtime = new Hono();

realtime.get(
  "/",
  upgradeWebSocket(async (c) => {
    const token = c.req.query("token") ?? "";
    const payload = token ? await verifySessionToken(token) : null;
    const unauthorized = () => ({
      onOpen(_evt: unknown, ws: { send: (s: string) => void; close: (code: number, reason: string) => void }) {
        ws.send(JSON.stringify({ type: "error", code: "UNAUTHORIZED", message: "Sessão inválida ou expirada." }));
        ws.close(4401, "unauthorized");
      },
    });
    if (!payload) return unauthorized();

    const campId = payload.campId;
    const history = campId !== activeCampId();
    const { user, evicted } = await withCamp(campId, async () => {
      const user = await findById(payload.userId);
      if (!user) return { user: null, evicted: false };
      if (history) {
        // the roster row / access window belong to another year — irrelevant here
        if (await canSwitchCamps(toPublicUser(user), payload.role)) return { user, evicted: false };
        await revokeSession(payload.sessionId);
        return { user, evicted: true };
      }
      // window closed, or the profile itself is gone (parent with no kid, admin on a staff session)
      const evicted = (await staffSessionExpired(payload.role, user.phone, user._id)) || (await roleNoLongerValid(payload.role, user));
      return { user, evicted };
    });

    if (!user || evicted) return unauthorized();

    // forced to admin for reads on a history session
    const effectiveRole: Role = history ? "admin" : payload.role;
    const viewer = { activeRole: effectiveRole, phone: user.phone };
    let client: RealtimeClient | null = null;
    return {
      async onOpen(_evt, ws) {
        await withCamp(campId, async () => {
          client = { ws, role: effectiveRole, userId: user._id, phone: user.phone, campId };
          addClient(client);
          try {
            const data = await loadCollections(viewer);
            ws.send(JSON.stringify({ type: "snapshot", at: new Date().toISOString(), data }));
          } catch (err) {
            console.error("realtime: snapshot failed", err);
            ws.send(JSON.stringify({ type: "error", code: "SNAPSHOT_FAILED", message: "Não foi possível carregar os dados." }));
          }
          console.log(`🔌 ws +1 (${clientCount()} online) ${user.name} [${effectiveRole}]${history ? " (history)" : ""}`);
        });
      },
      onMessage(evt, ws) {
        // the client answers pings and may ask for a fresh snapshot
        const text = typeof evt.data === "string" ? evt.data : "";
        if (text === "refresh") {
          void withCamp(campId, () =>
            loadCollections(viewer)
              .then((data) => ws.send(JSON.stringify({ type: "snapshot", at: new Date().toISOString(), data })))
              .catch(() => {}),
          );
        }
      },
      onClose() {
        if (client) removeClient(client);
        console.log(`🔌 ws -1 (${clientCount()} online)`);
      },
      onError() {
        if (client) removeClient(client);
      },
    };
  }),
);

export default realtime;
