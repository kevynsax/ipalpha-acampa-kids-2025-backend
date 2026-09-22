import { listCamps, type Camp } from "../models/camps";
import type { Role, User } from "../types";
import { activeCampId, withCamp } from "./campContext";
import { resolveScope } from "./scope";

export interface SwitchableCamp {
  id: string;
  label: string;
  year: number;
  active: boolean;
  archivedAt: string | null;
}

function serialize(c: Camp): SwitchableCamp {
  return { id: c._id, label: c.label, year: c.year, active: c.active, archivedAt: c.archivedAt ? c.archivedAt.toISOString() : null };
}

/**
 * May this person switch camps / hold a history session? A global admin,
 * or a staff/health_staff session whose scope in the ACTIVE camp is an
 * organizer (`resolveScope(...).all`) — evaluated in the active camp
 * regardless of which camp the session itself is currently in.
 */
export async function canSwitchCamps(user: Pick<User, "roles" | "phone">, activeRole: Role): Promise<boolean> {
  if (user.roles.includes("admin")) return true;
  if (activeRole !== "staff" && activeRole !== "health_staff") return false;
  return withCamp(activeCampId(), async () => (await resolveScope({ activeRole, phone: user.phone })).all);
}

/** The switchable camp list for `/auth/me`, `/otp/verify`, `/role` and `/camp` — `undefined` when the caller may not switch (field omitted). */
export async function switchableCamps(user: Pick<User, "roles" | "phone">, activeRole: Role): Promise<SwitchableCamp[] | undefined> {
  if (!(await canSwitchCamps(user, activeRole))) return undefined;
  return (await listCamps()).map(serialize);
}
