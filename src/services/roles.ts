import { listCampersOfGuardian } from "../models/campers";
import { findStaffByPhone } from "../models/staff";
import { ROLES, type Role, type User } from "../types";

/**
 * Which profiles this person may actually enter with.
 *
 * `users.roles` is what the account was created with, and it goes stale: the
 * admin adds someone to the TEAM ROSTER (collection `staff`) or enrols a kid
 * naming them as the guardian without anyone touching their account. So the
 * real list is the stored roles PLUS what the data says:
 *
 *   - an ACTIVE record on the team roster with this phone → "staff"
 *   - at least one kid whose guardian phone is this one   → "parent"
 *
 * "admin" and "health_staff" are never derived: they are granted, not earned
 * from a roster row. Returned in the app's own order (see ROLES).
 *
 * The role a session LANDS on is still `pickActiveRole(users.roles)` — only
 * the profiles offered by the switcher (POST /api/auth/role) come from here.
 */
export async function availableRolesOf(user: Pick<User, "phone" | "roles">): Promise<Role[]> {
  const roles = new Set<Role>(user.roles);
  const [staff, kids] = await Promise.all([findStaffByPhone(user.phone), listCampersOfGuardian(user.phone)]);
  // already on the medical team? that IS their team profile — don't offer a second one
  if (staff?.active && !roles.has("health_staff")) roles.add("staff");
  if (kids.length > 0) roles.add("parent");
  return ROLES.filter((r) => roles.has(r));
}
