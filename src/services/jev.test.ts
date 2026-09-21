import { describe, expect, test } from "bun:test";
import { choiceOf, foldText, noulProbability, shortlistCandidates, textSimilarity } from "./jev";

describe("jev answer helpers", () => {
  test("noul probability clamps and tolerates garbage", () => {
    expect(noulProbability({ type: "noul", noul: 0.42 })).toBe(0.42);
    expect(noulProbability({ type: "noul", noul: 7 })).toBe(1);
    expect(noulProbability({ type: "noul", noul: "x" })).toBe(0);
    expect(noulProbability(undefined)).toBe(0);
  });

  test("choice reads confidence, then the picked probability", () => {
    expect(choiceOf({ type: "choice", choice: "a", confidence: 0.8 })).toEqual({ choice: "a", confidence: 0.8 });
    expect(choiceOf({ type: "choice", choice: "a", probabilities: { a: 0.6, b: 0.4 } })).toEqual({ choice: "a", confidence: 0.6 });
    expect(choiceOf({ type: "noul", choice: "a" })).toEqual({ choice: null, confidence: 0 });
  });
});

describe("candidate shortlist", () => {
  test("folds accents and case", () => expect(foldText("Rinite Alérgica")).toBe("rinite alergica"));

  test("similar labels rank first, short lists are untouched", () => {
    const options = [
      { id: "1", label: "Asma" },
      { id: "2", label: "Rinite alérgica" },
      { id: "3", label: "Dermatite" },
      { id: "4", label: "Bronquite" },
    ];
    expect(shortlistCandidates("rinite", options, 10)).toBe(options);
    expect(shortlistCandidates("rinite", options, 2).map((o) => o.id)).toEqual(["2", "3"]);
    expect(textSimilarity("rinite", "Rinite alérgica")).toBeGreaterThan(textSimilarity("rinite", "Asma"));
  });
});
