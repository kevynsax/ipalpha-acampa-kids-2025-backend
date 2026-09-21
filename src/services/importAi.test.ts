import { describe, expect, test } from "bun:test";
import { IMPORT_COLUMN_MODEL, IMPORT_DECISION_MODEL, IMPORT_MATCH_THRESHOLD, parseJevBooleans, parseJevBuckets, parseJevColumnMappings, parseJevMatches } from "./importAi";

const targets = [
  { key: "name", label: "Nome", aliases: ["nome completo"], required: true },
  { key: "phone", label: "Celular", aliases: ["telefone", "whatsapp"] },
];

const columns = [
  { name: "Quem vai servir?", samples: ["Ana Maria", "João Silva"] },
  { name: "Contato", samples: ["(11) 99999-9999"] },
  { name: "Timestamp", samples: ["2026-09-19 08:00"] },
];

describe("Jev import column mapping", () => {
  test("maps valid choices and turns ignore into null", () => {
    expect(parseJevColumnMappings(columns, targets, {
      column_0: { type: "choice", choice: "name", confidence: 0.98 },
      column_1: { type: "choice", choice: "phone", confidence: 0.87 },
      column_2: { type: "choice", choice: "ignore", confidence: 0.99 },
    })).toEqual({
      "Quem vai servir?": { target: "name", confidence: 0.98 },
      Contato: { target: "phone", confidence: 0.87 },
      Timestamp: { target: null, confidence: 0.99 },
    });
  });

  test("omits malformed answers so the existing fallback can handle them", () => {
    expect(parseJevColumnMappings(columns, targets, {
      column_0: { type: "choice", choice: "unknown", confidence: 1 },
      column_1: { type: "noul", choice: "phone", confidence: 1 },
    })).toEqual({});
  });

  test("uses the selected probability when confidence is absent", () => {
    expect(parseJevColumnMappings(columns.slice(0, 1), targets, {
      column_0: { type: "choice", choice: "name", probabilities: { name: 0.73, phone: 0.27 } },
    })).toEqual({ "Quem vai servir?": { target: "name", confidence: 0.73 } });
  });

  test("every closed import decision runs on Jev 1.13", () => {
    expect(IMPORT_COLUMN_MODEL.id).toBe("typesafe/jev-1.13");
    expect(IMPORT_DECISION_MODEL.id).toBe("typesafe/jev-1.13");
  });
});

describe("Jev option matching", () => {
  const candidates = [{ id: "a1", label: "Rinite" }, { id: "a2", label: "Asma" }];
  const values = ["rinite alergica", "Bronquite", "asma", "poeira"];

  test("keeps confident picks, turns a confident none into an explicit null, omits the rest", () => {
    expect(parseJevMatches(values, candidates, {
      m_0: { type: "choice", choice: "a1", confidence: 0.96 },
      m_1: { type: "choice", choice: "none", confidence: 0.9 },
      m_2: { type: "choice", choice: "a2", confidence: IMPORT_MATCH_THRESHOLD - 0.05 },
      m_3: { type: "choice", choice: "zz", confidence: 1 },
    })).toEqual({ "rinite alergica": "a1", Bronquite: null });
  });

  test("ignores malformed and missing answers", () => {
    expect(parseJevMatches(values, candidates, { m_0: { type: "noul", choice: "a1", confidence: 0.9 } })).toEqual({});
    expect(parseJevMatches(values, candidates, undefined)).toEqual({});
  });
});

describe("Jev health bucketing", () => {
  test("keeps confident valid buckets only", () => {
    expect(parseJevBuckets(["Amoxicilina", "Asma", "Poeira", "não tem"], {
      b_0: { type: "choice", choice: "drugAllergies", confidence: 0.93 },
      b_1: { type: "choice", choice: "healthIssues", confidence: 0.6 },
      b_2: { type: "choice", choice: "weird", confidence: 0.99 },
      b_3: { type: "choice", choice: "none", confidence: 0.97 },
    })).toEqual({ Amoxicilina: "drugAllergies", "não tem": "none" });
  });
});

describe("Jev neurodivergent yes/no", () => {
  test("confident yes, confident no, undecided omitted", () => {
    expect(parseJevBooleans(["TEA", "não", "talvez"], {
      v_0: { type: "noul", noul: 0.97 },
      v_1: { type: "noul", noul: 0.04 },
      v_2: { type: "noul", noul: 0.5 },
    })).toEqual({ TEA: true, "não": false });
  });
});
