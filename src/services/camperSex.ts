import { recordAiUsage } from "../models/aiUsage";
import { findBedroomById, listBedrooms } from "../models/bedrooms";
import { listCampers, updateCamper } from "../models/campers";
import { listStaff, updateStaff } from "../models/staff";
import type { BedroomGroup, CamperSex } from "../types";
import { GUESS_SEX_MODEL, guessCamperSex } from "./guessCamperSexAi";
import { guessIndividualNamesSex } from "./importAi";

/** A girls/boys room decides the kid's sex. Staff rooms (sleeping with parents) have none. */
export function sexFromGroup(group: BedroomGroup | string | null | undefined): CamperSex | null {
  if (group === "girls") return "F";
  if (group === "boys") return "M";
  return null;
}

export async function sexFromBedroomId(bedroomId: string | null | undefined): Promise<CamperSex | null> {
  if (!bedroomId) return null;
  const room = await findBedroomById(bedroomId);
  return sexFromGroup(room?.group);
}

/**
 * Bedroom wing wins when it has a sex. Otherwise the requested value (the
 * form's hidden GLM guess). If that's also missing and `guessIfMissing`, ask
 * GLM 5.3 flash from the name.
 */
export async function resolveCamperSex(opts: {
  name: string;
  bedroomId: string | null | undefined;
  /** already-known wing — skip the bedroom lookup (used right after a group change) */
  group?: BedroomGroup | null;
  requested: CamperSex | null | undefined;
  /** when the room has no sex and the form didn't send one, ask GLM from the name */
  guessIfMissing?: boolean;
  signal?: AbortSignal;
  userId?: string;
}): Promise<CamperSex | null> {
  const fromRoom = opts.group !== undefined ? sexFromGroup(opts.group) : await sexFromBedroomId(opts.bedroomId);
  if (fromRoom) return fromRoom;
  if (opts.requested === "F" || opts.requested === "M") return opts.requested;
  if (!opts.guessIfMissing || !opts.name.trim()) return null;
  const r = await guessCamperSex(opts.name, opts.signal);
  if (r.usage && opts.userId) {
    void recordAiUsage({ at: new Date(), vendor: GUESS_SEX_MODEL.vendor, model: GUESS_SEX_MODEL.id, kind: "guess_sex", userId: opts.userId, ...r.usage, ok: true });
  }
  return r.sex;
}

/** After a room's wing changes, rewrite every kid and team member sleeping there. */
export async function applyBedroomGroupToOccupants(
  bedroomId: string,
  group: BedroomGroup,
  opts?: { userId?: string; signal?: AbortSignal },
): Promise<{ campers: number; staff: number }> {
  const [kids, team] = await Promise.all([listCampers({ bedroom: bedroomId }), listStaff()]);
  const occupants = team.filter((s) => s.bedroom === bedroomId);
  const wingSex = sexFromGroup(group);
  let campers = 0;
  let staff = 0;
  for (const k of kids) {
    const sex = await resolveCamperSex({
      name: k.name,
      bedroomId,
      group,
      requested: null,
      guessIfMissing: wingSex === null,
      signal: opts?.signal,
      userId: opts?.userId,
    });
    if (sex === k.sex) continue;
    await updateCamper(k._id, { sex });
    campers++;
  }
  for (const s of occupants) {
    const sex = await resolveCamperSex({
      name: s.name,
      bedroomId,
      group,
      requested: null,
      guessIfMissing: wingSex === null,
      signal: opts?.signal,
      userId: opts?.userId,
    });
    if (sex === s.sex) continue;
    await updateStaff(s._id, { sex });
    staff++;
  }
  return { campers, staff };
}

const firstNameKey = (name: string): string =>
  name.split(" ")[0]?.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("pt-BR").replace(/[^a-z0-9]+/g, "").trim() ?? "";

export interface StaffSexEnsureResult {
  total: number;
  alreadySet: number;
  fromRoom: number;
  guessed: number;
  batchGuessed: number;
  fallbackGuessed: number;
  unknown: number;
  updated: number;
  unknownNames: string[];
}

