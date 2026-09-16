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
 *   - "staff" ⇔ an ACTIVE record on the team roster with this phone. This is
 *     independent from grants: an administrator who also serves on the team
 *     receives both profiles and chooses one immediately after OTP.
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
  if (staff?.active) roles.add("staff");
  else roles.delete("staff");
  return ROLES.filter((r) => roles.has(r));
}
