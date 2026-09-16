import { describe, expect, test } from "bun:test";
import * as XLSX from "xlsx";
import { applyImportDelta, camperDataFromPreview, directImportField, extractImportNumber, isEmptyCategoryValue, parseSpreadsheet } from "./camperImport";
import type { CamperImportReviewItem } from "../types";

function book(rows: unknown[][]): Uint8Array {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), "Crianças");
  return XLSX.write(wb, { type: "array", bookType: "xlsx" }) as Uint8Array;
}

describe("camper spreadsheet parser", () => {
  test("keeps duplicate headers unique and exposes five samples", () => {
    const data = book([
      ["Nome", "Nome", "Nascimento"],
      ["Ana", "Mãe Ana", "01/02/2016"],
      ["Bia", "Mãe Bia", "02/03/2016"],
    ]);
    const parsed = parseSpreadsheet(data, "kids.xlsx");
    expect(parsed.rows).toHaveLength(2);
    expect(Object.keys(parsed.rows[0])).toEqual(["Nome", "Nome (2)", "Nascimento"]);
    expect(parsed.columns[0].samples).toEqual(["Ana", "Bia"]);
  });

  test("rejects a sheet without children", () => {
    expect(() => parseSpreadsheet(book([["Nome", "Nascimento"]]), "empty.xlsx")).toThrow();
  });

  test("keeps UTF-8 accents intact in CSV headers and values", () => {
    const csv = new TextEncoder().encode("Nome,Observações de saúde\nAna,Pressão alta\n");
    const parsed = parseSpreadsheet(csv, "staff.csv");
    expect(Object.keys(parsed.rows[0])).toEqual(["Nome", "Observações de saúde"]);
    expect(parsed.rows[0]["Observações de saúde"]).toBe("Pressão alta");
  });

  test("does not reformat or shift literal CSV dates", () => {
    const csv = new TextEncoder().encode("Nome;Data de nascimento\nAna;2016-04-16\nBia;16/04/16\nClara;2019-12-12\n");
    const parsed = parseSpreadsheet(csv, "kids.csv");
    expect(parsed.rows.map((row) => row["Data de nascimento"])).toEqual(["2016-04-16", "16/04/16", "2019-12-12"]);
  });
});

describe("camper deterministic column mapping", () => {
  test("specific labels win over generic words", () => {
    expect(directImportField("Gostaria de ficar no mesmo quarto de alguém?")?.key).toBe("bedroomPreference");
    expect(directImportField("Série/ano escolar")?.key).toBe("schoolGrade");
    expect(directImportField("Carteirinha do convênio")?.key).toBe("insuranceCard");
    expect(directImportField("E-mail do responsável")?.key).toBe("guardianEmail");
  });

  test("recognizes absence values without creating health categories", () => {
    for (const value of ["Não", "nada", "Nenhuma", "-", "sem alergias", "não tenho alergia", "sem problema de saúde"]) expect(isEmptyCategoryValue(value)).toBe(true);
    expect(isEmptyCategoryValue("Não come amendoim")).toBe(false);
  });

  test("normalizes leading zeroes in room and bus numbers", () => {
    expect(extractImportNumber("Ônibus 01 - azul")).toBe("1");
    expect(extractImportNumber("bus 1")).toBe("1");
    expect(extractImportNumber("Q0403")).toBe("403");
  });
});

function review(overrides: Partial<CamperImportReviewItem>): CamperImportReviewItem {
  return { id: "review-1", row: 2, kind: "leader", field: "leader", kidName: "Ana", guardianName: "", birthDate: "", age: null, emergencyContact: "", original: "Tia Bia", value: "", skip: false, resolved: false, ...overrides };
}

describe("camper import review delta", () => {
  test("one grouped leader correction updates every affected child", () => {
    const preview = [
      { row: 2, name: "Ana", birthDate: "2017-01-02", guardianName: "Maria", guardianPhone: "+5511999999999", caretakerId: null, blocked: true },
      { row: 5, name: "Bia", birthDate: "2017-03-04", guardianName: "Joana", guardianPhone: "+5511999999999", caretakerId: null, blocked: true },
    ];
    const result = applyImportDelta(preview, [review({ affectedRows: [2, 5], options: [{ id: "staff-id", label: "Tia Bia" }] })], { "review-1": { value: "staff-id" } });
    expect(result.skipped).toEqual([]);
    expect(result.rows.map((r) => r.caretakerId)).toEqual(["staff-id", "staff-id"]);
    expect(result.rows.every((r) => r.blocked === false)).toBe(true);
  });

  test("skipping a grouped required correction skips each affected child once", () => {
    const preview = [
      { row: 2, name: "Ana", birthDate: "2017-01-02", guardianName: "Maria", guardianPhone: "+5511999999999", blocked: true },
      { row: 5, name: "Bia", birthDate: "2017-03-04", guardianName: "Joana", guardianPhone: "+5511999999999", blocked: true },
    ];
    const result = applyImportDelta(preview, [review({ affectedRows: [2, 5] })], { "review-1": { skip: true } });
    expect(result.skipped.map((r) => r.row)).toEqual([2, 5]);
    expect(result.rows.every((r) => r.blocked === true)).toBe(true);
  });

  test("an imported camper enters the background review queue", () => {
    const data = camperDataFromPreview({ row: 2, name: "Ana", birthDate: "2017-01-02", blocked: false }, "import-id");
    expect(data?.importId).toBe("import-id");
    expect(data?.aiReviewStatus).toBe("pending");
  });
});
