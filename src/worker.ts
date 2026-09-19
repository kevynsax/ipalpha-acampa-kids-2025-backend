import { config } from "./config";
import { getDb } from "./db";
import { claimCampersForAiReview, finishCamperAiReview, requeueStaleAiReviews } from "./models/campers";
import { claimStaffForAiReview, finishStaffAiReview, requeueStaleStaffAiReviews } from "./models/staff";
import { AI_REVIEW_MAX_ATTEMPTS, aiReviewExhaustedFilter, aiReviewRetryDelayMs, aiReviewRetryPendingFilter, formatRetryDelay } from "./models/aiReviewRetry";
import { findCamperImport, listImportsPendingNotification, updateCamperImport } from "./models/camperImports";
import { recordAiUsage } from "./models/aiUsage";
import { sortCamperNotes, type RawNotesCall } from "./services/camperNotesAi";
import { structureImportHealthWithJev } from "./services/importHealthStructureAi";
import { cleanupImportObservations } from "./services/importObservationCleanupAi";
import { comteleEnabled, comteleSendSms } from "./services/comtele";

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
    const reviewNotes = camper.generalNotes.trim();
    log("camper", `${who} — start, observations=${reviewNotes.length} chars`);
    const health = await structureImportHealthWithJev(reviewNotes, {
      allergies: camper.allergies,
      drugAllergies: camper.drugAllergies,
      healthIssues: camper.healthIssues,
      neurodivergent: camper.neurodivergent,
    }, "camper");
    void recordAiUsage({ at: new Date(), vendor: health.vendor, model: health.model, kind: "structure_health", userId: "worker", ...health.usage, ok: health.ok });
    log("camper", `${who} — Jev structured: allergies=${health.allergies.length} drugAllergies=${health.drugAllergies.length} healthIssues=${health.healthIssues.length} neurodivergent=${health.neurodivergent}`);

    const cleanup = await cleanupImportObservations({
      notes: reviewNotes,
      subject: "camper",
      structured: { ...health, medications: camper.medications },
      currentFoodRestrictions: camper.foodRestrictions,
      currentHealthNotes: camper.healthNotes,
    });
    void recordAiUsage({ at: new Date(), vendor: cleanup.vendor, model: cleanup.model, kind: "normalize_observations", userId: "worker", ...cleanup.usage, ok: cleanup.ok });
    if (!health.ok) throw new Error(`Jev: ${health.error ?? "falhou"}`);
    if (!cleanup.ok) throw new Error(`Cleanup: ${cleanup.error ?? "falhou"}`);
    await finishCamperAiReview(camper._id, {
      allergies: health.allergies,
      drugAllergies: health.drugAllergies,
      healthIssues: health.healthIssues,
      neurodivergent: health.neurodivergent,
      medications: cleanup.medications,
      foodRestrictions: cleanup.foodRestrictions,
      healthNotes: cleanup.healthNotes,
      generalNotes: cleanup.generalNotes,
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
    const notes = member.healthNotes.trim();
    log("staff", `${who} — start, observations=${notes.length} chars`);
    const health = await structureImportHealthWithJev(notes, {
      allergies: member.allergies,
      drugAllergies: member.drugAllergies,
      healthIssues: member.healthIssues,
      neurodivergent: false,
    }, "staff");
    void recordAiUsage({ at: new Date(), vendor: health.vendor, model: health.model, kind: "structure_health", userId: "worker", ...health.usage, ok: health.ok });
    const cleanup = await cleanupImportObservations({
      notes,
      subject: "staff",
      structured: { ...health, medications: member.medications },
      currentFoodRestrictions: member.foodRestrictions,
      currentHealthNotes: "",
    });
    void recordAiUsage({ at: new Date(), vendor: cleanup.vendor, model: cleanup.model, kind: "normalize_observations", userId: "worker", ...cleanup.usage, ok: cleanup.ok });
    if (!health.ok) throw new Error(`Jev: ${health.error ?? "falhou"}`);
    if (!cleanup.ok) throw new Error(`Cleanup: ${cleanup.error ?? "falhou"}`);
    await finishStaffAiReview(member._id, { allergies:health.allergies, drugAllergies:health.drugAllergies, healthIssues:health.healthIssues, medications:cleanup.medications, foodRestrictions:cleanup.foodRestrictions, healthNotes:cleanup.healthNotes });
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
      const { sms } = await import("./i18n");
      const subject = record.subject === "staff" ? "membros" : "crianças";
      const sent = await comteleSendSms(config.imports.adminPhone, sms("pt", "importFinished", { file: record.fileName, ok: total - errors, total, subject }));
      log("notify", `import "${record.fileName}" — finished SMS ${sent.ok ? "sent" : "FAILED"}`);
      if (sent.ok) patch.finishedSmsSentAt = new Date();
      else notificationFailed = true;
    }
    if (errorRate > .1 && config.imports.superAdminPhone && !record.errorSmsSentAt) {
      const { sms } = await import("./i18n");
      const sent = await comteleSendSms(config.imports.superAdminPhone, sms("pt", "importErrors", { file: record.fileName, errors, total }));
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
    log("batch", `finished ${campers.length} camper(s) + ${staff.length} staff review(s)`);
    await notifyFinishedImports([...campers, ...staff].map((x) => x.importId ?? ""));
  }
}

await loop();
