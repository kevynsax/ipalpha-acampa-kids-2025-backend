import { closeDb } from "./src/db";
import { getSettings, updateSettings } from "./src/models/settings";
import { listStaff } from "./src/models/staff";
import { loadCollections } from "./src/services/snapshot";
const staff = await listStaff({ active: true });
const me = staff.find((s) => s.phone)!;
const viewer = { activeRole: "health_staff" as const, phone: me.phone! };
const before = await loadCollections(viewer, ["campers", "bedrooms"]);
await updateSettings({ medicalStaff: { staffIds: [me._id] } });
const after = await loadCollections(viewer, ["campers", "bedrooms"]);
await updateSettings({ medicalStaff: { staffIds: [] } }); // restore
console.log(`${me.name}: campers ${before.campers!.length} → ${after.campers!.length}, bedrooms ${before.bedrooms!.length} → ${after.bedrooms!.length}, redacted=${after.campers!.some((k: any) => k.redacted)}`);
console.log("settings.medicalStaff:", (await getSettings()).medicalStaff);
await closeDb();
