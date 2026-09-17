import { config } from "./config";
import { getDb } from "./db";
import { claimCampersForAiReview, finishCamperAiReview, requeueStaleAiReviews } from "./models/campers";
import { claimStaffForAiReview, finishStaffAiReview, requeueStaleStaffAiReviews } from "./models/staff";
import { AI_REVIEW_MAX_ATTEMPTS, aiReviewExhaustedFilter, aiReviewRetryDelayMs, aiReviewRetryPendingFilter, formatRetryDelay } from "./models/aiReviewRetry";
import { findCamperImport, listImportsPendingNotification, updateCamperImport } from "./models/camperImports";
import { recordAiUsage } from "./models/aiUsage";
import { sortCamperNotes, type RawNotesCall } from "./services/camperNotesAi";
import { normalizeCamperObservations } from "./services/observationNormalizeAi";
import { comteleEnabled, comteleSendSms } from "./services/comtele";
import { publish } from "./services/realtime";

const POLL_MS = 10_000;
const BATCH = 15;
const SLOW_IMPORT_MS = 5 * 60_000;
/** idle heartbeat: remind the terminal the worker is alive every ~5 min */
const IDLE_HEARTBEAT_POLLS = 30;

const stamp = () => new Date().toISOString();
function log(tag: string, msg: string): void {
  console.log(`[${stamp()}] [worker:${tag}] ${msg}`);
}
/** "retry 2/5 in 30min" or "exhausted after 5 attempts, needs manual review" */
function retryNote(attempts: number): string {
  if (attempts >= AI_REVIEW_MAX_ATTEMPTS) return `exhausted after ${attempts} attempts, needs manual review`;
  return `retry ${attempts + 1}/${AI_REVIEW_MAX_ATTEMPTS} in ${formatRetryDelay(aiReviewRetryDelayMs(attempts))}`;
}

const backendUrl = (process.env.BACKEND_URL ?? `http://localhost:${config.port}`).replace(/\/$/, "");
if (!config.worker.secret) log("startup", "WORKER_SECRET empty — backend notify disabled, websocket event will not fire");

/**
 * Tells the main backend one record reached a terminal review state so it can
 * push the websocket event (the worker process itself holds no sockets).
 * Best-effort: a failed callback never fails the review, it only logs.
 */
