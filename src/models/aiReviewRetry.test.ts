import { describe, expect, test } from "bun:test";
import { AI_REVIEW_MAX_ATTEMPTS, aiReviewRetryAt, aiReviewRetryDelayMs, formatRetryDelay } from "./aiReviewRetry";

describe("ai review retry cooldown", () => {
  test("at most 5 attempts per record", () => {
    expect(AI_REVIEW_MAX_ATTEMPTS).toBe(5);
  });
  test("waits grow geometrically: 30min, 1h, 2h, 4h", () => {
    expect(aiReviewRetryDelayMs(1)).toBe(30 * 60_000);
    expect(aiReviewRetryDelayMs(2)).toBe(60 * 60_000);
    expect(aiReviewRetryDelayMs(3)).toBe(2 * 60 * 60_000);
    expect(aiReviewRetryDelayMs(4)).toBe(4 * 60 * 60_000);
  });
  test("total waited runs past 5 hours before the tries run out", () => {
    const total = [1, 2, 3, 4].reduce((sum, failure) => sum + aiReviewRetryDelayMs(failure), 0);
    expect(total).toBeGreaterThan(5 * 60 * 60_000);
  });
  test("retry time is delay after the failure", () => {
    const from = new Date("2026-09-17T12:00:00Z");
    expect(aiReviewRetryAt(1, from).toISOString()).toBe("2026-09-17T12:30:00.000Z");
    expect(aiReviewRetryAt(3, from).toISOString()).toBe("2026-09-17T14:00:00.000Z");
  });
  test("delays read well in logs", () => {
    expect(formatRetryDelay(30 * 60_000)).toBe("30min");
    expect(formatRetryDelay(2 * 60 * 60_000)).toBe("2h");
  });
});
