import { config } from "./config";
import { getDb } from "./db";
import { claimCampersForAiReview, finishCamperAiReview, requeueStaleAiReviews } from "./models/campers";
import { claimStaffForAiReview, finishStaffAiReview, requeueStaleStaffAiReviews } from "./models/staff";
import { findCamperImport, listImportsPendingNotification, updateCamperImport } from "./models/camperImports";
import { recordAiUsage } from "./models/aiUsage";
import { sortCamperNotes } from "./services/camperNotesAi";
import { comteleEnabled, comteleSendSms } from "./services/comtele";
import { publish } from "./services/realtime";

const POLL_MS = 10_000;
const BATCH = 15;
const SLOW_IMPORT_MS = 5 * 60_000;

async function reviewOne(camper: Awaited<ReturnType<typeof claimCampersForAiReview>>[number]): Promise<void> {
  try {
    const line = (label: string, value: unknown) => value == null || value === "" ? "" : `${label}: ${String(value)}`;
    // Put every mutable scalar/text value in the source text as one labelled
    // record. This lets the strict bulk prompt return the whole cleaned value
    // (not merely append to it), including comma-separated room preferences.
    const reviewNotes = [
      camper.generalNotes,
      line("Preferência de quarto e cama", camper.bedroomPreference),
      line("Restrição alimentar", camper.foodRestrictions),
      line("Observações médicas", camper.healthNotes),
      line("Contato de emergência", camper.emergencyContact),
      line("Peso", camper.weightKg),
      line("Convênio médico", camper.insurance),
      line("Carteirinha", camper.insuranceCard),
      line("CPF da criança", camper.cpf),
      line("RG da criança", camper.rg),
      line("Escola", camper.school),
      line("Série", camper.schoolGrade),
      line("Igreja", camper.church),
      line("Convidado por", camper.invitedBy),
      line("CPF do responsável", camper.guardianCpf),
    ].filter(Boolean).join("\n");
    // Category ids and already structured medications are protected as
    // current state. The text fields above intentionally start empty so the
    // model can normalize (rather than append to) the imported spelling.
    const current = {
      allergies: camper.allergies,
      drugAllergies: camper.drugAllergies,
      healthIssues: camper.healthIssues,
      neurodivergent: camper.neurodivergent,
      medications: camper.medications,
      foodRestrictions: "",
      healthNotes: "",
      bedroomPreference: "",
      emergencyContact: "",
      weightKg: null,
      insurance: "",
      insuranceCard: "",
      cpf: "",
      rg: "",
      school: "",
      schoolGrade: "",
      church: "",
      invitedBy: "",
      guardianName: camper.guardianName,
      guardianPhone: camper.guardianPhone ?? "",
      guardianCpf: "",
      guardianEmail: camper.guardianEmail,
      generalNotes: "",
    };
    const result = await sortCamperNotes({ notes: reviewNotes, subject: "camper", current }, { mode: "bulk", onAttempt: (model, r) => void recordAiUsage({ at: new Date(), vendor: model.startsWith("grok") ? "xai" : model.startsWith("claude") ? "anthropic" : "openai", model, kind: "camper_notes", userId: "worker", ...r.usage, ok: r.ok }) });
    if (!result) throw new Error("Nenhum modelo respondeu.");
    const f = result.fields;
    await finishCamperAiReview(camper._id, {
      allergies: f.allergies,
      drugAllergies: f.drugAllergies,
      healthIssues: f.healthIssues,
      neurodivergent: f.neurodivergent,
      medications: f.medications,
      foodRestrictions: f.foodRestrictions,
      healthNotes: f.healthNotes,
      generalNotes: f.generalNotes,
      bedroomPreference: f.bedroomPreference,
      emergencyContact: f.emergencyContact || camper.emergencyContact,
      weightKg: f.weightKg ?? camper.weightKg,
      insurance: f.insurance || camper.insurance,
      insuranceCard: f.insuranceCard || camper.insuranceCard,
      cpf: f.cpf || camper.cpf,
      rg: f.rg || camper.rg,
      school: f.school || camper.school,
      schoolGrade: f.schoolGrade || camper.schoolGrade,
      church: f.church || camper.church,
      invitedBy: f.invitedBy || camper.invitedBy,
      guardianCpf: f.guardianCpf || camper.guardianCpf,
    });
  } catch (err) {
    await finishCamperAiReview(camper._id, {}, err instanceof Error ? err.message : "Falha na revisão por IA.");
  }
}

