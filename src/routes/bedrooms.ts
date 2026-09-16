import { Hono, type Context } from "hono";
import { publish } from "../services/realtime";
import { requireAuth } from "../middleware/auth";
import { requireManager, requireRole } from "../middleware/roles";
import {
  countStaffPerBedroom,
  deleteBedroom,
  findBedroomById,
  findBedroomByName,
  insertBedroom,
  listBedrooms,
  updateBedroom,
  type BedroomData,
} from "../models/bedrooms";
import { countCampersPerBedroom, listCampers } from "../models/campers";
import { listStaff } from "../models/staff";
import { BEDROOM_GROUPS, bedroomCapacity, type Bedroom, type BedroomGroup, type Role, type SessionUser } from "../types";
import { serializeCamperList } from "./campers";
import { serializeStaffList } from "./staff";
import { canSeeBedroom, resolveScope } from "../services/scope";
import { applyBedroomGroupToOccupants } from "../services/camperSex";

interface Env {
  Variables: {
    userId: string;
    sessionId: string;
    activeRole: Role;
    user: SessionUser;
  };
}

const bedrooms = new Hono<Env>();

const NAME_MAX = 30;
const NOTES_MAX = 300;
const BEDS_MAX = 50;

function fail(c: Context, code: string, message: string, status: 400 | 404 | 409 = 400) {
  return c.json({ error: { code, message } }, status);
}

interface Occupancy {
  staff: number;
  campers: number;
}

/** staff + campers per bedroom id */
export async function occupancy(): Promise<Map<string, Occupancy>> {
  const [s, k] = await Promise.all([countStaffPerBedroom(), countCampersPerBedroom()]);
  const m = new Map<string, Occupancy>();
  for (const [id, n] of s) m.set(id, { staff: n, campers: 0 });
  for (const [id, n] of k) m.set(id, { ...(m.get(id) ?? { staff: 0, campers: 0 }), campers: n });
  return m;
}

const NONE: Occupancy = { staff: 0, campers: 0 };

export function serializeBedroom(b: Bedroom, occ: Occupancy = NONE) {
  const capacity = bedroomCapacity(b);
  const occupied = occ.staff + occ.campers;
  return {
    id: b._id,
    name: b.name,
    group: b.group,
    bunkBeds: b.bunkBeds,
    singleBeds: b.singleBeds,
    capacity,
    occupied,
    occupiedStaff: occ.staff,
    occupiedCampers: occ.campers,
    available: capacity - occupied,
    notes: b.notes,
    createdAt: b.createdAt,
    updatedAt: b.updatedAt,
  };
}

function parseBeds(value: unknown, fallback: number | undefined): number | null {
  if (value === undefined) return fallback ?? null;
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isInteger(n) || n < 0 || n > BEDS_MAX) return null;
  return n;
}

/** Validates the body; `partial` (PUT) only touches keys that are present. */
function buildPatch(
  body: Record<string, unknown>,
  partial: boolean,
): { patch: Partial<BedroomData> } | { code: string; message: string } {
  const patch: Partial<BedroomData> = {};
  const has = (k: string) => !partial || body[k] !== undefined;

  if (has("name")) {
    const name = typeof body.name === "string" ? body.name.trim().replace(/\s+/g, " ") : "";
    if (!name || name.length > NAME_MAX) {
      return { code: "NAME_INVALID", message: `Informe o nome/número do quarto com até ${NAME_MAX} caracteres.` };
    }
    patch.name = name;
  }

  if (has("group")) {
    if (!BEDROOM_GROUPS.includes(body.group as BedroomGroup)) {
      return { code: "GROUP_INVALID", message: "Ala inválida. Use meninas, meninos ou equipe." };
    }
    patch.group = body.group as BedroomGroup;
  }

  if (has("bunkBeds")) {
    const n = parseBeds(body.bunkBeds, 0);
    if (n === null) return { code: "BUNK_BEDS_INVALID", message: `Beliches deve ser um número entre 0 e ${BEDS_MAX}.` };
    patch.bunkBeds = n;
  }

  if (has("singleBeds")) {
    const n = parseBeds(body.singleBeds, 0);
    if (n === null) {
      return { code: "SINGLE_BEDS_INVALID", message: `Camas de solteiro deve ser um número entre 0 e ${BEDS_MAX}.` };
    }
    patch.singleBeds = n;
  }

  if (has("notes")) {
    if (body.notes !== undefined && typeof body.notes !== "string") {
      return { code: "NOTES_INVALID", message: "Observações inválidas." };
    }
    patch.notes = ((body.notes as string | undefined) ?? "").trim().slice(0, NOTES_MAX);
  }

  return { patch };
}

bedrooms.use("*", requireAuth);

// ── read: admin sees every room; staff/health staff only their own (see services/scope.ts) ──

