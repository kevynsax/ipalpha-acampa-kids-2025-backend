import { recordAiUsage } from "../models/aiUsage";
import { findBedroomById } from "../models/bedrooms";
import { listCampers, updateCamper } from "../models/campers";
import { listStaff, updateStaff } from "../models/staff";
import type { BedroomGroup, CamperSex } from "../types";
import { GUESS_SEX_MODEL, guessCamperSex } from "./guessCamperSexAi";

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
