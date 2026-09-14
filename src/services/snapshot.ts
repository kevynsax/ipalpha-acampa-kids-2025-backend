import { listBedrooms } from "../models/bedrooms";
import { listCampers } from "../models/campers";
import { listCategories } from "../models/categories";
import { listInstructions } from "../models/instructions";
import { listOccurrences } from "../models/occurrences";
import { listPrepSections } from "../models/preparation";
import { listEvents, listRoles } from "../models/schedule";
import { listStaff } from "../models/staff";
import { listTeams } from "../models/teams";
import { listScores } from "../models/scores";
import { serializeTeam } from "../routes/teams";
import { serializeScore } from "../routes/scores";
import { occupancy, serializeBedroom } from "../routes/bedrooms";
import { serializeCamperList } from "../routes/campers";
import { serializeCategory } from "../routes/categories";
import { serializeInstruction } from "../routes/instructions";
import { serializeOccurrence } from "../routes/occurrences";
import { serializePrepSection } from "../routes/preparation";
import { serializeEvent, serializeRole } from "../routes/schedule";
import { serializeSettings, serializeSettingsForManager } from "../routes/settings";
import { serializeStaffList } from "../routes/staff";
import { getSettings } from "../models/settings";
import type { Role } from "../types";
import { COLLECTIONS, type Collection, type Snapshot } from "./realtime";
import { canSeeBedroom, canSeeDoc, canSeePrep, isParent, resolveScope, scopeEvent, scopeRoles, type Viewer } from "./scope";
import { parentEvents } from "./camp";

/**
 * Collections each role may read (mirrors the REST `requireRole` guards).
 * Staff/health staff get campers, staff and bedrooms FILTERED to their own
 * room, and the programme with only THEIR roles in each event (see ./scope.ts).
 */
const READABLE: Record<Role, readonly Collection[]> = {
  admin: COLLECTIONS,
  staff: ["campers", "staff", "bedrooms", "categories", "teams", "scores", "roles", "events", "preparation", "instructions", "occurrences", "settings"],
  health_staff: ["campers", "staff", "bedrooms", "categories", "teams", "scores", "roles", "events", "preparation", "instructions", "occurrences", "settings"],
  // parents: their own kids + rooms, the team of those rooms / important contacts (inside the window), the programme
  parent: ["campers", "staff", "bedrooms", "categories", "teams", "roles", "events", "preparation", "settings"],
};

/**
 * Cache key for a built payload: admins get the same data regardless of who
 * they are; staff and parent payloads differ per person (scoped to their
 * room / their kids).
 */
export function snapshotKey(viewer: Viewer): string {
  return viewer.activeRole === "admin" ? viewer.activeRole : `${viewer.activeRole}|${viewer.phone}`;
}

/** Reads and serializes `names` exactly like the REST endpoints do, honouring the viewer's role and scope. */
export async function loadCollections(viewer: Viewer, names: readonly Collection[] = COLLECTIONS): Promise<Snapshot> {
  const role: Role = viewer.activeRole;
  const allowed = new Set(READABLE[role]);
  let wanted = names.filter((n) => allowed.has(n));
  const out: Snapshot = {};
  const scope = await resolveScope(viewer);
  // Occurrences are reserved for admins and people explicitly listed on the
  // medical team. Ordinary staff sessions must not receive even an empty
  // collection from this read path.
  if (!scope.all && !scope.medical) wanted = wanted.filter((name) => name !== "occurrences");

  // roles and events are scoped together: a non-admin only learns about the
  // roles that survive in their events, so a change to either re-sends both
  const wantsSchedule = wanted.includes("roles") || wanted.includes("events");
  if (wantsSchedule && !scope.all) wanted = [...new Set([...wanted, "roles" as const, "events" as const])];
  const schedule = wantsSchedule
    ? (async () => {
        const [roles, all] = await Promise.all([listRoles(), listEvents()]);
        const roleById = new Map(roles.map((r) => [r._id, r]));
        // parents only get the programme from the check-in start onwards
        const events = isParent(scope) ? parentEvents(await getSettings(), all) : all;
        const scopedEvents = events.map((e) => scopeEvent(scope, e, roleById));
        return { roles: scopeRoles(scope, roles, scopedEvents), events: scopedEvents };
      })()
    : null;

  await Promise.all(
    wanted.map(async (name) => {
      switch (name) {
        case "campers":
          out.campers = serializeCamperList(await listCampers(), scope);
          break;
        case "staff":
          out.staff = serializeStaffList(await listStaff(), scope);
          break;
        case "bedrooms": {
          const [list, occ] = await Promise.all([listBedrooms(), occupancy()]);
          out.bedrooms = list.filter((b) => canSeeBedroom(scope, b._id)).map((b) => serializeBedroom(b, occ.get(b._id)));
          break;
        }
        case "categories": {
          const isAdmin = role === "admin";
          out.categories = (await listCategories()).map((cat) => {
            const s = serializeCategory(cat);
            return isAdmin ? s : { ...s, options: s.options.filter((o) => o.active) };
          });
          break;
        }
        case "teams":
          out.teams = (await listTeams()).map(serializeTeam);
          break;
        case "scores":
          out.scores = (await listScores()).map(serializeScore);
          break;
        case "roles":
          out.roles = (await schedule!).roles.map(serializeRole);
          break;
        case "events":
          out.events = (await schedule!).events.map(serializeEvent);
          break;
        case "preparation":
          out.preparation = (await listPrepSections()).filter((s) => canSeePrep(scope, s)).map(serializePrepSection);
          break;
        case "instructions":
          out.instructions = (await listInstructions()).filter((d) => canSeeDoc(scope, d)).map(serializeInstruction);
          break;
        case "occurrences":
          if (scope.all) out.occurrences = (await listOccurrences()).map(serializeOccurrence);
          else if (scope.medical) out.occurrences = (await listOccurrences()).filter((occurrence) => occurrence.campers.length > 0).map(serializeOccurrence);
          break;
        case "settings":
          // offenders list (out-of-scope emergency QR) is manager-only
          out.settings = scope.all
            ? await serializeSettingsForManager(await getSettings())
            : await serializeSettings(await getSettings());
          break;
      }
    }),
  );

  return out;
}