async function reviewStaffOne(member: Awaited<ReturnType<typeof claimStaffForAiReview>>[number]): Promise<void> {
  try {
    const notes = [member.healthNotes, member.foodRestrictions && `Restrição alimentar: ${member.foodRestrictions}`].filter(Boolean).join("\n");
    const result = await sortCamperNotes({ notes, subject: "staff", current: {
      allergies: member.allergies, drugAllergies: member.drugAllergies, healthIssues: member.healthIssues,
      neurodivergent: false, medications: member.medications, foodRestrictions: "", healthNotes: "",
      bedroomPreference: "", emergencyContact: "", weightKg: null, insurance: "", insuranceCard: "", cpf: "", rg: "", school: "", schoolGrade: "", church: "", invitedBy: "", guardianName: "", guardianPhone: "", guardianCpf: "", guardianEmail: "", generalNotes: "",
    } }, { mode: "bulk", onAttempt: (model, r) => void recordAiUsage({ at: new Date(), vendor: model.startsWith("grok") ? "xai" : model.startsWith("claude") ? "anthropic" : "openai", model, kind: "camper_notes", userId: "worker", ...r.usage, ok: r.ok }) });
    if (!result) throw new Error("Nenhum modelo respondeu.");
    const f = result.fields;
    await finishStaffAiReview(member._id, { allergies:f.allergies, drugAllergies:f.drugAllergies, healthIssues:f.healthIssues, medications:f.medications, foodRestrictions:f.foodRestrictions, healthNotes:f.healthNotes });
  } catch (err) { await finishStaffAiReview(member._id, {}, err instanceof Error ? err.message : "Falha na revisão por IA."); }
}

async function notifyFinishedImports(importIds: string[]): Promise<void> {
  const db = await getDb();
  for (const importId of [...new Set(importIds.filter(Boolean))]) {
    const [remainingCampers, remainingStaff] = await Promise.all([
      db.collection("campers").countDocuments({ importId, aiReviewStatus: { $in: ["pending", "processing"] } }),
      db.collection("staff").countDocuments({ importId, aiReviewStatus: { $in: ["pending", "processing"] } }),
    ]);
    const remaining = remainingCampers + remainingStaff;
    if (remaining > 0) continue;
    const record = await findCamperImport(importId);
    if (!record || record.status !== "completed") continue;
    const collection = record.subject === "staff" ? "staff" : "campers";
    const [total, errors] = await Promise.all([
      db.collection(collection).countDocuments({ importId }),
      db.collection(collection).countDocuments({ importId, aiReviewStatus: "error" }),
    ]);
    const errorRate = total ? errors / total : 0;
    const reviewStartedAt = record.reviewStartedAt ?? record.finishedAt ?? record.startedAt;
    const slowReview = Date.now() - reviewStartedAt.getTime() > SLOW_IMPORT_MS;
    let notificationFailed = false;
    const patch: Parameters<typeof updateCamperImport>[1] = {};
    if (slowReview && config.imports.adminPhone && !record.finishedSmsSentAt) {
      const sent = await comteleSendSms(config.imports.adminPhone, `AcampaKids: a revisão por IA da importação ${record.fileName} terminou. ${total - errors}/${total} ${record.subject === "staff" ? "membros" : "crianças"} revisados.`);
      if (sent.ok) patch.finishedSmsSentAt = new Date();
      else notificationFailed = true;
    }
    if (errorRate > .1 && config.imports.superAdminPhone && !record.errorSmsSentAt) {
      const sent = await comteleSendSms(config.imports.superAdminPhone, `AcampaKids: a revisão por IA de ${record.fileName} teve ${errors}/${total} erros. Verifique o worker.`);
      if (sent.ok) patch.errorSmsSentAt = new Date();
      else notificationFailed = true;
    }
    if (!notificationFailed) patch.notificationCheckedAt = new Date();
    await updateCamperImport(importId, patch);
  }
}

async function loop(): Promise<never> {
  await getDb();
  const [requeued, requeuedStaff] = await Promise.all([requeueStaleAiReviews(), requeueStaleStaffAiReviews()]);
  if (requeued + requeuedStaff) console.log(`🤖 requeued ${requeued} camper and ${requeuedStaff} staff review(s)`);
  await notifyFinishedImports((await listImportsPendingNotification()).map((r) => r._id));
  console.log(`🤖 import worker ready; batch=${BATCH}, poll=${POLL_MS / 1000}s, SMS=${comteleEnabled() ? "on" : "mock"}`);
  while (true) {
    const [campers, staff] = await Promise.all([claimCampersForAiReview(8), claimStaffForAiReview(7)]);
    const remaining = BATCH - campers.length - staff.length;
    if (remaining > 0) { const moreStaff = await claimStaffForAiReview(remaining); staff.push(...moreStaff); }
    const stillRemaining = BATCH - campers.length - staff.length;
    if (stillRemaining > 0) { const moreCampers = await claimCampersForAiReview(stillRemaining); campers.push(...moreCampers); }
    if (!campers.length && !staff.length) {
      await notifyFinishedImports((await listImportsPendingNotification()).map((r) => r._id));
      await Bun.sleep(POLL_MS);
      continue;
    }
    await Promise.all([...campers.map(reviewOne), ...staff.map(reviewStaffOne)]);
    publish("campers", "staff");
    await notifyFinishedImports([...campers, ...staff].map((x) => x.importId ?? ""));
  }
}

await loop();
