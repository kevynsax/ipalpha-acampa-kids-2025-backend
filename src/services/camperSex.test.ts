import { describe, expect, test } from "bun:test";
import { resolveGender, resolveWriteGender } from "./camperSex";

describe("probable gender split", () => {
  test("room wins for sex, requested value kept as probableGender", async () => {
    expect(await resolveGender({ name: "Alex", bedroomId: null, group: "girls", requested: "M" })).toEqual({ sex: "F", probableGender: "M" });
  });
  test("staff wing keeps the requested value as both", async () => {
    expect(await resolveGender({ name: "Alex", bedroomId: null, group: "staff", requested: "M" })).toEqual({ sex: "M", probableGender: "M" });
  });
  test("no room, no request, no guess flag → nulls without spending model calls", async () => {
    expect(await resolveGender({ name: "Alex", bedroomId: null, group: "staff", requested: null })).toEqual({ sex: null, probableGender: null });
  });
  test("write path preserves a known guess across a room move", async () => {
    const g = await resolveWriteGender({ name: "Ana", bedroomId: "x", group: "girls", sexTouched: false, sexValue: undefined, guessTouched: false, guessValue: undefined, existingSex: null, existingGuess: "F", nameOrRoomChanged: true });
    expect(g).toEqual({ sex: "F", probableGender: "F" });
  });
  test("write path untouched keeps both values without model calls", async () => {
    const g = await resolveWriteGender({ name: "Ana", bedroomId: null, sexTouched: false, sexValue: undefined, guessTouched: false, guessValue: undefined, existingSex: "M", existingGuess: "F", nameOrRoomChanged: false });
    expect(g).toEqual({ sex: "M", probableGender: "F" });
  });
  test("write path sent guess wins over a stale stored one", async () => {
    const g = await resolveWriteGender({ name: "Ana", bedroomId: null, group: "staff", sexTouched: false, sexValue: undefined, guessTouched: true, guessValue: "M", existingSex: null, existingGuess: "F", nameOrRoomChanged: false });
    expect(g).toEqual({ sex: "M", probableGender: "M" });
  });
});
