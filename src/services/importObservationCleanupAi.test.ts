import { describe, expect, test } from "bun:test";
import { dropWeightRestatements, EMPTY_RECOVERED_FIELDS, IMPORT_OBSERVATION_CLEANUP_MODEL, IMPORT_OBSERVATION_CLEANUP_MODELS, parseHealthSelection, parseImportObservationCleanup, type HealthOptions, type ImportObservationCleanupResult } from "./importObservationCleanupAi";

const fallback: ImportObservationCleanupResult = {
  health: { allergies: [], drugAllergies: [], healthIssues: ["asma"], neurodivergent: false, newOptions: { allergies: [], drugAllergies: [], healthIssues: [] } },
  foodRestrictions: "Sem leite",
  healthNotes: "Usar espaçador",
  generalNotes: "texto original",
  medications: [{ name: "Aerolin", dose: "4 puffs", times: [], asNeeded: true, notes: "" }],
  recovered: { ...EMPTY_RECOVERED_FIELDS },
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

  test("recovers camper registration facts from the text", () => {
    expect(parseImportObservationCleanup({
      recovered: {
        email: " MAE@Exemplo.COM ",
        guardianPhone: "(11) 98765-4321",
        bedroomPreference: "quer ficar com a Ana",
        emergencyContact: "Tia Rosa — 11 91234-0000",
        insurance: "Unimed",
        insuranceCard: "123456789",
        weightKg: 28.5,
      },
    }, "camper", fallback).recovered).toEqual({
      email: "mae@exemplo.com",
      guardianPhone: "+5511987654321",
      bedroomPreference: "quer ficar com a Ana",
      emergencyContact: "Tia Rosa — 11 91234-0000",
      insurance: "Unimed",
      insuranceCard: "123456789",
      weightKg: 28.5,
    });
  });

  test("drops malformed e-mail and phone from recovery", () => {
    const out = parseImportObservationCleanup({ recovered: { email: "mãe@", guardianPhone: "2345", insurance: "Unimed" } }, "camper", fallback).recovered;
    expect(out.email).toBe("");
    expect(out.guardianPhone).toBe("");
    expect(out.insurance).toBe("Unimed");
    expect(out.weightKg).toBeNull();
  });

  test("staff recovers only the e-mail", () => {
    const out = parseImportObservationCleanup({ recovered: { email: "tio@exemplo.com", bedroomPreference: "quer ficar com a Ana" } }, "staff", fallback).recovered;
    expect(out.email).toBe("tio@exemplo.com");
    expect(out.bedroomPreference).toBe("");
    expect(out.weightKg).toBeNull();
  });

  test("no recovery block keeps everything empty", () => {
    expect(parseImportObservationCleanup({ generalNotes: "Medo do escuro." }, "camper", fallback).recovered).toEqual(EMPTY_RECOVERED_FIELDS);
  });

  test("drops weight restatements from leftover text", () => {
    expect(dropWeightRestatements("Peso: 15kgkg | Prefere dividir quarto com: Ema", 15)).toBe("Prefere dividir quarto com: Ema");
    expect(dropWeightRestatements("Peso: 28.5kg | Convênio médico: Amil", 28.5)).toBe("Convênio médico: Amil");
    expect(dropWeightRestatements("Peso: 27kg", 27)).toBe("");
    expect(dropWeightRestatements("Usa espaçador em crise", 28)).toBe("Usa espaçador em crise");
    expect(dropWeightRestatements("Medo do escuro.")).toBe("Medo do escuro.");
  });

  test("strips Peso lines the model left in healthNotes when weightKg is already filled", () => {
    const out = parseImportObservationCleanup({
      healthNotes: "Peso: 15kgkg | Prefere dividir quarto com: Ema",
      generalNotes: "Peso: 15kg",
    }, "camper", fallback, undefined, 15);
    expect(out.healthNotes).toBe("Prefere dividir quarto com: Ema");
    expect(out.generalNotes).toBe("");
  });
});

describe("final health selection by the cleanup model", () => {
  const options: HealthOptions = {
    allergies: [{ id: "rinite", label: "Rinite alérgica" }, { id: "poeira", label: "Poeira / mofo" }],
    drugAllergies: [{ id: "nim", label: "Nimesulida" }, { id: "pen", label: "Penicilina / Benzetacil" }],
    healthIssues: [{ id: "asma", label: "Asma" }, { id: "cardio", label: "Cardiopatia" }],
  };
  const current = { allergies: [], drugAllergies: [], healthIssues: ["asma"], neurodivergent: false };

  test("selects offered ids in their own list, keeps Jev's pre-fill, ignores unknown ids", () => {
    expect(parseHealthSelection({ allergies: ["rinite", "nim", "made-up"], drugAllergies: ["nim", "pen"], healthIssues: [] }, options, current, "staff")).toMatchObject({
      allergies: ["rinite"],
      drugAllergies: ["nim", "pen"],
      healthIssues: ["asma"],
    });
  });

  test("new options: short reusable names, no generics, nothing already configured (also inside composite labels)", () => {
    const out = parseHealthSelection({ newOptions: { drugAllergies: ["Ciprofloxacino", "Benzetacil", "Outro medicamento", "Fenitoína", "ciprofloxacino"], healthIssues: ["Asma", "Labirintite"], allergies: ["Alergia"] } }, options, current, "staff");
    expect(out.newOptions).toEqual({ allergies: [], drugAllergies: ["Ciprofloxacino", "Fenitoína"], healthIssues: ["Labirintite"] });
  });

  test("neurodivergent only for campers", () => {
    expect(parseHealthSelection({ neurodivergent: true }, options, current, "staff").neurodivergent).toBe(false);
    expect(parseHealthSelection({ neurodivergent: true }, options, current, "camper").neurodivergent).toBe(true);
    expect(parseHealthSelection({ neurodivergent: false }, options, { ...current, neurodivergent: true }, "camper").neurodivergent).toBe(true);
  });

  test("malformed block keeps the pre-fill untouched", () => {
    expect(parseHealthSelection("nope", options, current, "camper")).toEqual({ ...current, newOptions: { allergies: [], drugAllergies: [], healthIssues: [] } });
    expect(parseImportObservationCleanup({ health: { allergies: "rinite" } }, "staff", fallback, options).health.allergies).toEqual([]);
  });
});
