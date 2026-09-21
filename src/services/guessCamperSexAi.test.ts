import { describe, expect, test } from "bun:test";
import { GUESS_SEX_MODEL, GUESS_SEX_THRESHOLD, sexFromNoulPair } from "./guessCamperSexAi";

describe("jev name-sex decisions", () => {
  test("runs on Jev 1.13 with the 0.85 threshold", () => {
    expect(GUESS_SEX_MODEL).toEqual({ id: "typesafe/jev-1.13", label: "Jev 1.13", vendor: "typesafe" });
    expect(GUESS_SEX_THRESHOLD).toBe(0.85);
  });

  test("girl side above threshold wins", () => {
    expect(sexFromNoulPair({ noul: 0.93 }, { noul: 0.1 })).toBe("F");
  });

  test("boy side above threshold wins", () => {
    expect(sexFromNoulPair({ noul: 0.2 }, { noul: 0.9 })).toBe("M");
  });

  test("unisex below both thresholds stays null", () => {
    expect(sexFromNoulPair({ noul: 0.6 }, { noul: 0.5 })).toBe(null);
  });

  test("contradicting high answers cancel out", () => {
    expect(sexFromNoulPair({ noul: 0.9 }, { noul: 0.9 })).toBe(null);
  });

  test("a clear margin at the threshold decides", () => {
    expect(sexFromNoulPair({ noul: 0.86 }, { noul: 0.85 })).toBe("F");
    expect(sexFromNoulPair({ noul: 0.84 }, { noul: 0.9 })).toBe("M");
  });

  test("missing or malformed answers count as zero", () => {
    expect(sexFromNoulPair(undefined, { noul: "x" })).toBe(null);
    expect(sexFromNoulPair({ noul: 1 }, undefined)).toBe("F");
  });
});
