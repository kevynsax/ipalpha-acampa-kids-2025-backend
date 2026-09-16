import { expect, test } from "bun:test";
import { autoAudienceLabel, autoRoleCovers, autoRoleFor, dutyOf, isAutomatic, isForWholeTeam, peopleInRole } from "./schedule";
import type { CampEvent, EventAssignment, ScheduleRole, Staff } from "../types";

/**
 * A função can be linked to people in several ways AT ONCE: by POSITION
 * (`forRoomRoles`: líderes, auxiliares or both = toda a equipe) and/or by
 * PERSON (`CampEvent.assignments`). An explicit escala always wins.
 *
 *   bun test src/services/schedule.test.ts
 */
const role = (id: string, patch: Partial<ScheduleRole> = {}): ScheduleRole => ({
  _id: id,
  name: id,
  emoji: "🎯",
  instructions: "",
  preparation: "",
  forRoomRoles: [],
  hasDetail: false,
  detailFromTeam: false,
  detailPlaceholder: "",
  createdAt: new Date(),
  updatedAt: new Date(),
  ...patch,
});

const team = role("team", { forRoomRoles: ["caretaker", "helper"] });
const leaders = role("leaders", { forRoomRoles: ["caretaker"] });
const helpers = role("helpers", { forRoomRoles: ["helper"] });
const picked = role("picked");
const byId = new Map([team, leaders, helpers, picked].map((r) => [r._id, r]));

const person = (id: string, roomRole: Staff["roomRole"], active = true) => ({ _id: id, active, roomRole });
const ana = person("ana", "caretaker");
const bia = person("bia", "caretaker");
const caio = person("caio", "helper");
const davi = person("davi", "helper");
const staff = [ana, bia, caio, davi];

const at = (staffId: string, roleId: string): EventAssignment => ({ staffId, roleId, detail: "", detailColor: "" });
const event = (roles: string[], assignments: EventAssignment[] = []): Pick<CampEvent, "roles" | "assignments"> => ({ roles, assignments });

// ── the ways, one by one ────────────────────────────────────────────────────

test("both positions = toda a equipe", () => {
  expect(isForWholeTeam(team)).toBe(true);
  expect(autoRoleCovers(team, "caretaker")).toBe(true);
  expect(autoRoleCovers(team, "helper")).toBe(true);
});

test("one position reaches only that position", () => {
  expect(autoRoleCovers(leaders, "caretaker")).toBe(true);
  expect(autoRoleCovers(leaders, "helper")).toBe(false);
  expect(autoRoleCovers(helpers, "helper")).toBe(true);
});

test("no position = only whoever is escalado by hand", () => {
  expect(isAutomatic(picked)).toBe(false);
  expect(autoRoleCovers(picked, "caretaker")).toBe(false);
  expect(autoRoleCovers(undefined, "helper")).toBe(false);
});

// ── the ways adding up ──────────────────────────────────────────────────────

test("líderes + algumas pessoas: both links feed the same função", () => {
  // the função falls on the líderes, and Caio (an auxiliar) was added by hand
  const e = event(["leaders"], [at("caio", "leaders")]);
  const who = peopleInRole(e, leaders, staff, byId);
  expect(who.map((x) => x.staff._id).sort()).toEqual(["ana", "bia", "caio"]);
  expect(who.find((x) => x.staff._id === "caio")!.via).toBe("person");
  expect(who.find((x) => x.staff._id === "ana")!.via).toBe("position");
});

test("só algumas pessoas: nobody comes in by position", () => {
  const e = event(["picked"], [at("ana", "picked"), at("davi", "picked")]);
  expect(peopleInRole(e, picked, staff, byId).map((x) => x.staff._id).sort()).toEqual(["ana", "davi"]);
});

test("toda a equipe: everyone active, no escala needed", () => {
  const e = event(["team"]);
  expect(peopleInRole(e, team, staff, byId)).toHaveLength(4);
});

test("an inactive person is never pulled in by position", () => {
  const e = event(["team"]);
  expect(peopleInRole(e, team, [...staff, person("eva", "helper", false)], byId)).toHaveLength(4);
});

// ── one função per person: the escala wins ──────────────────────────────────

test("being escalado elsewhere takes the person out of the automatic função", () => {
  const e = event(["team", "picked"], [at("ana", "picked")]);
  expect(peopleInRole(e, team, staff, byId).map((x) => x.staff._id).sort()).toEqual(["bia", "caio", "davi"]);
  expect(peopleInRole(e, picked, staff, byId).map((x) => x.staff._id)).toEqual(["ana"]);
});

test("the position função wins over the whole-team one", () => {
  const e = event(["team", "leaders"]);
  expect(autoRoleFor(e, "caretaker", byId)?._id).toBe("leaders");
  expect(autoRoleFor(e, "helper", byId)?._id).toBe("team");
});

test("no link for me in this event = nothing to do", () => {
  expect(autoRoleFor(event(["leaders"]), "helper", byId)).toBeUndefined();
  expect(dutyOf(event(["leaders"]), caio, byId)).toBeNull();
  expect(dutyOf(event(["leaders"], [at("caio", "leaders")]), caio, byId)?.role?._id).toBe("leaders");
});

test("the audience label names the positions, not the hand-picked people", () => {
  expect(autoAudienceLabel(team)).toBe("toda a equipe");
  expect(autoAudienceLabel(leaders)).toBe("os líderes");
  expect(autoAudienceLabel(helpers)).toBe("os auxiliares");
  expect(autoAudienceLabel(picked)).toBe("");
});
