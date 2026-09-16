import { listCampersOfGuardian } from "../models/campers";
import { findStaffByPhone } from "../models/staff";
import { ROLES, type Role, type User } from "../types";

/**
 * Which profiles this person may actually enter with.
 *
 * `users.roles` is what the account was created with, and it goes stale: the
 * admin adds someone to the TEAM ROSTER (collection `staff`) or enrols a kid
 * naming them as the guardian without anyone touching their account. So the
 * profiles offered are decided by the DATA, not by the stored list:
 *
 *   - "parent" ⇔ at least one kid whose guardian phone is this one. It is a
 *     FACT, never a grant: a stored "parent" with no kid enrolled is dropped
 *     (the mother of last year's camper is not a responsible this year).
 *   - "staff" ⇔ an ACTIVE record on the team roster with this phone — except
 *     for an ADMIN. Every admin is on the roster only so they have a room, a
 *     transport and a vest like everyone else (see models/staff
 *     `ensureAdminsOnRoster`): that record receives no kids and no team, and
 *     never becomes a team profile. An admin enters as admin — or as a
 *     responsible, when they really do have a kid at the camp.
 *
 * "admin" and "health_staff" are never derived: they are granted, not earned
 * from a roster row. Returned in the app's own order (see ROLES).
 *
 * The role a session LANDS on is `pickActiveRole` over THIS list (see
 * routes/auth.ts), and the switcher (POST /api/auth/role) accepts nothing else.
 */
export async function availableRolesOf(user: Pick<User, "phone" | "roles">): Promise<Role[]> {
  const roles = new Set<Role>(user.roles);
  const [staff, kids] = await Promise.all([findStaffByPhone(user.phone), listCampersOfGuardian(user.phone)]);
  // a responsible is whoever has a kid enrolled RIGHT NOW — nothing else
  if (kids.length > 0) roles.add("parent");
  else roles.delete("parent");
  // admins (and the medical team) already have their own profile: no second one from the roster
  if (roles.has("admin")) roles.delete("staff");
  else if (staff?.active && !roles.has("health_staff")) roles.add("staff");
  return ROLES.filter((r) => roles.has(r));
}
