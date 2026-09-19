import { describe, expect, test } from "bun:test";
import { IMPORT_OBSERVATION_CLEANUP_MODEL, IMPORT_OBSERVATION_CLEANUP_MODELS, parseImportObservationCleanup, type ImportObservationCleanupResult } from "./importObservationCleanupAi";

const fallback: ImportObservationCleanupResult = {
  foodRestrictions: "Sem leite",
  healthNotes: "Usar espaçador",
  generalNotes: "texto original",
  medications: [{ name: "Aerolin", dose: "4 puffs", times: [], asNeeded: true, notes: "" }],
  ok: false,
  model: IMPORT_OBSERVATION_CLEANUP_MODEL.id,
  vendor: IMPORT_OBSERVATION_CLEANUP_MODEL.vendor,
  usage: { promptTokens: 0, completionTokens: 0 },
};

describe("import observation cleanup", () => {
  test("runs GLM 5.3 Flash → Opus 5 → Grok 4.6", () => expect(IMPORT_OBSERVATION_CLEANUP_MODELS.map((m) => m.id)).toEqual(["glm-5.3-flash", "claude-opus-5", "grok-4.6"]));

  test("keeps explicit empty text fields and merges medications", () => {
    expect(parseImportObservationCleanup({
      medications: [{ name: "Ritalina", dose: "10mg", times: ["08:30", "invalid"], asNeeded: false, notes: "" }],
      foodRestrictions: "",
      healthNotes: "",
      generalNotes: "Medo do escuro.",
    }, "camper", fallback)).toMatchObject({
      foodRestrictions: "",
      healthNotes: "",
      generalNotes: "Medo do escuro.",
      medications: [
        { name: "Ritalina", dose: "10mg", times: ["08:30"], asNeeded: false, notes: "" },
        { name: "Aerolin", dose: "4 puffs", times: [], asNeeded: true, notes: "" },
      ],
      ok: true,
    });
  });

  test("staff never receives general observations", () => {
    expect(parseImportObservationCleanup({ generalNotes: "qualquer coisa" }, "staff", fallback).generalNotes).toBe("");
  });
});
