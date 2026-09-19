import { describe, expect, test } from "bun:test";
import { parseJevColumnMappings } from "./importAi";

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
});
