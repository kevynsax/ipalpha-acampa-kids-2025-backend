import { Hono, type Context } from "hono";
import { publish } from "../services/realtime";
import { requireAuth } from "../middleware/auth";
import { requireAdmin } from "../middleware/roles";
import {
  deleteTransport,
  findTransportById,
  insertTransport,
  listTransports,
  nextTransportOrder,
  updateTransport,
} from "../models/transports";
import { TRANSPORT_KINDS, busColorName, type Role, type SessionUser, type Transport, type TransportKind } from "../types";

interface Env {
  Variables: {
    userId: string;
    sessionId: string;
    activeRole: Role;
    user: SessionUser;
  };
}

const transports = new Hono<Env>();

const NAME_MAX = 60;
const NUMBER_MAX = 8;
const CAPACITY_MAX = 200;

function fail(c: Context, code: string, message: string, status: 400 | 404 = 400) {
  return c.json({ error: { code, message } }, status);
}

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim().replace(/\s+/g, " ");
  if (!v || v.length > max) return null;
  return v;
}

function parseKind(value: unknown): TransportKind | null {
  return TRANSPORT_KINDS.includes(value as TransportKind) ? (value as TransportKind) : null;
}

/**
 * The number of seats: a whole number from 1 to CAPACITY_MAX. `undefined`
 * clears it (capacity is optional — an unknown bus size), `null` means the
 * value was sent but is not a valid seat count.
 */
function cleanCapacity(value: unknown): number | undefined | null {
  if (value === undefined || value === null || value === "") return undefined;
  const n = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isInteger(n) || n < 1 || n > CAPACITY_MAX) return null;
  return n;
}

/** normalizes "#0F9A8A" / "0f9a8a" → "#0f9a8a"; null when not a hex colour */
function cleanColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim().replace(/^#/, "").toLowerCase();
  return /^[0-9a-f]{6}$/.test(v) ? `#${v}` : null;
}

/**
 * A bus has no name: its label is the number then the colour — "Ônibus 3 -
 * Amarelo" ("Ônibus 3" when the colour has no name). A car shows its
 * free-text name.
 */
export function transportLabel(t: Pick<Transport, "kind" | "name" | "number" | "color">): string {
  if (t.kind !== "bus") return t.name?.trim() || "Carro";
  const head = ["Ônibus", t.number].filter(Boolean).join(" ").trim();
  const colour = busColorName(t.color);
  return colour ? `${head} - ${colour}` : head;
}

export function serializeTransport(t: Transport) {
  return {
    id: t._id,
    kind: t.kind,
    name: t.name ?? null,
    color: t.color ?? null,
    number: t.number ?? null,
    capacity: t.capacity ?? null,
    label: transportLabel(t),
    order: t.order,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

transports.use("*", requireAuth);

// read: any logged-in role (forms / roll-call consume these)
transports.get("/", async (c) => {
  const list = await listTransports();
  return c.json({ transports: list.map(serializeTransport) });
});

// write: admin only
transports.use("/*", requireAdmin);

/** POST /api/transports  { kind, name, color?, number? } */
transports.post("/", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) return fail(c, "BODY_INVALID", "Corpo da requisição inválido.");

  const kind = parseKind(body.kind);
  if (!kind) return fail(c, "KIND_INVALID", "Escolha ônibus ou carro.");

  let name: string | undefined;
  let color: string | undefined;
  let number: string | undefined;
  let capacity: number | undefined;
  if (kind === "bus") {
    // a bus has no name — its label is derived from the number + colour
    const parsedColor = cleanColor(body.color);
    if (!parsedColor) return fail(c, "COLOR_INVALID", "Escolha a cor do ônibus.");
    const parsedNumber = cleanText(body.number, NUMBER_MAX);
    if (!parsedNumber) return fail(c, "NUMBER_INVALID", `Informe o número do ônibus (até ${NUMBER_MAX} caracteres).`);
    const parsedCapacity = cleanCapacity(body.capacity);
    if (parsedCapacity === null) return fail(c, "CAPACITY_INVALID", `Informe a capacidade entre 1 e ${CAPACITY_MAX} lugares.`);
    color = parsedColor;
    number = parsedNumber;
    capacity = parsedCapacity;
  } else {
    const parsedName = cleanText(body.name, NAME_MAX);
    if (!parsedName) return fail(c, "NAME_INVALID", `Informe um nome com até ${NAME_MAX} caracteres.`);
    name = parsedName;
  }

  const t = await insertTransport({ kind, name, color, number, capacity, order: await nextTransportOrder() });
  publish("transports");
  return c.json({ transport: serializeTransport(t) }, 201);
});