function logStaffSexEnsure(r: StaffSexEnsureResult): void {
  const shown = r.unknownNames.slice(0, 8);
  const extra = r.unknownNames.length > shown.length ? ` +${r.unknownNames.length - shown.length}` : "";
  const unknown = r.unknown ? ` · ${r.unknown} unknown${shown.length ? ` (${shown.join(", ")}${extra})` : ""}` : "";
  console.log(`👤 staff sex: ${r.alreadySet}/${r.total} already set · ${r.fromRoom} room · ${r.guessed} guessed (${r.batchGuessed} batch / ${r.fallbackGuessed} one-by-one)${unknown}`);
}

/**
 * Fill `staff.sex` when missing. A girls/boys room wins; otherwise a name guess.
 * Already-set F/M is left alone. Best-effort: ambiguous names stay null for the next run.
 */
export async function ensureProbablyGenreOnStaff(opts?: { signal?: AbortSignal }): Promise<StaffSexEnsureResult> {
  const [staff, bedrooms] = await Promise.all([listStaff({ includeDraft: true }), listBedrooms({ includeDraft: true })]);
  const rooms = new Map(bedrooms.map((b) => [b._id, b]));
  const missing = staff.filter((s) => s.sex !== "F" && s.sex !== "M");
  const result: StaffSexEnsureResult = { total: staff.length, alreadySet: staff.length - missing.length, fromRoom: 0, guessed: 0, batchGuessed: 0, fallbackGuessed: 0, unknown: 0, updated: 0, unknownNames: [] };
  if (!missing.length) {
    logStaffSexEnsure(result);
    return result;
  }
  console.log(`👤 staff sex: filling ${missing.length} missing of ${staff.length}…`);

  const planned = new Map<string, CamperSex>();
  const fromRoomIds = new Set<string>();
  const needGuess: typeof missing = [];
  for (const s of missing) {
    const wing = sexFromGroup(s.bedroom ? rooms.get(s.bedroom)?.group : undefined);
    if (wing) {
      planned.set(s._id, wing);
      fromRoomIds.add(s._id);
    } else needGuess.push(s);
  }

  if (needGuess.length) {
    const names = [...new Set(needGuess.map((s) => s.name.split(" ")[0]?.trim()).filter((n): n is string => !!n))];
    const chunks = Array.from({ length: Math.ceil(names.length / 50) }, (_, i) => names.slice(i * 50, i * 50 + 50));
    const guesses = new Map<string, CamperSex>();
    const answers = await Promise.all(chunks.map((chunk) => guessIndividualNamesSex(chunk, opts?.signal)));
    for (const answer of answers) {
      for (const [name, sex] of Object.entries(answer)) if (sex) guesses.set(firstNameKey(name), sex);
    }
    console.log(`👤 staff sex: batch classified ${guesses.size}/${names.length} first name(s)`);
    for (const s of needGuess) {
      const sex = guesses.get(firstNameKey(s.name));
      if (sex) {
        planned.set(s._id, sex);
        result.batchGuessed++;
      }
    }
    const leftover = needGuess.filter((s) => !planned.has(s._id));
    if (leftover.length) {
      console.log(`👤 staff sex: guessing ${leftover.length} leftover name(s) one by one…`);
      for (const s of leftover) {
        const r = await guessCamperSex(s.name, opts?.signal);
        if (r.sex !== "F" && r.sex !== "M") continue;
        planned.set(s._id, r.sex);
        result.fallbackGuessed++;
      }
    }
  }

  for (const s of missing) {
    const sex = planned.get(s._id);
    if (!sex) {
      result.unknown++;
      result.unknownNames.push(s.name);
      continue;
    }
    if (fromRoomIds.has(s._id)) result.fromRoom++;
    else result.guessed++;
    await updateStaff(s._id, { sex });
    result.updated++;
  }
  logStaffSexEnsure(result);
  return result;
}