async function notifyBackend(kind: "camper" | "staff", id: string, status: "reviewed" | "error", attempts: number): Promise<void> {
  if (!config.worker.secret) return;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(`${backendUrl}/api/worker/reviewed`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.worker.secret}` },
      body: JSON.stringify({ kind, id, status, attempts }),
      signal: ctrl.signal,
    });
    log("notify", `${kind} ${id} — backend callback ${res.ok ? "ok" : `FAILED (http ${res.status})`}`);
  } catch (err) {
    log("notify", `${kind} ${id} — backend callback FAILED (${err instanceof Error ? err.message : "unreachable"})`);
  } finally {
    clearTimeout(timer);
  }
}

/** one line per model attempt inside a record review (failures stay visible) */
function attemptLogger(who: string): (model: string, r: RawNotesCall) => void {
  return (model, r) => {
    void recordAiUsage({ at: new Date(), vendor: model.startsWith("grok") ? "xai" : model.startsWith("claude") ? "anthropic" : "openai", model, kind: "camper_notes", userId: "worker", ...r.usage, ok: r.ok });
    log("ai", `${who} — model=${model} ok=${r.ok} tokens=${r.usage.promptTokens}+${r.usage.completionTokens}${r.ok ? "" : ` error=${r.error ?? "unknown"}`}`);
  };
}

async function reviewOne(camper: Awaited<ReturnType<typeof claimCampersForAiReview>>[number]): Promise<void> {
  const who = `camper "${camper.name}" (${camper._id})`;
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
    log("camper", `${who} — start, notes=${reviewNotes.length} chars`);
    const result = await sortCamperNotes({ notes: reviewNotes, subject: "camper", current }, { mode: "bulk", onAttempt: attemptLogger(who) });
    if (!result) throw new Error("Nenhum modelo respondeu.");
    const f = result.fields;
    log("camper", `${who} — sorted by ${result.model}: allergies=${f.allergies.length} drugAllergies=${f.drugAllergies.length} healthIssues=${f.healthIssues.length} medications=${f.medications.length} neurodivergent=${f.neurodivergent}`);
    const observations=await normalizeCamperObservations(f.generalNotes);
    void recordAiUsage({at:new Date(),vendor:observations.vendor,model:observations.model,kind:"normalize_observations",userId:"worker",...observations.usage,ok:observations.ok});
    await finishCamperAiReview(camper._id, {
      allergies: f.allergies,
      drugAllergies: f.drugAllergies,
      healthIssues: f.healthIssues,
      neurodivergent: f.neurodivergent,
      medications: f.medications,
      foodRestrictions: f.foodRestrictions,
      healthNotes: f.healthNotes,
      generalNotes: observations.value,
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
    log("camper", `${who} — done`);
    await notifyBackend("camper", camper._id, "reviewed", 0);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Falha na revisão por IA.";
    const updated = await finishCamperAiReview(camper._id, {}, message);
    const attempts = updated?.aiReviewAttempts ?? 1;
    log("camper", `${who} — ERROR: ${message} — ${retryNote(attempts)}`);
    if (attempts >= AI_REVIEW_MAX_ATTEMPTS) await notifyBackend("camper", camper._id, "error", attempts);
  }
}

async function reviewStaffOne(member: Awaited<ReturnType<typeof claimStaffForAiReview>>[number]): Promise<void> {
  const who = `staff "${member.name}" (${member._id})`;
  try {
    const notes = [member.healthNotes, member.foodRestrictions && `Restrição alimentar: ${member.foodRestrictions}`].filter(Boolean).join("\n");
    log("staff", `${who} — start, notes=${notes.length} chars`);
    const result = await sortCamperNotes({ notes, subject: "staff", current: {
      allergies: member.allergies, drugAllergies: member.drugAllergies, healthIssues: member.healthIssues,
      neurodivergent: false, medications: member.medications, foodRestrictions: "", healthNotes: "",
      bedroomPreference: "", emergencyContact: "", weightKg: null, insurance: "", insuranceCard: "", cpf: "", rg: "", school: "", schoolGrade: "", church: "", invitedBy: "", guardianName: "", guardianPhone: "", guardianCpf: "", guardianEmail: "", generalNotes: "",
    } }, { mode: "bulk", onAttempt: attemptLogger(who) });
    if (!result) throw new Error("Nenhum modelo respondeu.");
    const f = result.fields;
    log("staff", `${who} — sorted by ${result.model}: allergies=${f.allergies.length} drugAllergies=${f.drugAllergies.length} healthIssues=${f.healthIssues.length} medications=${f.medications.length}`);
    await finishStaffAiReview(member._id, { allergies:f.allergies, drugAllergies:f.drugAllergies, healthIssues:f.healthIssues, medications:f.medications, foodRestrictions:f.foodRestrictions, healthNotes:f.healthNotes });
    log("staff", `${who} — done`);
    await notifyBackend("staff", member._id, "reviewed", 0);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Falha na revisão por IA.";
    const attempts = await finishStaffAiReview(member._id, {}, message);
    log("staff", `${who} — ERROR: ${message} — ${retryNote(attempts)}`);
    if (attempts >= AI_REVIEW_MAX_ATTEMPTS) await notifyBackend("staff", member._id, "error", attempts);
  }
}

/** last "waiting" count per import, so the cooldown hours don't spam the terminal */
const notifyRemaining = new Map<string, number>();

async function notifyFinishedImports(importIds: string[]): Promise<void> {
  const db = await getDb();
  for (const importId of [...new Set(importIds.filter(Boolean))]) {
    const [remainingCampers, remainingStaff, retryCampers, retryStaff] = await Promise.all([
      db.collection("campers").countDocuments({ importId, aiReviewStatus: { $in: ["pending", "processing"] } }),
      db.collection("staff").countDocuments({ importId, aiReviewStatus: { $in: ["pending", "processing"] } }),
      db.collection("campers").countDocuments({ importId, ...aiReviewRetryPendingFilter() }),
      db.collection("staff").countDocuments({ importId, ...aiReviewRetryPendingFilter() }),
    ]);
    const remaining = remainingCampers + remainingStaff + retryCampers + retryStaff;
    if (remaining > 0) {
      // errors with tries left are still working (cooldown) — log only when the count changes
      if (notifyRemaining.get(importId) !== remaining) {
        notifyRemaining.set(importId, remaining);
        log("notify", `import ${importId} — waiting, ${remaining} review(s) left (${retryCampers + retryStaff} in cooldown)`);
      }
      continue;
    }
    notifyRemaining.delete(importId);
    const record = await findCamperImport(importId);
    if (!record || record.status !== "completed") continue;
    const collection = record.subject === "staff" ? "staff" : "campers";
    const [total, errors] = await Promise.all([
      db.collection(collection).countDocuments({ importId }),
      db.collection(collection).countDocuments({ importId, ...aiReviewExhaustedFilter() }),
    ]);
    const errorRate = total ? errors / total : 0;
    const reviewStartedAt = record.reviewStartedAt ?? record.finishedAt ?? record.startedAt;
    const slowReview = Date.now() - reviewStartedAt.getTime() > SLOW_IMPORT_MS;
    let notificationFailed = false;
    const patch: Parameters<typeof updateCamperImport>[1] = {};
    log("notify", `import "${record.fileName}" (${importId}) — review finished: ${total - errors}/${total} ok, ${errors} error(s)`);
    if (slowReview && config.imports.adminPhone && !record.finishedSmsSentAt) {
      const sent = await comteleSendSms(config.imports.adminPhone, `AcampaKids: a revisão por IA da importação ${record.fileName} terminou. ${total - errors}/${total} ${record.subject === "staff" ? "membros" : "crianças"} revisados.`);
      log("notify", `import "${record.fileName}" — finished SMS ${sent.ok ? "sent" : "FAILED"}`);
      if (sent.ok) patch.finishedSmsSentAt = new Date();
      else notificationFailed = true;
    }
    if (errorRate > .1 && config.imports.superAdminPhone && !record.errorSmsSentAt) {
      const sent = await comteleSendSms(config.imports.superAdminPhone, `AcampaKids: a revisão por IA de ${record.fileName} teve ${errors}/${total} erros. Verifique o worker.`);
      log("notify", `import "${record.fileName}" — error-rate SMS ${sent.ok ? "sent" : "FAILED"}`);
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
  if (requeued + requeuedStaff) log("startup", `requeued ${requeued} camper and ${requeuedStaff} staff review(s)`);
  await notifyFinishedImports((await listImportsPendingNotification()).map((r) => r._id));
  log("startup", `import worker ready; batch=${BATCH}, poll=${POLL_MS / 1000}s, SMS=${comteleEnabled() ? "on" : "mock"}`);
  let idlePolls = 0;
  while (true) {
    const [campers, staff] = await Promise.all([claimCampersForAiReview(8), claimStaffForAiReview(7)]);
    const remaining = BATCH - campers.length - staff.length;
    if (remaining > 0) { const moreStaff = await claimStaffForAiReview(remaining); staff.push(...moreStaff); }
    const stillRemaining = BATCH - campers.length - staff.length;
    if (stillRemaining > 0) { const moreCampers = await claimCampersForAiReview(stillRemaining); campers.push(...moreCampers); }
    if (!campers.length && !staff.length) {
      idlePolls++;
      if (idlePolls % IDLE_HEARTBEAT_POLLS === 0) log("idle", `nothing pending (${idlePolls} empty polls) — worker alive`);
      await notifyFinishedImports((await listImportsPendingNotification()).map((r) => r._id));
      await Bun.sleep(POLL_MS);
      continue;
    }
    idlePolls = 0;
    log("batch", `claimed ${campers.length} camper(s) + ${staff.length} staff review(s)`);
    await Promise.all([...campers.map(reviewOne), ...staff.map(reviewStaffOne)]);
    log("batch", `finished ${campers.length} camper(s) + ${staff.length} staff review(s) — publishing`);
    publish("campers", "staff");
    await notifyFinishedImports([...campers, ...staff].map((x) => x.importId ?? ""));
  }
}

await loop();
