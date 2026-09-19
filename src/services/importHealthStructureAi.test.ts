import { describe, expect, test } from "bun:test";
import { applyJevHealthAnswers, IMPORT_HEALTH_STRUCTURE_MODEL } from "./importHealthStructureAi";

const current = { allergies: ["existing"], drugAllergies: [], healthIssues: [], neurodivergent: false };
const meta = {
  q_0: { field: "allergies" as const, optionId: "dust" },
  q_1: { field: "healthIssues" as const, optionId: "asthma" },
  q_2: { field: "drugAllergies" as const, optionId: "dipyrone" },
  q_3: { field: "neurodivergent" as const },
};

describe("Jev imported health structure", () => {
  test("uses Jev 1.13", () => expect(IMPORT_HEALTH_STRUCTURE_MODEL.id).toBe("typesafe/jev-1.13"));

  test("adds only high-probability explicit health decisions", () => {
    expect(applyJevHealthAnswers(current, meta, {
      q_0: { type: "noul", noul: 0.99 },
      q_1: { type: "noul", noul: 0.84 },
      q_2: { type: "noul", noul: 0.9 },
      q_3: { type: "noul", noul: 0.97 },
    })).toEqual({
      allergies: ["existing", "dust"],
      drugAllergies: ["dipyrone"],
      healthIssues: [],
      neurodivergent: true,
    });
  });

  test("never removes fields already structured during import", () => {
    expect(applyJevHealthAnswers({ ...current, healthIssues: ["asthma"] }, meta, {})).toEqual({ ...current, healthIssues: ["asthma"] });
  });
});
