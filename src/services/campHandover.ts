import { deleteFile } from "../models/files";
import {
  resetCampSettings,
  wipeBedrooms,
  wipeCampers,
  wipeGallery,
  wipeImportCache,
  wipeMedications,
  wipeNotices,
  wipeOccurrences,
  wipeSchedule,
  wipeScores,
  wipeStaff,
  wipeTeams,
  wipeTransports,
  wipeUsersExcept,
  wipeWelcomes,
  type CleanupGroup,
} from "../models/cleanup";
import { loadAdminPhones, replaceAdminAccount } from "../models/users";
import { updateSettings } from "../models/settings";
import { adminInviteEmail } from "./emails";
import { sendMail } from "./mail";
import { publish } from "./realtime";

export interface CampHandoverInput {
  superPhone: string;
  name: string;
  phone: string;
  email: string;
  notify: boolean;
}

export interface CampHandoverResult {
  removed: Partial<Record<CleanupGroup, number>>;
  usersRemoved: number;
  mailed: boolean;
  admin: { id: string; name: string; phone: string };
}

/**
 * Starts a new camp for a new admin. Every non-super login is deleted before
 * the new admin is recreated, so stale roles, OTPs and sessions never survive.
 */
export async function handoverCamp(input: CampHandoverInput): Promise<CampHandoverResult> {
  const removed: Partial<Record<CleanupGroup, number>> = {};

  const gallery = await wipeGallery();
  removed.gallery = gallery.count;
  await Promise.all(gallery.fileIds.map((id) => deleteFile(id)));
  removed.occurrences = await wipeOccurrences();
  removed.medications = await wipeMedications();
  removed.scores = await wipeScores();
  removed.schedule = await wipeSchedule(false);
  removed.campers = await wipeCampers();
  removed.staff = await wipeStaff([]);
  removed.teams = await wipeTeams();
  removed.bedrooms = await wipeBedrooms();
  removed.transports = await wipeTransports();
  removed.welcomes = await wipeWelcomes();
  removed.notices = await wipeNotices();

  await resetCampSettings();
  await wipeImportCache();

  // Requirement: only the deployment owner survives; then create the new admin.
  const usersRemoved = await wipeUsersExcept([input.superPhone]);
  const admin = await replaceAdminAccount(input.name, input.phone, input.email);
  await loadAdminPhones();
  await updateSettings({ wizardMode: true });

  let mailed = false;
  if (input.notify) {
    const mail = adminInviteEmail({ name: admin.name, phone: admin.phone });
    const sent = await sendMail(input.email, mail.subject, mail.html, mail.text);
    mailed = sent.ok;
    if (!sent.ok) console.error("[mail] admin invite failed:", sent.message);
  }

  publish("campers", "staff", "bedrooms", "transports", "teams", "scores", "roles", "events", "occurrences", "medications", "gallery", "settings");

  return {
    removed,
    usersRemoved,
    mailed,
    admin: { id: admin._id, name: admin.name, phone: admin.phone },
  };
}
