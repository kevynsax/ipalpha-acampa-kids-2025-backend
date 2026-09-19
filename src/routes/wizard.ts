import { Hono } from "hono";
import sampleJson from "../sample/camp.json";
import { requireAuth } from "../middleware/auth";
import { requireAdmin } from "../middleware/roles";
import { insertBedroom } from "../models/bedrooms";
import { insertCamper, listCampers } from "../models/campers";
import { insertStaff, listStaff, type StaffData } from "../models/staff";
import { insertTeam } from "../models/teams";
import { insertTransport } from "../models/transports";
import { ensureLoginAccount, isAdminPhone } from "../models/users";
import { publish } from "../services/realtime";
import type { BedroomGroup, CamperSex, Role, SessionUser } from "../types";

interface Env {
  Variables: {
    userId: string;
    sessionId: string;
    activeRole: Role;
    user: SessionUser;
  };
}

const wizard = new Hono<Env>();

/** The fictional camp shipped with the app (see data/make_sample.py at the repo root). */
const SAMPLE = sampleJson as {
  teams: { name: string; color: string }[];
  rooms: { name: string; group: BedroomGroup; bunkBeds: number; singleBeds: number }[];
  transports: { kind: "bus" | "car"; number?: string; color?: string; name?: string }[];
  staff: { name: string; phone: string; team: string | null; room: string | null; roomGroup: BedroomGroup | null; transportation: string | null; roomRole: "caretaker" | "helper"; active: boolean; healthNotes: string }[];
  campers: {
    name: string; birthDate: string | null; sex: CamperSex; cpf: string; rg: string; school: string; schoolGrade: string; church: string; invitedBy: string;
    team: string | null; room: string | null; roomGroup: BedroomGroup | null; transportation: string | null; bed: string | null; weightKg: number | null;
    allergies: string[]; healthIssues: string[]; foodRestrictions: string; healthNotes: string; generalNotes: string; bedroomPreference: string;
    insurance: string; insuranceCard: string; emergencyContact: string; guardianName: string; guardianPhone: string; guardianCpf: string; guardianEmail: string;
  }[];
};

wizard.use("*", requireAuth);

/**
 * POST /api/wizard/sample — admin. Fills an EMPTY camp with the fictional
 * sample (154 kids, 72 team members, teams, rooms and buses) so the whole
 * system can be tested end-to-end: names were shuffled within the same gender
 * and every phone / CPF / RG / e-mail is random. Refuses when the camp
 * already has people — clean up first.
 */
wizard.post("/sample", requireAdmin, async (c) => {
  const [campers, staff] = await Promise.all([listCampers(), listStaff({ includeDraft: true })]);
  const realStaff = staff.filter((s) => !isAdminPhone(s.phone));
  if (campers.length > 0 || realStaff.length > 0) {
    return c.json({ error: { code: "SAMPLE_NOT_EMPTY", message: "O acampamento já tem pessoas cadastradas. Limpe (Configurações → Limpeza) antes de carregar os dados de exemplo." } }, 409);
  }

  // teams → rooms → vehicles, so people can reference them right away
  const teamId = new Map<string, string>();
  for (const [i, t] of SAMPLE.teams.entries()) {
    const created = await insertTeam({ name: t.name, color: t.color, order: i });
    teamId.set(t.name, created._id);
  }

  const roomId = new Map<string, string>();
  for (const r of SAMPLE.rooms) {
    const created = await insertBedroom({ name: r.name, group: r.group, bunkBeds: r.bunkBeds, singleBeds: r.singleBeds, notes: "" });
    roomId.set(`${r.group}:${r.name}`, created._id);
  }

  const transportId = new Map<string, string>();
  for (const [i, t] of SAMPLE.transports.entries()) {
    const created = await insertTransport(
      t.kind === "bus" ? { kind: "bus", number: t.number, color: t.color, order: i } : { kind: "car", name: t.name, order: i },
    );
    transportId.set(t.kind === "bus" ? `bus:${t.number}` : "car", created._id);
  }

  let staffCreated = 0;
  for (const s of SAMPLE.staff) {
    const data: StaffData = {
      name: s.name,
      sex: s.roomGroup === "girls" ? "F" : s.roomGroup === "boys" ? "M" : null,
      probableGender: s.roomGroup === "girls" ? "F" : s.roomGroup === "boys" ? "M" : null,
      phone: s.phone,
      email: null,
      document: "",
      birthDate: null,
      active: s.active,
      team: s.team ? teamId.get(s.team) ?? null : null,
      bedroom: s.room && s.roomGroup ? roomId.get(`${s.roomGroup}:${s.room}`) ?? null : null,
      roomRole: s.roomRole,
      transportation: s.transportation ? transportId.get(s.transportation) ?? null : null,
      allergies: [],
      drugAllergies: [],
      foodRestrictions: "",
      healthIssues: [],
      medications: [],
      healthNotes: s.healthNotes,
    };
    await insertStaff(data);
    await ensureLoginAccount(s.name, s.phone, "staff");
    staffCreated++;
  }

  let campersCreated = 0;
  const familyAccounts = new Set<string>();
  for (const k of SAMPLE.campers) {
    await insertCamper({
      name: k.name,
      birthDate: k.birthDate,
      sex: k.sex,
      probableGender: k.sex,
      cpf: k.cpf,
      rg: k.rg,
      school: k.school,
      schoolGrade: k.schoolGrade,
      church: k.church,
      invitedBy: k.invitedBy,
      caretakerId: null,
      qrToken: crypto.randomUUID(),
      externalId: "",
      team: k.team ? teamId.get(k.team) ?? null : null,
      transportation: k.transportation ? transportId.get(k.transportation) ?? null : null,
      bed: k.bed || null,
      bedroom: k.room && k.roomGroup ? roomId.get(`${k.roomGroup}:${k.room}`) ?? null : null,
      weightKg: k.weightKg,
      allergies: k.allergies,
      drugAllergies: [],
      healthIssues: k.healthIssues,
      neurodivergent: false,
      medications: [],
      foodRestrictions: k.foodRestrictions,
      healthNotes: k.healthNotes,
      generalNotes: k.generalNotes,
      bedroomPreference: k.bedroomPreference,
      insurance: k.insurance,
      insuranceCard: k.insuranceCard,
      emergencyContact: k.emergencyContact,
      guardianName: k.guardianName,
      guardianPhone: k.guardianPhone,
      guardianCpf: k.guardianCpf,
      guardianEmail: k.guardianEmail,
      importId: null,
      aiReviewStatus: null,
      aiReviewError: "",
      aiReviewStartedAt: null,
      aiReviewFinishedAt: null,
    });
    // one login per family (siblings share the guardian phone)
    if (!familyAccounts.has(k.guardianPhone)) {
      familyAccounts.add(k.guardianPhone);
      await ensureLoginAccount(k.guardianName, k.guardianPhone, "parent");
    }
    campersCreated++;
  }

  console.log(`🧪 sample camp loaded by ${c.get("user").name}: ${campersCreated} campers, ${staffCreated} staff`);
  publish("campers", "staff", "bedrooms", "transports", "teams");
  return c.json({
    campers: campersCreated,
    staff: staffCreated,
    bedrooms: SAMPLE.rooms.length,
    transports: SAMPLE.transports.length,
    teams: SAMPLE.teams.length,
  });
});

export default wizard;