/** GET /api/bedrooms?group=girls|boys|staff — sorted by group then number (scoped). */
bedrooms.get("/", requireRole("admin", "staff", "health_staff", "parent"), async (c) => {
  const group = c.req.query("group");
  if (group && !BEDROOM_GROUPS.includes(group as BedroomGroup)) {
    return fail(c, "GROUP_INVALID", "Ala inválida. Use girls, boys ou staff.");
  }
  const [list, occ, scope] = await Promise.all([
    listBedrooms({ group: group as BedroomGroup | undefined }),
    occupancy(),
    resolveScope(c.get("user")),
  ]);
  return c.json({ bedrooms: list.filter((b) => canSeeBedroom(scope, b._id)).map((b) => serializeBedroom(b, occ.get(b._id))) });
});

bedrooms.get("/:id", requireRole("admin", "staff", "health_staff", "parent"), async (c) => {
  const b = await findBedroomById(c.req.param("id"));
  // outside the viewer's scope → same answer as "does not exist" (no probing)
  if (!b || !canSeeBedroom(await resolveScope(c.get("user")), b._id)) return fail(c, "BEDROOM_NOT_FOUND", "Quarto não encontrado.", 404);
  const occ = await occupancy();
  return c.json({ bedroom: serializeBedroom(b, occ.get(b._id)) });
});

/** GET /api/bedrooms/:id/detail — the room + who sleeps there (campers and staff caretakers). */
bedrooms.get("/:id/detail", requireRole("admin", "staff", "health_staff"), async (c) => {
  const b = await findBedroomById(c.req.param("id"));
  const scope = await resolveScope(c.get("user"));
  if (!b || !canSeeBedroom(scope, b._id)) return fail(c, "BEDROOM_NOT_FOUND", "Quarto não encontrado.", 404);
  const [campers, allStaff] = await Promise.all([listCampers({ bedroom: b._id }), listStaff()]);
  const staff = allStaff.filter((s) => s.bedroom === b._id);
  return c.json({
    bedroom: serializeBedroom(b, { staff: staff.length, campers: campers.length }),
    campers: serializeCamperList(campers, scope),
    staff: serializeStaffList(staff, scope),
  });
});

// ── write: admin or organizer ──────────────────────────────────────────────────────

bedrooms.use("/*", requireManager);

/** POST /api/bedrooms  { name, group, bunkBeds?, singleBeds?, notes? } */
bedrooms.post("/", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) return fail(c, "BODY_INVALID", "Corpo da requisição inválido.");

  const result = buildPatch(body, false);
  if (!("patch" in result)) return fail(c, result.code, result.message);
  const data = result.patch as BedroomData;

  if (bedroomCapacity(data) === 0) {
    return fail(c, "CAPACITY_INVALID", "O quarto precisa ter ao menos uma cama.");
  }
  if (await findBedroomByName(data.name)) {
    return fail(c, "NAME_DUPLICATE", `Já existe um quarto "${data.name}".`, 409);
  }

  const created = await insertBedroom(data);
  publish("bedrooms");
  return c.json({ bedroom: serializeBedroom(created) }, 201);
});

/** PUT /api/bedrooms/:id — partial update. */
bedrooms.put("/:id", async (c) => {
  const existing = await findBedroomById(c.req.param("id"));
  if (!existing) return fail(c, "BEDROOM_NOT_FOUND", "Quarto não encontrado.", 404);

  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) return fail(c, "BODY_INVALID", "Corpo da requisição inválido.");

  const result = buildPatch(body, true);
  if (!("patch" in result)) return fail(c, result.code, result.message);

  const merged = { ...existing, ...result.patch };
  if (bedroomCapacity(merged) === 0) {
    return fail(c, "CAPACITY_INVALID", "O quarto precisa ter ao menos uma cama.");
  }
  if (result.patch.name && result.patch.name !== existing.name) {
    const clash = await findBedroomByName(result.patch.name);
    if (clash && clash._id !== existing._id) {
      return fail(c, "NAME_DUPLICATE", `Já existe um quarto "${result.patch.name}".`, 409);
    }
  }

  const updated = await updateBedroom(existing._id, result.patch);
  if (result.patch.group && result.patch.group !== existing.group) {
    const n = await applyBedroomGroupToOccupants(existing._id, result.patch.group, { userId: c.get("userId"), signal: c.req.raw.signal });
    if (n.campers) publish("campers");
    if (n.staff) publish("staff");
  }
  const occ = await occupancy();
  publish("bedrooms");
  return c.json({ bedroom: serializeBedroom(updated!, occ.get(updated!._id)) });
});

/** DELETE /api/bedrooms/:id — refused while someone is assigned to it. */
bedrooms.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const existing = await findBedroomById(id);
  if (!existing) return fail(c, "BEDROOM_NOT_FOUND", "Quarto não encontrado.", 404);

  const o = (await occupancy()).get(id) ?? NONE;
  const occ = o.staff + o.campers;
  if (occ > 0) {
    return fail(
      c,
      "BEDROOM_IN_USE",
      `Este quarto tem ${occ} pessoa${occ > 1 ? "s" : ""} alocada${occ > 1 ? "s" : ""}. Mova-as antes de excluir.`,
      409,
    );
  }

  await deleteBedroom(id);
  publish("bedrooms");
  return c.json({ success: true });
});

export default bedrooms;
