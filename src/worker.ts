import { config } from "./config";
import { getDb } from "./db";
import { claimCampersForAiReview, claimCampersForCleanup, finishCamperAiReview, finishCamperStructure, requeueStaleAiReviews, type CamperData } from "./models/campers";
import { claimStaffForAiReview, claimStaffForCleanup, finishStaffAiReview, finishStaffStructure, requeueStaleStaffAiReviews, type StaffData } from "./models/staff";
import { AI_REVIEW_MAX_ATTEMPTS, aiReviewExhaustedFilter, aiReviewRetryDelayMs, aiReviewRetryPendingFilter, formatRetryDelay } from "./models/aiReviewRetry";
import { findCamperImport, listImportsPendingNotification, updateCamperImport } from "./models/camperImports";
import { recordAiUsage } from "./models/aiUsage";
import { appendCategoryOption, listCategories, newOptionId } from "./models/categories";
import { sortCamperNotes, type RawNotesCall } from "./services/camperNotesAi";
import { structureImportHealthWithJev } from "./services/importHealthStructureAi";
import { CAMPER_CATEGORY_KEYS } from "./types";
import { cleanupImportObservations, type HealthOption, type HealthOptions, type ImportHealthSelection } from "./services/importObservationCleanupAi";
import { comteleEnabled, comteleSendSms } from "./services/comtele";
import type { Camper, Staff } from "./types";

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
/** every active, non-draft configured health option (ids + labels) the cleanup model may select */
async function healthOptions(): Promise<HealthOptions> {
  const categories = await listCategories();
  const options = (key: string): HealthOption[] =>
    categories.find((c) => c.key === key)?.options.filter((o) => o.active && !o.draft && !/^nenhum/i.test(o.label) && !/^(?:outro|outros|outra|outras)\b/i.test(o.label)).map((o) => ({ id: o.id, label: o.label })) ?? [];
  return { allergies: options(CAMPER_CATEGORY_KEYS.allergies), drugAllergies: options(CAMPER_CATEGORY_KEYS.drugAllergies), healthIssues: options(CAMPER_CATEGORY_KEYS.healthIssues) };
}

/**
 * Applies the cleanup model's final health classification: labels no option
 * covers become real (active) category options, linked to the record right
 * away. Returns the final id lists. Shared by campers and staff.
 */
async function applyHealthSelection(health: ImportHealthSelection, importId: string | null | undefined, who: string): Promise<{ allergies: string[]; drugAllergies: string[]; healthIssues: string[]; created: number }> {
  const out = { allergies: [...health.allergies], drugAllergies: [...health.drugAllergies], healthIssues: [...health.healthIssues], created: 0 };
  const total = health.newOptions.allergies.length + health.newOptions.drugAllergies.length + health.newOptions.healthIssues.length;
  if (!total) return out;
  const categories = await listCategories();
  for (const field of ["allergies", "drugAllergies", "healthIssues"] as const) {
    const cat = categories.find((c) => c.key === CAMPER_CATEGORY_KEYS[field]);
    if (!cat) continue;
    for (const label of health.newOptions[field]) {
      // the option may have been created by a sibling record in the same batch — reuse it
      const existing = cat.options.find((o) => o.label.localeCompare(label, "pt-BR", { sensitivity: "base" }) === 0);
      if (existing) {
        if (!out[field].includes(existing.id)) out[field].push(existing.id);
        continue;
      }
      const option = { id: newOptionId(), label, order: cat.options.length, active: true, ...(importId ? { importId } : {}) };
      if (!(await appendCategoryOption(cat._id, option))) continue;
      cat.options.push(option);
      out[field].push(option.id);
      out.created++;
      log("health", `${who} — new option "${label}" → category "${cat.name}"`);
    }
  }
  return out;
}

/**
 * Tells the main backend one record reached a review checkpoint — "structured"
 * right after the fast Jev pass (fields already updated), "reviewed"/"error"
 * at the end — so it can push the websocket event (the worker process itself
 * holds no sockets). Best-effort: a failed callback never fails the review,
 * it only logs.
 */
