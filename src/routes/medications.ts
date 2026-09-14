import { Hono, type Context } from "hono";
import { requireAuth } from "../middleware/auth";
import { findCamperById } from "../models/campers";
import { deleteMedicationDose, findMedicationDoseById, insertMedicationDose, listMedicationDoses, medKeyOf } from "../models/medications";
import { publish } from "../services/realtime";
import { resolveScope } from "../services/scope";
import { todayInSaoPaulo } from "../utils";
import { MEDICATION_SOS_SLOT, type MedicationDose, type Role, type SessionUser } from "../types";

interface Env {
  Variables: {
    userId: string;
    sessionId: string;
    activeRole: Role;
    user: SessionUser;
  };
}

/**
 * Medicações — the medical team's daily checklist of the CONTINUOUS
 * medication the kids take. The prescription lives on the camper
 * (`Camper.medications`, filled by the parents / admin); here the team only
 * ticks what was actually given, so nobody has to remember whether the 12:30
 * pill already went out.
 *
 *   GET    /api/medications          every tick (admin / organizer / medical)
 *   POST   /api/medications          tick one dose { camperId, medName, day?, slot, note? }
 *   DELETE /api/medications/:id      untick (a mistake)
 *
 * A scheduled slot ("HH:MM") is one tick per kid, medicine and day — posting
 * it twice returns the same record. "quando necessário" doses (slot "sos")
 * may repeat in the same day.
 */
const medications = new Hono<Env>();

const NOTE_MAX = 300;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function fail(c: Context, code: string, message: string, status: 400 | 403 | 404 = 400) {
  return c.json({ error: { code, message } }, status);
}

export function serializeMedicationDose(d: MedicationDose) {
  return {
    id: d._id,
    camperId: d.camperId,
    camperName: d.camperName,
    medKey: d.medKey,
    medName: d.medName,
    dose: d.dose,
    day: d.day,
    slot: d.slot,
    givenAt: d.givenAt,
    by: { id: d.byUserId, name: d.byName },
    note: d.note,
  };
}

/** Admin / organizer (`all`) or the MEDICAL team. Nobody else sees the checklist. */
async function medicationAccess(c: Context<Env, string>): Promise<boolean> {
  const role = c.get("activeRole");
  if (role === "admin") return true;
  if (role !== "staff" && role !== "health_staff") return false;
  const scope = await resolveScope(c.get("user"));
  return scope.all || scope.medical;
}

medications.use("*", requireAuth);

medications.get("/", async (c) => {
  if (!(await medicationAccess(c))) return fail(c, "FORBIDDEN", "Só a equipe médica e a organização veem as medicações.", 403);
  return c.json({ medications: (await listMedicationDoses()).map(serializeMedicationDose) });
});

medications.post("/", async (c) => {
  if (!(await medicationAccess(c))) return fail(c, "FORBIDDEN", "Só a equipe médica e a organização marcam medicações.", 403);
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) return fail(c, "BODY_INVALID", "Corpo da requisição inválido.");

  const camper = typeof body.camperId === "string" ? await findCamperById(body.camperId) : null;
  if (!camper) return fail(c, "CAMPER_NOT_FOUND", "Criança não encontrada.", 404);

  const medName = typeof body.medName === "string" ? body.medName.trim().slice(0, 120) : "";
  if (!medName) return fail(c, "MED_REQUIRED", "Informe qual medicamento foi dado.");
  const medKey = medKeyOf(medName);
  // the medicine must be on the kid's prescription (the parents' / admin's list)
  const prescribed = camper.medications.find((m) => medKeyOf(m.name) === medKey);
  if (!prescribed) return fail(c, "MED_NOT_PRESCRIBED", `${medName} não está na medicação de ${camper.name.split(" ")[0]}.`, 404);

  const slot = typeof body.slot === "string" ? body.slot.trim() : "";
  const scheduled = TIME_RE.test(slot);
  if (!scheduled && slot !== MEDICATION_SOS_SLOT) return fail(c, "SLOT_INVALID", "Horário inválido (use HH:MM ou \"sos\").");
  if (scheduled && !prescribed.times.includes(slot)) return fail(c, "SLOT_UNKNOWN", `${medName} não tem o horário ${slot}.`);
  if (!scheduled && !prescribed.asNeeded) return fail(c, "SLOT_UNKNOWN", `${medName} tem horário fixo.`);

  const day = typeof body.day === "string" && DAY_RE.test(body.day) ? body.day : todayInSaoPaulo();
  const note = typeof body.note === "string" ? body.note.trim().slice(0, NOTE_MAX) : "";
  const user = c.get("user");
  const created = await insertMedicationDose(
    { camperId: camper._id, camperName: camper.name, medKey, medName: prescribed.name, dose: prescribed.dose, day, slot, byUserId: user.id, byName: user.name, note },
    scheduled,
  );
  publish("medications");
  return c.json({ medication: serializeMedicationDose(created) }, 201);
});

medications.delete("/:id", async (c) => {
  if (!(await medicationAccess(c))) return fail(c, "FORBIDDEN", "Só a equipe médica e a organização marcam medicações.", 403);
  const dose = await findMedicationDoseById(c.req.param("id"));
  if (!dose) return fail(c, "DOSE_NOT_FOUND", "Marcação não encontrada.", 404);
  await deleteMedicationDose(dose._id);
  publish("medications");
  return c.json({ success: true });
});

export default medications;
