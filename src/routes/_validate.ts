/** Validation helpers shared by the people routes (staff, campers). */
import { countStaffPerBedroom, findBedroomById } from "../models/bedrooms";
import { countCampersPerBedroom } from "../models/campers";
import { findCategoryByKey } from "../models/categories";
import { findTeamById } from "../models/teams";
import { bedroomCapacity, MEDICATION_TIMES_MAX, MEDICATIONS_MAX, type Medication } from "../types";

export type Invalid = { error: string };

export function isInvalid(v: unknown): v is Invalid {
  return typeof v === "object" && v !== null && "error" in v;
}

/** Validates a single-choice option id against its category (null = not set). */
export async function parseSingle(value: unknown, categoryKey: string, label: string): Promise<string | null | Invalid> {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") return { error: `${label} inválido.` };
  const cat = await findCategoryByKey(categoryKey);
  if (!cat || !cat.options.some((o) => o.id === value)) return { error: `${label}: opção não encontrada.` };
  return value;
}

/** Validates a multi-choice list of option ids against its category. */
export async function parseMulti(value: unknown, categoryKey: string, label: string): Promise<string[] | Invalid> {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) return { error: `${label} inválido.` };
  const ids = [...new Set(value as string[])];
  if (ids.length === 0) return [];
  const cat = await findCategoryByKey(categoryKey);
  const known = new Set(cat?.options.map((o) => o.id) ?? []);
  if (ids.some((id) => !known.has(id))) return { error: `${label}: opção não encontrada.` };
  return ids;
}

export function parseText(value: unknown, max = 500): string | Invalid {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") return { error: "Texto inválido." };
  return value.trim().slice(0, max);
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Validates the medication list: each entry needs a name; times are "HH:MM"
 * (deduped, sorted); `asNeeded` is a boolean. Empty / missing = no medicines.
 */
export function parseMedications(value: unknown): Medication[] | Invalid {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return { error: "Medicação inválida." };
  if (value.length > MEDICATIONS_MAX) return { error: `No máximo ${MEDICATIONS_MAX} medicamentos.` };
  const out: Medication[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") return { error: "Medicação inválida." };
    const m = raw as Record<string, unknown>;
    const name = parseText(m.name, 120);
    const dose = parseText(m.dose, 120);
    const notes = parseText(m.notes, 300);
    if (isInvalid(name) || isInvalid(dose) || isInvalid(notes)) return { error: "Medicação inválida." };
    if (!name) continue; // a blank row from the form
    const timesRaw = m.times === undefined || m.times === null ? [] : m.times;
    if (!Array.isArray(timesRaw) || !timesRaw.every((t) => typeof t === "string" && TIME_RE.test(t))) return { error: `${name}: horário inválido (use HH:MM).` };
    const times = [...new Set(timesRaw as string[])].sort();
    if (times.length > MEDICATION_TIMES_MAX) return { error: `${name}: no máximo ${MEDICATION_TIMES_MAX} horários.` };
    if (m.asNeeded !== undefined && typeof m.asNeeded !== "boolean") return { error: "Medicação inválida." };
    out.push({ name, dose, times, asNeeded: m.asNeeded === true, notes });
  }
  return out;
}

/** Team id or null; { error } when the id is unknown. */
export async function parseTeam(value: unknown): Promise<string | null | Invalid> {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") return { error: "Time inválido." };
  if (!(await findTeamById(value))) return { error: "Time não encontrado." };
  return value;
}

/** Bedroom id or null; { error } when the id is unknown. */
export async function parseBedroom(value: unknown): Promise<string | null | Invalid> {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") return { error: "Quarto inválido." };
  if (!(await findBedroomById(value))) return { error: "Quarto não encontrado." };
  return value;
}

/**
 * Returns an error message when `bedroomId` has no free bed for one more
 * person (ignoring the person if they are already in it), or null when ok.
 * Counts staff AND campers.
 */
export async function bedroomFullMessage(bedroomId: string | null, currentBedroomId: string | null): Promise<string | null> {
  if (!bedroomId || bedroomId === currentBedroomId) return null;
  const room = await findBedroomById(bedroomId);
  if (!room) return null; // already validated
  const [st, ca] = await Promise.all([countStaffPerBedroom(), countCampersPerBedroom()]);
  const occupied = (st.get(bedroomId) ?? 0) + (ca.get(bedroomId) ?? 0);
  const capacity = bedroomCapacity(room);
  if (occupied >= capacity) {
    return `O quarto ${room.name} já está lotado (${occupied}/${capacity} camas).`;
  }
  return null;
}