/** PUT /api/transports/reorder  { ids: string[] } — before /:id */
transports.put("/reorder", async (c) => {
  const body = await c.req.json<{ ids?: unknown }>().catch(() => null);
  if (!body || !Array.isArray(body.ids) || !body.ids.every((i) => typeof i === "string")) {
    return fail(c, "BODY_INVALID", "Envie a lista de ids na nova ordem.");
  }
  const ids = body.ids as string[];
  await Promise.all(ids.map((id, order) => updateTransport(id, { order })));
  const list = await listTransports();
  publish("transports");
  return c.json({ transports: list.map(serializeTransport) });
});

/** PUT /api/transports/:id  { kind?, name?, color?, number? } */
transports.put("/:id", async (c) => {
  const t = await findTransportById(c.req.param("id"));
  if (!t) return fail(c, "TRANSPORT_NOT_FOUND", "Transporte não encontrado.", 404);

  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) return fail(c, "BODY_INVALID", "Corpo da requisição inválido.");

  const patch: Partial<Omit<Transport, "_id" | "createdAt" | "updatedAt">> = {};
  const kind = body.kind !== undefined ? parseKind(body.kind) : t.kind;
  if (body.kind !== undefined) {
    if (!kind) return fail(c, "KIND_INVALID", "Escolha ônibus ou carro.");
    patch.kind = kind;
  }

  if (kind === "car") {
    // a car has a name, no colour / number
    if (body.kind !== undefined && t.kind === "bus") {
      patch.color = undefined;
      patch.number = undefined;
      patch.capacity = undefined;
    }
    if (body.name !== undefined || (body.kind !== undefined && t.kind === "bus")) {
      const name = cleanText(body.name, NAME_MAX);
      if (!name) return fail(c, "NAME_INVALID", `Informe um nome com até ${NAME_MAX} caracteres.`);
      patch.name = name;
    }
  } else {
    // a bus has a colour + number, no name
    if (body.kind !== undefined && t.kind === "car") patch.name = undefined;
    if (body.color !== undefined || (body.kind !== undefined && t.kind === "car")) {
      const color = cleanColor(body.color);
      if (!color) return fail(c, "COLOR_INVALID", "Escolha a cor do ônibus.");
      patch.color = color;
    }
    if (body.number !== undefined || (body.kind !== undefined && t.kind === "car")) {
      const number = cleanText(body.number, NUMBER_MAX);
      if (!number) return fail(c, "NUMBER_INVALID", `Informe o número do ônibus (até ${NUMBER_MAX} caracteres).`);
      patch.number = number;
    }
    if (body.capacity !== undefined || (body.kind !== undefined && t.kind === "car")) {
      const capacity = cleanCapacity(body.capacity);
      if (capacity === null) return fail(c, "CAPACITY_INVALID", `Informe a capacidade entre 1 e ${CAPACITY_MAX} lugares.`);
      patch.capacity = capacity;
    }
  }

  const updated = await updateTransport(t._id, patch);
  publish("transports");
  return c.json({ transport: serializeTransport(updated!) });
});

transports.delete("/:id", async (c) => {
  const ok = await deleteTransport(c.req.param("id"));
  if (!ok) return fail(c, "TRANSPORT_NOT_FOUND", "Transporte não encontrado.", 404);
  publish("transports");
  return c.json({ success: true });
});

export default transports;
