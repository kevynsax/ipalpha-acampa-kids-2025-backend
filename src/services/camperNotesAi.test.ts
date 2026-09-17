import { describe, expect, test } from "bun:test";
import { normalizeNotesAnswer } from "./camperNotesAi";

const lists = {
  allergies: { key: "alergias", labels: ["Rinite alérgica"], byLabel: new Map([["rinite alérgica", "a1"]]), byId: new Map([["a1", "Rinite alérgica"]]) },
  drugAllergies: { key: "alergia-medicamentos", labels: [], byLabel: new Map(), byId: new Map() },
  healthIssues: { key: "condicao-cronica", labels: ["Asma"], byLabel: new Map([["asma", "h1"]]), byId: new Map([["h1", "Asma"]]) },
};

describe("leftover dedupe against filed fields", () => {
  test("a general-notes line already filed as an allergy is removed", () => {
    const out = normalizeNotesAnswer(
      { generalNotes: "Rinite alérgica\nUsa soro todo dia" },
      { notes: "", current: { allergies: ["a1"] } },
      lists,
    );
    expect(out.generalNotes).toBe("Usa soro todo dia");
  });
  test("a line that adds facts stays, an exact repeat goes", () => {
    const kept = normalizeNotesAnswer(
      { healthNotes: "Asma desde os 3 anos" },
      { notes: "", current: { healthIssues: ["h1"] } },
      lists,
    );
    expect(kept.healthNotes).toBe("Asma desde os 3 anos");
    const dropped = normalizeNotesAnswer(
      { healthNotes: "Asma" },
      { notes: "", current: { healthIssues: ["h1"] } },
      lists,
    );
    expect(dropped.healthNotes).toBe("");
  });
  test("food restriction and medication repeats leave the leftovers", () => {
    const out = normalizeNotesAnswer(
      { generalNotes: "Não pode comer camarão\nMedo do escuro", healthNotes: "Ritalina" },
      {
        notes: "",
        current: {
          foodRestrictions: "Não pode comer camarão",
          medications: [{ name: "Ritalina", dose: "10mg", times: [], asNeeded: false, notes: "" }],
        },
      },
      lists,
    );
    expect(out.generalNotes).toBe("Medo do escuro");
    expect(out.healthNotes).toBe("");
  });
});
