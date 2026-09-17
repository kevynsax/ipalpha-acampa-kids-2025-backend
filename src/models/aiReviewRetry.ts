/**
 * Cooldown for failed background AI reviews (camper + staff imports).
 *
 * A record gets AI_REVIEW_MAX_ATTEMPTS tries in total. After each failure the
 * next retry waits geometrically longer — 30min, 1h, 2h, 4h — so the total
 * time waited (7.5h) runs past the 5h budget before the record is declared
 * exhausted and left for manual review.
 */

/** total AI-review tries per record (first attempt + retries) */
export const AI_REVIEW_MAX_ATTEMPTS = 5;

/** wait after the first failure; doubles on every following failure */
const AI_REVIEW_BACKOFF_BASE_MS = 30 * 60_000;

/** how long to wait before retrying after `failedAttempts` failures (1-based) */
export function aiReviewRetryDelayMs(failedAttempts: number): number {
  return AI_REVIEW_BACKOFF_BASE_MS * 2 ** Math.max(0, failedAttempts - 1);
}

/** when a record that just failed its `failedAttempts`-th try may be retried */
export function aiReviewRetryAt(failedAttempts: number, from = new Date()): Date {
  return new Date(from.getTime() + aiReviewRetryDelayMs(failedAttempts));
}

/** "30min" / "2h" for worker logs */
export function formatRetryDelay(ms: number): string {
  const min = Math.round(ms / 60_000);
  return min >= 60 ? `${Math.round(min / 60)}h` : `${min}min`;
}

/**
 * Error records whose cooldown expired and which still have tries left.
 * Documents written before this cooldown existed (no new fields) retry too.
 */
export function aiReviewDueFilter(now = new Date()): Record<string, unknown> {
  return {
    aiReviewStatus: "error",
    $and: [
      { $or: [{ aiReviewAttempts: { $lt: AI_REVIEW_MAX_ATTEMPTS } }, { aiReviewAttempts: { $exists: false } }] },
      { $or: [{ aiReviewNextRetryAt: { $lte: now } }, { aiReviewNextRetryAt: { $exists: false } }] },
    ],
  };
}

/** error records that will still be retried — the import notification waits for them */
export function aiReviewRetryPendingFilter(): Record<string, unknown> {
  return {
    aiReviewStatus: "error",
    $or: [{ aiReviewAttempts: { $lt: AI_REVIEW_MAX_ATTEMPTS } }, { aiReviewAttempts: { $exists: false } }],
  };
}

/** error records with no tries left — counted as failures, need a human */
export function aiReviewExhaustedFilter(): Record<string, unknown> {
  return { aiReviewStatus: "error", aiReviewAttempts: { $gte: AI_REVIEW_MAX_ATTEMPTS } };
}
