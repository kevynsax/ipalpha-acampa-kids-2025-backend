import { Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";
import { findById } from "../models/users";
import { verifySessionToken } from "../services/session";
import { addClient, clientCount, removeClient, type RealtimeClient } from "../services/realtime";
import { loadCollections } from "../services/snapshot";

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
    const user = payload ? await findById(payload.userId) : null;

    if (!payload || !user) {
      return {
        onOpen(_evt, ws) {
          ws.send(JSON.stringify({ type: "error", code: "UNAUTHORIZED", message: "Sessão inválida ou expirada." }));
          ws.close(4401, "unauthorized");
        },
      };
    }

    const viewer = { activeRole: payload.role, phone: user.phone };
    let client: RealtimeClient | null = null;
    return {
      async onOpen(_evt, ws) {
        client = { ws, role: payload.role, userId: user._id, phone: user.phone };
        addClient(client);
        try {
          const data = await loadCollections(viewer);
          ws.send(JSON.stringify({ type: "snapshot", at: new Date().toISOString(), data }));
        } catch (err) {
          console.error("realtime: snapshot failed", err);
          ws.send(JSON.stringify({ type: "error", code: "SNAPSHOT_FAILED", message: "Não foi possível carregar os dados." }));
        }
        console.log(`🔌 ws +1 (${clientCount()} online) ${user.name} [${payload.role}]`);
      },
      onMessage(evt, ws) {
        // the client answers pings and may ask for a fresh snapshot
        const text = typeof evt.data === "string" ? evt.data : "";
        if (text === "refresh") {
          loadCollections(viewer)
            .then((data) => ws.send(JSON.stringify({ type: "snapshot", at: new Date().toISOString(), data })))
            .catch(() => {});
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
