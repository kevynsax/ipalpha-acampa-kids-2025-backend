import { Hono } from "hono";
import { websocket } from "hono/bun";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { config } from "./config";
import { getDb } from "./db";
import { ensureIndexes } from "./models/users";
import { ensureCategoryIndexes } from "./models/categories";
import { ensureBedroomIndexes } from "./models/bedrooms";
import { ensureStaffIndexes } from "./models/staff";
import { ensureScheduleIndexes } from "./models/schedule";
import { ensureCamperIndexes } from "./models/campers";
import { ensurePrepIndexes } from "./models/preparation";
import { ensureInstructionIndexes } from "./models/instructions";
import { ensureOccurrenceIndexes } from "./models/occurrences";
import { ensureFileIndexes } from "./models/files";
import authRoutes from "./routes/auth";
import categoryRoutes from "./routes/categories";
import staffRoutes from "./routes/staff";
import bedroomRoutes from "./routes/bedrooms";
import scheduleRoutes from "./routes/schedule";
import camperRoutes from "./routes/campers";
import realtimeRoutes from "./routes/realtime";
import settingsRoutes from "./routes/settings";
import preparationRoutes from "./routes/preparation";
import instructionRoutes from "./routes/instructions";
import occurrenceRoutes from "./routes/occurrences";
import fileRoutes from "./routes/files";
import aiRoutes from "./routes/ai";
import { comteleEnabled } from "./services/comtele";
import { scheduleCheckinReminder, scheduleCheckinWindow } from "./services/realtime";
import { sendCheckinReminder, syncWelcomes } from "./services/notify";
import { getSettings } from "./models/settings";

const app = new Hono();

app.use(logger());
app.use(
  cors({
    origin: config.corsOrigin,
    allowHeaders: ["content-type", "authorization"],
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  }),
);

app.get("/health", (c) =>
  c.json({ status: "ok", smsProvider: comteleEnabled() ? "comtele" : "mock" }),
);

app.route("/api/auth", authRoutes);
app.route("/api/categories", categoryRoutes);
app.route("/api/staff", staffRoutes);
app.route("/api/bedrooms", bedroomRoutes);
app.route("/api/schedule", scheduleRoutes);
app.route("/api/campers", camperRoutes);
app.route("/api/settings", settingsRoutes);
app.route("/api/preparation", preparationRoutes);
app.route("/api/instructions", instructionRoutes);
app.route("/api/occurrences", occurrenceRoutes);
// images for the WYSIWYG editor (upload: admin / organizer / medical; read: public, unguessable ids)
app.route("/api/files", fileRoutes);
// AI helper for the WYSIWYG editor (proxies the OpenAI-compatible gateway; AI_API_KEY)
app.route("/api/ai", aiRoutes);
// WebSocket: full snapshot on connect + live updates after every write (see services/realtime.ts)
app.route("/api/realtime", realtimeRoutes);

const { port } = config;

console.log("Connecting to MongoDB…");
const db = await getDb();
await ensureIndexes();
await ensureCategoryIndexes();
await ensureStaffIndexes();
await ensureBedroomIndexes();
await ensureScheduleIndexes();
await ensureCamperIndexes();
await ensurePrepIndexes();
await ensureInstructionIndexes();
await ensureOccurrenceIndexes();
await ensureFileIndexes();
console.log(`MongoDB connected → ${config.dbName}`);
// re-arm the check-in window timers (they live in memory)
{
  const s = await getSettings();
  scheduleCheckinWindow(s.checkinWindow, s.staffAccessWindow);
  scheduleCheckinReminder(s.checkinReminder.at);
  void syncWelcomes(); // the team window may have opened while the server was down
  void sendCheckinReminder(); // the reminder instant may have passed while the server was down
}

console.log(
  comteleEnabled()
    ? "Comtele SMS enabled (real OTP via SMS)."
    : "⚠️  COMTELE_API_KEY not set — running in MOCK mode: OTP codes are printed in this console.",
);

export default {
  port,
  fetch: app.fetch,
  websocket,
  // Bun drops idle connections after 10s by default; reasoning models (AI helper) can stay silent longer
  idleTimeout: 255,
};

console.log(`🏕️  Camping backend listening on http://localhost:${port}`);
