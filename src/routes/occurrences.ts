import { Hono, type Context } from "hono";
import { requireAuth } from "../middleware/auth";
import { findCamperById } from "../models/campers";
import { insertOccurrence, listOccurrences } from "../models/occurrences";
import { findStaffById } from "../models/staff";
import { cleanHtml } from "../services/html";
import { publish } from "../services/realtime";
import { resolveScope } from "../services/scope";
import type { Occurrence, OccurrencePerson, Role, SessionUser } from "../types";

interface Env {
  Variables: {
    userId: string;
    sessionId: string;
    activeRole: Role;
    user: SessionUser;
  };
}

const occurrences = new Hono<Env>();
const DESCRIPTION_MAX = 400_000;

function fail(c: Context, code: string, message: string, status: 400 | 403 | 404 = 400) {
  return c.json({ error: { code, message } }, status);
}

export function serializeOccurrence(occurrence: Occurrence) {
  return {
    id: occurrence._id,
    campers: occurrence.campers,
    staff: occurrence.staff,
    description: occurrence.description,
    createdBy: {
      id: occurrence.createdByUserId,
      name: occurrence.createdByName,
      role: occurrence.createdByRole,
    },
    createdAt: occurrence.createdAt,
  };
}

async function occurrenceAccess(c: Context<Env, string>): Promise<{ admin: boolean; medical: boolean } | null> {
  const role = c.get("activeRole");
  if (role === "admin") return { admin: true, medical: false };
  if (role !== "staff" && role !== "health_staff") return null;
  const scope = await resolveScope(c.get("user"));
  return !scope.all && scope.medical ? { admin: false, medical: true } : null;
}

function parseIds(value: unknown, label: string): string[] | { error: string } {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((id) => typeof id !== "string")) return { error: `${label} inválido.` };
  const ids = [...new Set((value as string[]).map((id) => id.trim()).filter(Boolean))];
  if (ids.length > 100) return { error: `${label} tem pessoas demais.` };
  return ids;
}

async function resolvePeople(ids: string[], kind: "camper" | "staff"): Promise<OccurrencePerson[] | { error: string }> {
  const records = await Promise.all(ids.map((id) => (kind === "camper" ? findCamperById(id) : findStaffById(id))));
  const missing = records.findIndex((record) => !record);
  if (missing >= 0) return { error: `${kind === "camper" ? "Acampante" : "Pessoa da equipe"} não encontrado(a).` };
  return records.map((record) => ({ id: record!._id, name: record!.name }));
}

occurrences.use("*", requireAuth);

/** Admin sees every occurrence; medical staff never receive records without a linked camper. */
occurrences.get("/", async (c) => {
  const access = await occurrenceAccess(c);
  if (!access) return fail(c, "FORBIDDEN", "Só a administração e a equipe médica podem ver ocorrências.", 403);
  const list = await listOccurrences();
  const visible = access.admin ? list : list.filter((occurrence) => occurrence.campers.length > 0);
  return c.json({ occurrences: visible.map(serializeOccurrence) });
});

/** Creates a permanent occurrence. Medical staff must link at least one camper. */
occurrences.post("/", async (c) => {
  const access = await occurrenceAccess(c);
  if (!access) return fail(c, "FORBIDDEN", "Só a administração e a equipe médica podem criar ocorrências.", 403);
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) return fail(c, "BODY_INVALID", "Corpo da requisição inválido.");

  const camperIds = parseIds(body.camperIds, "Lista de acampantes");
  if (!Array.isArray(camperIds)) return fail(c, "CAMPERS_INVALID", camperIds.error);
  if (!access.admin && camperIds.length === 0) {
    return fail(c, "CAMPER_REQUIRED", "A equipe médica precisa relacionar pelo menos um acampante à ocorrência.", 403);
  }
  const staffIds = parseIds(body.staffIds, "Lista da equipe");
  if (!Array.isArray(staffIds)) return fail(c, "STAFF_INVALID", staffIds.error);

  const description = cleanHtml(body.description, DESCRIPTION_MAX);
  if (description === null) return fail(c, "DESCRIPTION_INVALID", "A descrição é inválida ou muito longa.");
  if (!description) return fail(c, "DESCRIPTION_REQUIRED", "Descreva o que aconteceu.");

  const [campers, staff] = await Promise.all([resolvePeople(camperIds, "camper"), resolvePeople(staffIds, "staff")]);
  if (!Array.isArray(campers)) return fail(c, "CAMPERS_INVALID", campers.error, 404);
  if (!Array.isArray(staff)) return fail(c, "STAFF_INVALID", staff.error, 404);

  const user = c.get("user");
  const created = await insertOccurrence({
    campers,
    staff,
    description,
    createdByUserId: c.get("userId"),
    createdByName: user.name,
    createdByRole: c.get("activeRole"),
  });
  publish("occurrences");
  return c.json({ occurrence: serializeOccurrence(created) }, 201);
});

export default occurrences;
