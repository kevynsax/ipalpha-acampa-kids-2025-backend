/** Validation helpers shared by the people routes (staff, campers). */
import { countStaffPerBedroom, findBedroomById } from "../models/bedrooms";
import { countCampersPerBedroom } from "../models/campers";
import { findCategoryByKey } from "../models/categories";
import { bedroomCapacity } from "../types";

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
