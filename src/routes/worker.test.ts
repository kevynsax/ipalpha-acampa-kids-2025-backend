import { beforeEach, describe, expect, test } from "bun:test";
import { config } from "../config";
import worker from "./worker";

const SECRET = "test-worker-secret";

beforeEach(() => {
  (config.worker as { secret: string }).secret = SECRET;
});

describe("POST /reviewed", () => {
  test("refuses a missing or wrong secret", async () => {
    const body = JSON.stringify({ kind: "camper", id: "abc", status: "reviewed", attempts: 0 });
    const noAuth = await worker.request("/reviewed", { method: "POST", headers: { "content-type": "application/json" }, body });
    expect(noAuth.status).toBe(401);
    const wrong = await worker.request("/reviewed", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer wrong" }, body });
    expect(wrong.status).toBe(401);
  });
  test("rejects a bad body with the right secret", async () => {
    const res = await worker.request("/reviewed", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` }, body: JSON.stringify({ kind: "alien", id: "", status: "reviewed" }) });
    expect(res.status).toBe(400);
  });
  test("accepts a review callback with the right secret", async () => {
    const res = await worker.request("/reviewed", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` }, body: JSON.stringify({ kind: "staff", id: "abc123", status: "reviewed", attempts: 0 }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