async function notifyBackend(kind: "camper" | "staff", id: string, status: "structured" | "reviewed" | "error", attempts: number, newOptions = false): Promise<void> {
  if (!config.worker.secret) return;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(`${backendUrl}/api/worker/reviewed`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.worker.secret}` },
      body: JSON.stringify({ kind, id, status, attempts, newOptions }),
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

/** phase 1 — Jev pre-fill (near-instant): writes the obvious closed health fields and reports "structured" right away; the cleanup model makes the final call */
async function structureOne(camper: Camper): Promise<void> {
  const who = `camper "${camper.name}" (${camper._id})`;
  try {
    const reviewNotes = camper.generalNotes.trim();
    log("camper", `${who} — start, observations=${reviewNotes.length} chars`);
    const jev = await structureImportHealthWithJev(reviewNotes, {
      allergies: camper.allergies,
      drugAllergies: camper.drugAllergies,
      healthIssues: camper.healthIssues,
      neurodivergent: camper.neurodivergent,
    }, "camper");
    void recordAiUsage({ at: new Date(), vendor: jev.vendor, model: jev.model, kind: "structure_health", userId: "worker", ...jev.usage, ok: jev.ok });
    log("camper", `${who} — Jev structured: allergies=${jev.allergies.length} drugAllergies=${jev.drugAllergies.length} healthIssues=${jev.healthIssues.length} neurodivergent=${jev.neurodivergent}`);
    if (!jev.ok) throw new Error(`Jev: ${jev.error ?? "falhou"}`);
    await finishCamperStructure(camper._id, { allergies: jev.allergies, drugAllergies: jev.drugAllergies, healthIssues: jev.healthIssues, neurodivergent: jev.neurodivergent });
    log("camper", `${who} — structured, cleanup pending`);
    await notifyBackend("camper", camper._id, "structured", 0);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Falha na revisão por IA.";
    const updated = await finishCamperStructure(camper._id, {}, message);
    const attempts = updated?.aiReviewAttempts ?? 1;
    log("camper", `${who} — ERROR: ${message} — ${retryNote(attempts)}`);
    if (attempts >= AI_REVIEW_MAX_ATTEMPTS) await notifyBackend("camper", camper._id, "error", attempts);
  }
}

/** phase 2 — slow generative review (own batch; never blocks Jev): final health classification + free-text cleanup */
async function cleanupOne(camper: Camper): Promise<void> {
  const who = `camper "${camper.name}" (${camper._id})`;
  try {
    // the claimed doc already carries the Jev-written structured fields
    const cleanup = await cleanupImportObservations({
      notes: camper.generalNotes.trim(),
      subject: "camper",
      options: await healthOptions(),
      structured: { allergies: camper.allergies, drugAllergies: camper.drugAllergies, healthIssues: camper.healthIssues, neurodivergent: camper.neurodivergent, medications: camper.medications },
      currentFoodRestrictions: camper.foodRestrictions,
      currentHealthNotes: camper.healthNotes,
      current: { email: camper.guardianEmail, bedroomPreference: camper.bedroomPreference, emergencyContact: camper.emergencyContact, guardianPhone: camper.guardianPhone ?? "", insurance: camper.insurance, insuranceCard: camper.insuranceCard },
    });
    void recordAiUsage({ at: new Date(), vendor: cleanup.vendor, model: cleanup.model, kind: "normalize_observations", userId: "worker", ...cleanup.usage, ok: cleanup.ok });
    if (!cleanup.ok) throw new Error(`Cleanup: ${cleanup.error ?? "falhou"}`);
    // fill-only recovery: registration facts the sheet only carried as free text
    const recovered: Partial<CamperData> = {};
    if (!camper.guardianEmail && cleanup.recovered.email) recovered.guardianEmail = cleanup.recovered.email;
    if (!camper.bedroomPreference && cleanup.recovered.bedroomPreference) recovered.bedroomPreference = cleanup.recovered.bedroomPreference;
    if (!camper.emergencyContact && cleanup.recovered.emergencyContact) recovered.emergencyContact = cleanup.recovered.emergencyContact;
    if (!camper.guardianPhone && cleanup.recovered.guardianPhone) recovered.guardianPhone = cleanup.recovered.guardianPhone;
    if (!camper.insurance && cleanup.recovered.insurance) recovered.insurance = cleanup.recovered.insurance;
    if (!camper.insuranceCard && cleanup.recovered.insuranceCard) recovered.insuranceCard = cleanup.recovered.insuranceCard;
    if (Object.keys(recovered).length) log("camper", `${who} — recovered ${Object.keys(recovered).join(", ")}`);
    const health = await applyHealthSelection(cleanup.health, camper.importId, who);
    log("camper", `${who} — final health: allergies=${health.allergies.length} drugAllergies=${health.drugAllergies.length} healthIssues=${health.healthIssues.length} neurodivergent=${cleanup.health.neurodivergent}${health.created ? ` (+${health.created} new option(s))` : ""}`);
    await finishCamperAiReview(camper._id, {
      allergies: health.allergies,
      drugAllergies: health.drugAllergies,
      healthIssues: health.healthIssues,
      neurodivergent: cleanup.health.neurodivergent,
      medications: cleanup.medications,
      foodRestrictions: cleanup.foodRestrictions,
      healthNotes: cleanup.healthNotes,
      generalNotes: cleanup.generalNotes,
      ...recovered,
    });
    log("camper", `${who} — done`);
    await notifyBackend("camper", camper._id, "reviewed", 0, health.created > 0);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Falha na revisão por IA.";
    const updated = await finishCamperAiReview(camper._id, {}, message);
    const attempts = updated?.aiReviewAttempts ?? 1;
    log("camper", `${who} — ERROR: ${message} — ${retryNote(attempts)}`);
    if (attempts >= AI_REVIEW_MAX_ATTEMPTS) await notifyBackend("camper", camper._id, "error", attempts);
  }
}

/** phase 1 — Jev pre-fill (near-instant) for a team member */
async function structureStaffOne(member: Staff): Promise<void> {
  const who = `staff "${member.name}" (${member._id})`;
  try {
    const notes = member.healthNotes.trim();
    log("staff", `${who} — start, observations=${notes.length} chars`);
    const jev = await structureImportHealthWithJev(notes, {
      allergies: member.allergies,
      drugAllergies: member.drugAllergies,
      healthIssues: member.healthIssues,
      neurodivergent: false,
    }, "staff");
    void recordAiUsage({ at: new Date(), vendor: jev.vendor, model: jev.model, kind: "structure_health", userId: "worker", ...jev.usage, ok: jev.ok });
    log("staff", `${who} — Jev structured: allergies=${jev.allergies.length} drugAllergies=${jev.drugAllergies.length} healthIssues=${jev.healthIssues.length}`);
    if (!jev.ok) throw new Error(`Jev: ${jev.error ?? "falhou"}`);
    await finishStaffStructure(member._id, { allergies: jev.allergies, drugAllergies: jev.drugAllergies, healthIssues: jev.healthIssues });
    log("staff", `${who} — structured, cleanup pending`);
    await notifyBackend("staff", member._id, "structured", 0);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Falha na revisão por IA.";
    const attempts = await finishStaffStructure(member._id, {}, message);
    log("staff", `${who} — ERROR: ${message} — ${retryNote(attempts)}`);
    if (attempts >= AI_REVIEW_MAX_ATTEMPTS) await notifyBackend("staff", member._id, "error", attempts);
  }
}

/** phase 2 — slow generative review for a team member (own batch): final health classification + free-text cleanup */
async function cleanupStaffOne(member: Staff): Promise<void> {
  const who = `staff "${member.name}" (${member._id})`;
  try {
    const cleanup = await cleanupImportObservations({
      notes: member.healthNotes.trim(),
      subject: "staff",
      options: await healthOptions(),
      structured: { allergies: member.allergies, drugAllergies: member.drugAllergies, healthIssues: member.healthIssues, neurodivergent: false, medications: member.medications },
      currentFoodRestrictions: member.foodRestrictions,
      currentHealthNotes: "",
      current: { email: member.email ?? "" },
    });
    void recordAiUsage({ at: new Date(), vendor: cleanup.vendor, model: cleanup.model, kind: "normalize_observations", userId: "worker", ...cleanup.usage, ok: cleanup.ok });
    if (!cleanup.ok) throw new Error(`Cleanup: ${cleanup.error ?? "falhou"}`);
    const recovered: Partial<StaffData> = {};
    if (!member.email && cleanup.recovered.email) recovered.email = cleanup.recovered.email;
    if (Object.keys(recovered).length) log("staff", `${who} — recovered email`);
    const health = await applyHealthSelection(cleanup.health, member.importId, who);
    log("staff", `${who} — final health: allergies=${health.allergies.length} drugAllergies=${health.drugAllergies.length} healthIssues=${health.healthIssues.length}${health.created ? ` (+${health.created} new option(s))` : ""}`);
    await finishStaffAiReview(member._id, { allergies: health.allergies, drugAllergies: health.drugAllergies, healthIssues: health.healthIssues, medications: cleanup.medications, foodRestrictions: cleanup.foodRestrictions, healthNotes: cleanup.healthNotes, ...recovered });
    log("staff", `${who} — done`);
    await notifyBackend("staff", member._id, "reviewed", 0, health.created > 0);
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
      db.collection("campers").countDocuments({ importId, aiReviewStatus: { $in: ["pending", "processing", "structured"] } }),
      db.collection("staff").countDocuments({ importId, aiReviewStatus: { $in: ["pending", "processing", "structured"] } }),
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
  log("startup", `import worker ready; jev+cleanup batch=${BATCH}, poll=${POLL_MS / 1000}s, SMS=${comteleEnabled() ? "on" : "mock"}`);
  let idlePolls = 0;
  while (true) {
    // phase 1 — Jev only, near-instant: its own batch so the slow cleanup never holds it back
    const structure = await Promise.all([claimCampersForAiReview(BATCH), claimStaffForAiReview(BATCH)]);
    if (structure[0].length || structure[1].length) {
      log("jev", `structuring ${structure[0].length} camper(s) + ${structure[1].length} staff review(s)`);
      await Promise.all([...structure[0].map(structureOne), ...structure[1].map(structureStaffOne)]);
      log("jev", `structured ${structure[0].length} camper(s) + ${structure[1].length} staff review(s)`);
    }
    // phase 2 — slow generative cleanup: separate batch over the already-structured records
    const cleanupBatch = await Promise.all([claimCampersForCleanup(BATCH), claimStaffForCleanup(BATCH)]);
    if (cleanupBatch[0].length || cleanupBatch[1].length) {
      log("cleanup", `cleaning ${cleanupBatch[0].length} camper(s) + ${cleanupBatch[1].length} staff review(s)`);
      await Promise.all([...cleanupBatch[0].map(cleanupOne), ...cleanupBatch[1].map(cleanupStaffOne)]);
      log("cleanup", `cleaned ${cleanupBatch[0].length} camper(s) + ${cleanupBatch[1].length} staff review(s)`);
    }
    const touched = [...structure.flat(), ...cleanupBatch.flat()];
    if (!touched.length) {
      idlePolls++;
      if (idlePolls % IDLE_HEARTBEAT_POLLS === 0) log("idle", `nothing pending (${idlePolls} empty polls) — worker alive`);
      await notifyFinishedImports((await listImportsPendingNotification()).map((r) => r._id));
      await Bun.sleep(POLL_MS);
      continue;
    }
    idlePolls = 0;
    await notifyFinishedImports(touched.map((x) => x.importId ?? ""));
  }
}

await loop();
