import * as XLSX from "xlsx";
import { randomUUID } from "node:crypto";
import { Script } from "node:vm";
import { findBedroomByName, insertBedroom, listBedrooms, updateBedroom } from "../models/bedrooms";
import { insertCamper, type CamperData } from "../models/campers";
import { appendCategoryOption, listCategories, newOptionId } from "../models/categories";
import { insertStaff, listStaff, type StaffData } from "../models/staff";
import { insertTeam, listTeams, TEAM_PALETTE } from "../models/teams";
import { insertTransport, listTransports, nextTransportOrder } from "../models/transports";
import { busColorName, BUS_COLORS, CAMPER_CATEGORY_KEYS, bedroomCapacity, type BedroomGroup, type CamperImportDictionaryEntry, type CamperImportReviewItem, type CamperSex, type Category, type Staff } from "../types";
import { formatCpf, normalizeBrazilPhone, titleCaseName } from "../utils";
import { transportLabel } from "../routes/transports";
import { resolveCamperSex } from "./camperSex";
import { bestImportMatch, bestImportMatches, dedupeImportValues, guessNamesSex, mapImportColumns, matchLeaderWithAi, askDateParser } from "./importAi";
import { getDb } from "../db";
import { listImportDictionary, type CamperImportColumn, type CamperImportCreatedItem } from "../models/camperImports";
import { ensureLoginAccount } from "../models/users";

export const IMPORT_FILE_MAX_BYTES = 12 * 1024 * 1024;
export const IMPORT_ROWS_MAX = 5_000;

export const IMPORT_FIELDS = [
  { key: "name", label: "Nome da criança", aliases: ["nome", "nome completo", "acampante", "criança"], required: true },
  { key: "birthDate", label: "Data de nascimento", aliases: ["nascimento", "data nascimento", "data de nascimento"], required: true },
  { key: "bed", label: "Posição da cama", aliases: ["cama", "beliche", "posição cama", "bed position"] },
  { key: "bedroomPreference", label: "Preferência de quarto", aliases: ["quer ficar com", "dividir quarto", "preferência quarto", "gostaria de ficar no mesmo quarto de alguém"] },
  { key: "team", label: "Time", aliases: ["equipe", "team", "cor" ] },
  { key: "transportation", label: "Transporte", aliases: ["ônibus", "onibus", "bus", "veículo", "veiculo"] },
  { key: "bedroom", label: "Quarto", aliases: ["dormitório", "dormitorio", "room", "alojamento"] },
  { key: "leader", label: "Líder", aliases: ["lider", "líder", "tio", "tia", "monitor", "responsável quarto"] },
  { key: "cpf", label: "CPF da criança", aliases: ["cpf", "cpf acampante", "cpf criança"] },
  { key: "guardianCpf", label: "CPF do responsável", aliases: ["cpf responsavel", "cpf responsável", "cpf pai", "cpf mãe"] },
  { key: "rg", label: "RG", aliases: ["identidade"] },
  { key: "school", label: "Escola", aliases: ["colégio", "colegio"] },
  { key: "schoolGrade", label: "Série", aliases: ["serie", "ano escolar", "série escolar", "série/ano escolar", "turma"] },
  { key: "church", label: "Frequenta igreja", aliases: ["igreja", "igreja que frequenta", "congregação", "congregacao"] },
  { key: "invitedBy", label: "Convidado por", aliases: ["quem convidou", "indicação", "indicacao"] },
  { key: "guardianName", label: "Nome do responsável", aliases: ["responsável", "responsavel", "nome pai", "nome mãe", "nome mae"] },
  { key: "guardianPhone", label: "Telefone do responsável", aliases: ["telefone", "celular", "whatsapp", "fone responsável"] },
  { key: "guardianEmail", label: "E-mail", aliases: ["email", "e-mail responsável", "e-mail do responsável", "email do responsável"] },
  { key: "emergencyContact", label: "Contato de emergência", aliases: ["emergência", "emergencia", "contato emergencia", "contato de emergência nome e telefone"] },
  { key: "insurance", label: "Convênio médico", aliases: ["convenio", "plano de saúde", "plano saude"] },
  { key: "insuranceCard", label: "Carteirinha", aliases: ["número carteirinha", "numero carteirinha", "número da carteirinha", "numero da carteirinha", "carteirinha do convênio", "carteirinha do convenio"] },
  { key: "weightKg", label: "Peso", aliases: ["peso kg", "peso aproximado kg", "weight"] },
  { key: "allergies", label: "Alergias", aliases: ["alergia", "a criança tem alguma alergia", "a crianca tem alguma alergia"] },
  { key: "drugAllergies", label: "Alergia a medicamentos", aliases: ["alergia medicamento", "alergia a medicamento", "alergia a remédio", "medicine allergies"] },
  { key: "healthIssues", label: "Condições de saúde", aliases: ["condição crônica", "condicoes cronicas", "doenças crônicas", "problemas de saúde"] },
  { key: "neurodivergent", label: "Neurodivergente", aliases: ["neurodivergência", "neurodivergencia", "tea", "tdah", "autismo"] },
  { key: "dailyMedication", label: "Medicação de uso diário", aliases: ["medicacao uso diario", "medicamentos de uso diário", "medicamentos de uso diario", "remédio diário", "remedio diario"] },
  { key: "foodRestrictions", label: "Restrição alimentar", aliases: ["restrições alimentares", "restricoes alimentares", "restrição de alimentação", "alimentação", "alimentacao", "food restriction"] },
  { key: "healthNotes", label: "Observações médicas", aliases: ["observacao medica", "observações de saúde", "observacoes de saude", "saúde", "saude"] },
  { key: "generalNotes", label: "Observações", aliases: ["outras observações", "observacoes gerais", "notas"] },
] as const;

export type ImportField = (typeof IMPORT_FIELDS)[number]["key"];

export interface ImportAnalysis {
  columns: CamperImportColumn[];
  rows: Record<string, string>[];
  dictionaries: CamperImportDictionaryEntry[];
  reviews: CamperImportReviewItem[];
  preview: Record<string, unknown>[];
  skipped: Record<string, unknown>[];
  createdItems: CamperImportCreatedItem[];
  dateFunction: string;
  status: "needs_mapping" | "panic" | "review" | "ready";
  panicMessage: string;
}

export interface ImportLookups {
  bedrooms: Awaited<ReturnType<typeof listBedrooms>>;
  transports: Awaited<ReturnType<typeof listTransports>>;
  teams: Awaited<ReturnType<typeof listTeams>>;
  categories: Awaited<ReturnType<typeof listCategories>>;
  staff: Awaited<ReturnType<typeof listStaff>>;
}

export const normalizeImportValue = (value: string): string => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("pt-BR").replace(/[^a-z0-9]+/g, " ").trim();
const normalize = normalizeImportValue;
const compact = (value: string): string => normalize(value).replace(/\s/g, "");
const text = (v: unknown): string => v == null ? "" : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).trim();

export function isEmptyCategoryValue(value: string): boolean {
  const n = normalize(value);
  if (!n || [
    "n", "na", "nao", "nada", "nenhum", "nenhuma", "nenhuns", "nenhumas",
    "nao tenho", "nao tem", "nao possui", "nao possuo", "sem", "inexistente",
    "sem alergia", "sem alergias", "nenhuma alergia", "nenhuma alergias",
    "sem restricao", "sem restricoes", "sem doenca", "sem doencas",
  ].includes(n)) return true;
  return /^(?:nao (?:tenho|tem|possui|possuo)|sem|nenhum(?:a)?) (?:alergia(?:s)?|problema(?:s)? de saude|condicao|condicoes|doenca|doencas|restricao|restricoes)$/.test(n);
}

function phraseContained(longer: string, shorter: string): boolean {
  return ` ${longer} `.includes(` ${shorter} `);
}

export function directImportField(header: string): { key: ImportField; confidence: number } | null {
  const h = normalize(header);
  let best: { key: ImportField; confidence: number; specificity: number } | null = null;
  let bestConfidence = 0;
  let bestSpecificity = 0;
  for (const field of IMPORT_FIELDS) {
    for (const alias of [field.label, ...field.aliases]) {
      const a = normalize(alias);
      const specificity = a.split(" ").filter(Boolean).length * 100 + a.length;
      const confidence = h === a ? 1
        : compact(h) === compact(a) ? .97
          : phraseContained(h, a) && a.split(" ").length >= 2 ? .86
            : phraseContained(a, h) && h.split(" ").length >= 2 ? .83
              : 0;
      if (confidence > bestConfidence || (confidence === bestConfidence && specificity > bestSpecificity)) {
        best = { key: field.key, confidence, specificity };
        bestConfidence = confidence;
        bestSpecificity = specificity;
      }
    }
  }
  return best && best.confidence >= .82 ? { key: best.key, confidence: best.confidence } : null;
}

const directField = directImportField;

export function parseSpreadsheet(data: Uint8Array, fileName: string): { rows: Record<string, string>[]; columns: { name: string; samples: string[] }[] } {
  // SheetJS otherwise treats headerless CSV bytes as a legacy code page on
  // some inputs, turning "saúde" into "saÃºde" before column matching.
  const textFile = /\.(?:csv|tsv|txt)$/i.test(fileName);
  const workbook = textFile
    ? XLSX.read(new TextDecoder("utf-8").decode(data).replace(/^\uFEFF/, ""), { type: "string", cellDates: false, raw: true, codepage: 65001 })
    : XLSX.read(data, { type: "array", cellDates: true, codepage: 65001 });
  const sheet = workbook.Sheets[workbook.SheetNames[0] ?? ""];
  if (!sheet) throw new Error("A planilha não tem abas legíveis.");
  // CSV values must remain literal strings: formatting them makes SheetJS
  // turn 2016-12-15 into 12/14/16 in the local timezone. Excel cells still
  // use their displayed value so formatted dates remain human-readable.
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "", raw: textFile, blankrows: false });
  if (matrix.length < 2) throw new Error("A planilha precisa ter cabeçalho e ao menos uma criança.");
  const rawHeaders = (matrix[0] ?? []).map(text);
  const headers: string[] = [];
  const used = new Map<string, number>();
  rawHeaders.forEach((raw, i) => {
    const base = raw || `Coluna ${i + 1}`;
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    headers.push(n === 1 ? base : `${base} (${n})`);
  });
  const rows = matrix.slice(1, IMPORT_ROWS_MAX + 1).map((line) => Object.fromEntries(headers.map((h, i) => [h, text(line?.[i])]))).filter((row) => Object.values(row).some(Boolean));
  if (rows.length === 0) throw new Error(`Nenhum registro foi encontrado em ${fileName}.`);
  const columns = headers.map((name) => ({ name, samples: rows.map((r) => r[name]).filter(Boolean).slice(0, 5) }));
  return { rows, columns };
}

export async function mapColumns(columns: { name: string; samples: string[] }[], override: Record<string, string | null> = {}, signal?: AbortSignal): Promise<CamperImportColumn[]> {
  const saved = new Map((await listImportDictionary()).filter((d) => d.kind === "column" && d.field.startsWith("column:")).map((d) => [d.normalized, typeof d.value === "string" ? d.value : null]));
  const unresolved = columns.filter((c) => override[c.name] === undefined && !directField(c.name) && !saved.has(normalize(c.name)));
  const ai = unresolved.length ? await mapImportColumns(unresolved, IMPORT_FIELDS.map((f) => ({ key: f.key, label: f.label, aliases: [...f.aliases], required: "required" in f && f.required })), signal) : {};
  const used = new Set<string>();
  return columns.map((c) => {
    const direct = directField(c.name);
    const requested = override[c.name] !== undefined ? override[c.name] : direct?.key ?? saved.get(normalize(c.name)) ?? ai[c.name]?.target ?? null;
    const target = requested && IMPORT_FIELDS.some((f) => f.key === requested) && !used.has(requested) ? requested : null;
    if (target) used.add(target);
    return { source: c.name, target, confidence: override[c.name] !== undefined ? 1 : direct?.confidence ?? ai[c.name]?.confidence ?? 0, samples: c.samples };
  });
}

export function sourceMap(columns: CamperImportColumn[]): Map<string, string> {
  return new Map(columns.filter((c): c is CamperImportColumn & { target: string } => !!c.target).map((c) => [c.target, c.source]));
}

export function valueOf(row: Record<string, string>, sources: Map<string, string>, field: string): string {
  const source = sources.get(field);
  return source ? row[source]?.trim() ?? "" : "";
}

function validCpf(raw: string): string {
  const d = raw.replace(/\D/g, "");
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return "";
  const calc = (len: number) => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(d[i]) * (len + 1 - i);
    const r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return calc(9) === Number(d[9]) && calc(10) === Number(d[10]) ? formatCpf(d) : "";
}

function validEmail(raw: string): string {
  const value = raw.trim().toLowerCase();
  return !value || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? value : "";
}

export function importPhone(raw: string): string | null {
  let d = raw.replace(/\D/g, "");
  if ((d.length === 12 || d.length === 13) && d.startsWith("55")) d = d.slice(2);
  if (d.length === 9) d = `11${d}`;
  return normalizeBrazilPhone(d);
}

function parseWeight(raw: string): number | null {
  const match = raw.replace(",", ".").match(/\d+(?:\.\d+)?/);
  const n = match ? Number(match[0]) : NaN;
  return Number.isFinite(n) && n >= 5 && n <= 200 ? Math.round(n * 10) / 10 : null;
}

function daysInMonth(year: number, month: number): number { return new Date(Date.UTC(year, month, 0)).getUTCDate(); }
function isoDate(y: number, m: number, d: number): string | null {
  if (y < 1900 || y > new Date().getFullYear() || m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function ageOfIso(value: string | null): number | null {
  if (!value) return null;
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return null;
  const now = new Date();
  let age = now.getUTCFullYear() - year;
  if (now.getUTCMonth() + 1 < month || (now.getUTCMonth() + 1 === month && now.getUTCDate() < day)) age--;
  return Math.max(0, age);
}

export const BUILTIN_DATE_FUNCTION = `function parseImportDate(value) {
  const s = String(value ?? "").trim(); if (!s) return null;
  let m = /^(\\d{1,2})[\\/-](\\d{1,2})[\\/-](\\d{4})$/.exec(s); if (m) return isoDate(+m[3], +m[2], +m[1]);
  m = /^(\\d{4})[\\/-](\\d{1,2})[\\/-](\\d{1,2})$/.exec(s); if (m) return isoDate(+m[1], +m[2], +m[3]);
  m = /^(\\d{1,2})[\\/-](\\d{1,2})[\\/-](\\d{2})$/.exec(s); if (m) return isoDate(2000 + +m[3], +m[2], +m[1]);
  if (/^\\d+(?:\\.\\d+)?$/.test(s)) { const serial = Number(s); const date = new Date(Date.UTC(1899, 11, 30) + serial * 86400000); return isoDate(date.getUTCFullYear(), date.getUTCMonth()+1, date.getUTCDate()); }
  return null;
}`;

function parseBuiltInDate(value: string): string | null {
  const s = value.trim();
  let m = /^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/.exec(s);
  if (m) return isoDate(+m[3], +m[2], +m[1]);
  m = /^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})$/.exec(s);
  if (m) return isoDate(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2})$/.exec(s);
  if (m) return isoDate(2000 + +m[3], +m[2], +m[1]);
  if (/^\d+(?:\.\d+)?$/.test(s)) {
    const date = new Date(Date.UTC(1899, 11, 30) + Number(s) * 86400000);
    return isoDate(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
  }
  return null;
}

const FORBIDDEN_DATE_SOURCE = /\b(?:eval|Function|constructor|prototype|__proto__|process|global|globalThis|require|import|fetch|XMLHttpRequest|WebSocket|Bun|Deno|WebAssembly|setTimeout|setInterval)\b/;
function parseAiDate(source: string, value: string): string | null {
  if (!source || source.length > 4_000 || FORBIDDEN_DATE_SOURCE.test(source)) return null;
  try {
    // Fable is asked for a function body, but tolerate a full declaration too.
    const declaredBody = /^\s*function\s+parseImportDate\s*\([^)]*\)\s*\{([\s\S]*)\}\s*;?\s*$/.exec(source)?.[1];
    const body = declaredBody ?? source;
    const script = new Script(`"use strict"; const value = ${JSON.stringify(value)}; const isoDate = (y,m,d) => { const dt = new Date(Date.UTC(y,m-1,d)); return dt.getUTCFullYear()===y && dt.getUTCMonth()+1===m && dt.getUTCDate()===d ? String(y).padStart(4,"0")+"-"+String(m).padStart(2,"0")+"-"+String(d).padStart(2,"0") : null; }; (() => { ${body} })()`);
    const out = script.runInNewContext({ Date }, { timeout: 25 });
    return typeof out === "string" && /^\d{4}-\d{2}-\d{2}$/.test(out) && !Number.isNaN(Date.parse(`${out}T00:00:00Z`)) ? out : null;
  } catch {
    return null;
  }
}

function review(kind: CamperImportReviewItem["kind"], row: number, kidName: string, original: string, extras: Partial<CamperImportReviewItem> = {}): CamperImportReviewItem {
  return { id: randomUUID(), row, kind, field: kind, kidName, guardianName: "", birthDate: "", age: null, emergencyContact: "", original, value: "", skip: false, resolved: false, ...extras };
}

export function deterministicLeader(raw: string, staff: Staff[]): { id: string | null; options: Staff[] } {
  const words = normalize(raw).split(" ").filter(Boolean);
  if (!words.length) return { id: null, options: [] };
  const scored = staff.map((s) => {
    const sw = normalize(s.name).split(" ").filter(Boolean);
    let score = compact(s.name) === compact(raw) ? 100 : 0;
    if (words.length === 1 && sw[0] === words[0]) score = Math.max(score, 80);
    if (words.length >= 2 && sw[0] === words[0] && sw.at(-1) === words.at(-1)) score = Math.max(score, 95);
    if (words.length >= 2 && sw[0] === words[0] && sw[1] === words[1]) score = Math.max(score, 90);
    if (sw[0] === words[0] && words.some((w) => sw.includes(w))) score = Math.max(score, 75);
    return { staff: s, score };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
  if (!scored.length) return { id: null, options: [] };
  const top = scored[0].score;
  const options = scored.filter((x) => x.score === top).map((x) => x.staff);
  return { id: options.length === 1 && top >= 80 ? options[0]._id : null, options };
}

export function extractImportNumber(raw: string): string | null {
  const found = raw.match(/\d+/)?.[0];
  return found ? String(Number(found)) : null;
}
const numberFrom = extractImportNumber;

function deterministicMatch(raw: string, candidates: { id: string; label: string }[]): string | null {
  const n = normalize(raw);
  const exact = candidates.find((c) => normalize(c.label) === n || compact(c.label) === compact(raw));
  if (exact) return exact.id;
  const number = numberFrom(raw);
  if (number) {
    const numbered = candidates.filter((c) => numberFrom(c.label) === number);
    if (numbered.length === 1) return numbered[0].id;
  }
  const contained = candidates.filter((c) => normalize(c.label).includes(n) || n.includes(normalize(c.label)));
  return contained.length === 1 ? contained[0].id : null;
}

async function addCategoryOption(cat: Category, label: string, importId: string): Promise<string> {
  const option = { id: newOptionId(), label: label.trim().slice(0, 80), order: cat.options.length, active: true, draft: true, importId };
  if (!(await appendCategoryOption(cat._id, option))) throw new Error(`Não foi possível criar a opção ${option.label}.`);
  cat.options.push(option);
  return option.id;
}

export async function resolveCategoryValue(field: "bed" | "allergies" | "drugAllergies" | "healthIssues", canonical: string, lookups: ImportLookups, createdItems: CamperImportCreatedItem[], importId: string, signal?: AbortSignal): Promise<string | null> {
  const key = CAMPER_CATEGORY_KEYS[field];
  const cat = lookups.categories.find((c) => c.key === key);
  if (!cat || !canonical) return null;
  const candidates = cat.options.map((o) => ({ id: o.id, label: o.label }));
  let id = deterministicMatch(canonical, candidates);
  if (!id) {
    const ai = await bestImportMatch(`opção da categoria ${cat.name}`, canonical, candidates, signal);
    id = ai.id;
    if (!id) {
      const name = titleCaseName(ai.createName || canonical);
      id = await addCategoryOption(cat, name, importId);
      createdItems.push({ kind: "categoryOption", id, label: `${cat.name}: ${name}`, draft: true });
    }
  }
  return id;
}

export async function resolveCategoryValues(field: "bed" | "allergies" | "drugAllergies" | "healthIssues", canonicals: string[], lookups: ImportLookups, createdItems: CamperImportCreatedItem[], importId: string, signal?: AbortSignal): Promise<Map<string, string | null>> {
  const result = new Map<string, string | null>();
  const key = CAMPER_CATEGORY_KEYS[field];
  const cat = lookups.categories.find((c) => c.key === key);
  if (!cat) return result;
  const candidates = cat.options.map((o) => ({ id: o.id, label: o.label }));
  const unresolved: string[] = [];
  for (const canonical of canonicals) {
    if (field !== "bed" && isEmptyCategoryValue(canonical)) { result.set(canonical, null); continue; }
    const id = deterministicMatch(canonical, candidates);
    if (id) result.set(canonical, id); else unresolved.push(canonical);
  }
  const matches = await bestImportMatches(`opção da categoria ${cat.name}`, unresolved, candidates, signal);
  for (const canonical of unresolved) {
    const match = matches[canonical];
    if (match && !match.id && !match.createName) { result.set(canonical, null); continue; }
    let id = match?.id ?? deterministicMatch(match?.createName || canonical, cat.options.map((o) => ({ id: o.id, label: o.label })));
    if (!id) {
      const name = titleCaseName(match?.createName || canonical);
      id = await addCategoryOption(cat, name, importId);
      createdItems.push({ kind: "categoryOption", id, label: `${cat.name}: ${name}`, draft: true });
    }
    result.set(canonical, id);
  }
  return result;
}

async function createTransportFor(raw: string, lookups: ImportLookups, createdItems: CamperImportCreatedItem[], importId: string): Promise<string> {
  const number = numberFrom(raw);
  const normalized = normalize(raw);
  const namedColor = BUS_COLORS.find((c) => normalized.includes(normalize(c.name))) ?? BUS_COLORS[lookups.transports.filter((t) => t.kind === "bus").length % BUS_COLORS.length];
  const transport = await insertTransport(number
    ? { kind: "bus", color: namedColor.hex, number, order: await nextTransportOrder(), draft: true, importId }
    : { kind: "car", name: titleCaseName(raw || "Carro"), order: await nextTransportOrder(), draft: true, importId });
  lookups.transports.push(transport);
  createdItems.push({ kind: "transportation", id: transport._id, label: transportLabel(transport), draft: true });
  return transport._id;
}

export async function resolveTransport(raw: string, lookups: ImportLookups, createdItems: CamperImportCreatedItem[], importId: string, signal?: AbortSignal): Promise<string | null> {
  if (!raw) return null;
  const candidates = lookups.transports.map((t) => ({ id: t._id, label: transportLabel(t) }));
  let id = deterministicMatch(raw, candidates);
  if (!id) id = (await bestImportMatch("transporte (ônibus, van ou carro)", raw, candidates, signal)).id;
  return id ?? createTransportFor(raw, lookups, createdItems, importId);
}

export async function resolveTeam(raw: string, lookups: ImportLookups, createdItems: CamperImportCreatedItem[], importId: string, signal?: AbortSignal): Promise<string | null> {
  if (!raw) return null;
  const candidates = lookups.teams.map((t) => ({ id: t._id, label: t.name }));
  let id = deterministicMatch(raw, candidates);
  let createName = raw;
  if (!id) {
    const ai = await bestImportMatch("time do acampamento", raw, candidates, signal);
    id = ai.id;
    createName = ai.createName || raw;
  }
  if (id) return id;
  const name = titleCaseName(createName);
  const team = await insertTeam({ name, color: TEAM_PALETTE[lookups.teams.length % TEAM_PALETTE.length], order: lookups.teams.length, draft: true, importId });
  lookups.teams.push(team);
  createdItems.push({ kind: "team", id: team._id, label: team.name, draft: true });
  return team._id;
}

export async function resolveBedroom(raw: string, names: string[], lookups: ImportLookups, createdItems: CamperImportCreatedItem[], importId: string, signal?: AbortSignal): Promise<string | null> {
  if (!raw) return null;
  const candidates = lookups.bedrooms.map((b) => ({ id: b._id, label: b.name }));
  let id = deterministicMatch(raw, candidates);
  if (id) return id;
  const name = numberFrom(raw) || titleCaseName(raw).slice(0, 30);
  const sex = await guessNamesSex(names.slice(0, 7).map((n) => n.split(" ")[0]), signal);
  const inferred = sex === "M" ? "boys" : sex === "F" ? "girls" : normalize(raw).includes("menin") ? (normalize(raw).includes("menina") ? "girls" : "boys") : null;
  // Never silently put a mixed or ambiguous group in the boys' wing. Staff
  // import will ask for the room; campers may remain without one, as allowed.
  if (!inferred) return null;
  const group: BedroomGroup = inferred;
  const data = { name, group, bunkBeds: Math.max(1, Math.ceil(names.length / 2)), singleBeds: 0, notes: "Criado pelo importador; confirme a quantidade de camas.", draft: true, importId };
  // An abandoned dry-run may still own the unique room name. Adopt that
  // hidden draft so a corrected retry can finish instead of hitting E11000.
  const abandoned = await findBedroomByName(name);
  const room = abandoned?.draft ? (await updateBedroom(abandoned._id, data))! : await insertBedroom(data);
  lookups.bedrooms.push(room);
  createdItems.push({ kind: "bedroom", id: room._id, label: `${room.name} (${group})`, draft: true });
  return room._id;
}

export function concatOtherColumns(row: Record<string, string>, mappedSources: Set<string>, prefix = ""): string {
  return Object.entries(row).filter(([key, value]) => value && !mappedSources.has(key)).map(([key, value]) => `${prefix}${key}: ${value}.`).join(" ");
}

export async function analyzeCamperImport(input: { data: Uint8Array; fileName: string; fileType: string; importId: string; mapping?: Record<string, string | null>; mapOnly?: boolean; signal?: AbortSignal }): Promise<ImportAnalysis> {
  const parsed = parseSpreadsheet(input.data, input.fileName);
  const columns = await mapColumns(parsed.columns, input.mapping, input.signal);
  const sources = sourceMap(columns);
  const missing = IMPORT_FIELDS.filter((f) => "required" in f && f.required && !sources.has(f.key)).map((f) => f.key);
  if (missing.length) return { columns, rows: parsed.rows, dictionaries: [], reviews: [], preview: [], skipped: [], createdItems: [], dateFunction: BUILTIN_DATE_FUNCTION, status: "needs_mapping", panicMessage: `Escolha as colunas de ${missing.map((k) => IMPORT_FIELDS.find((f) => f.key === k)?.label).join(" e ")}.` };
  // The first pass exists only to let the user verify AI column choices. Do
  // not create drafts or spend more model calls until that mapping is accepted.
  if (input.mapOnly) return { columns, rows: parsed.rows, dictionaries: [], reviews: [], preview: [], skipped: [], createdItems: [], dateFunction: BUILTIN_DATE_FUNCTION, status: "needs_mapping", panicMessage: "" };

  const [bedrooms, transports, teams, rawCategories, staff, previousDictionary] = await Promise.all([listBedrooms(), listTransports(), listTeams(), listCategories(), listStaff({ active: true }), listImportDictionary()]);
  // Draft entities belong to another unfinished import and must never leak
  // into this preview. Published dictionary values are still reused below.
  const categories = rawCategories.map((cat) => ({ ...cat, options: cat.options.filter((option) => !option.draft) }));
  const lookups: ImportLookups = { bedrooms, transports, teams, categories, staff };
  const createdItems: CamperImportCreatedItem[] = [];
  const dictionaries: CamperImportDictionaryEntry[] = [];
  const reviews: CamperImportReviewItem[] = [];
  const preview: Record<string, unknown>[] = [];
  const skipped: Record<string, unknown>[] = [];
  const mappedSources = new Set(columns.filter((c) => c.target).map((c) => c.source));
  const groupedFields = ["bedroom", "leader", "transportation", "team", "neurodivergent", "bed", "allergies", "drugAllergies", "healthIssues"] as const;
  const grouped = Object.fromEntries(groupedFields.map((field) => [field, [...new Set(parsed.rows.map((row) => valueOf(row, sources, field)).filter(Boolean))]])) as Record<(typeof groupedFields)[number], string[]>;
  const existingDict = new Map(previousDictionary.map((d) => [`${d.field}:${d.normalized}`, d]));
  const dedupedEntries = await Promise.all(groupedFields.map(async (field) => {
    const known: Record<string, string | boolean> = {};
    const unknown: string[] = [];
    for (const raw of grouped[field]) {
      const saved = existingDict.get(`${field}:${normalize(raw)}`);
      if (saved) known[raw] = field === "neurodivergent" ? saved.value === true : saved.label || raw;
      else unknown.push(raw);
    }
    return [field, { ...known, ...(await dedupeImportValues(field, unknown, input.signal)) }] as const;
  }));
  const deduped = Object.fromEntries(dedupedEntries) as Record<string, Record<string, string | boolean>>;

  const birthValues = parsed.rows.map((row) => valueOf(row, sources, "birthDate")).filter(Boolean);
  const savedDate = previousDictionary.find((d) => d.field === "birthDate" && d.kind === "date" && typeof d.value === "string")?.value as string | undefined;
  let dateFunction = savedDate || BUILTIN_DATE_FUNCTION;
  const parseDate = (value: string) => parseBuiltInDate(value) ?? (dateFunction === BUILTIN_DATE_FUNCTION ? null : parseAiDate(dateFunction, value));
  let dateSuccess = birthValues.filter((v) => !!parseDate(v)).length;
  if (birthValues.length && dateSuccess / birthValues.length < .9) {
    dateFunction = (await askDateParser(birthValues.slice(0, 40), input.signal)) || BUILTIN_DATE_FUNCTION;
    dateSuccess = birthValues.filter((v) => !!parseDate(v)).length;
  }
  const dateLoss = birthValues.length ? 1 - dateSuccess / birthValues.length : 0;
  const panicMessage = dateLoss > .1 ? "Não consegui identificar o formato de mais de 10% das datas. Use o formato brasileiro dd/MM/aaaa." : "";

  const rowsByBedroom = new Map<string, string[]>();
  for (const row of parsed.rows) {
    const raw = valueOf(row, sources, "bedroom");
    if (!raw) continue;
    const canonical = String(deduped.bedroom?.[raw] ?? raw);
    rowsByBedroom.set(canonical, [...(rowsByBedroom.get(canonical) ?? []), titleCaseName(valueOf(row, sources, "name"))]);
  }

  const resolution = new Map<string, unknown>();
  const tasks: Promise<void>[] = [];
  const uniqueCanonical = (field: string) => [...new Set(grouped[field as keyof typeof grouped].map((raw) => String(deduped[field]?.[raw] ?? raw)))];
  const seedSaved = (field: string) => {
    const validIds = field === "bedroom" ? new Set(lookups.bedrooms.map((x) => x._id))
      : field === "transportation" ? new Set(lookups.transports.map((x) => x._id))
      : field === "team" ? new Set(lookups.teams.map((x) => x._id))
      : field === "leader" ? new Set(lookups.staff.map((x) => x._id))
      : new Set(lookups.categories.flatMap((x) => x.options.map((o) => o.id)));
    for (const raw of grouped[field as keyof typeof grouped]) {
      const saved = existingDict.get(`${field}:${normalize(raw)}`);
      if (typeof saved?.value === "string" && validIds.has(saved.value)) resolution.set(`${field}:${String(deduped[field]?.[raw] ?? raw)}`, saved.value);
    }
  };
  for (const field of ["transportation", "team", "bedroom", "leader", "bed", "allergies", "drugAllergies", "healthIssues"]) seedSaved(field);
  for (const canonical of uniqueCanonical("transportation")) if (!resolution.has(`transportation:${canonical}`)) tasks.push(resolveTransport(canonical, lookups, createdItems, input.importId, input.signal).then((id) => { resolution.set(`transportation:${canonical}`, id); }));
  for (const canonical of uniqueCanonical("team")) if (!resolution.has(`team:${canonical}`)) tasks.push(resolveTeam(canonical, lookups, createdItems, input.importId, input.signal).then((id) => { resolution.set(`team:${canonical}`, id); }));
  for (const canonical of uniqueCanonical("bedroom")) if (!resolution.has(`bedroom:${canonical}`)) tasks.push(resolveBedroom(canonical, rowsByBedroom.get(canonical) ?? [], lookups, createdItems, input.importId, input.signal).then((id) => { resolution.set(`bedroom:${canonical}`, id); }));
  // Each category mutates one options array, so values inside that category
  // are serial; the four independent categories still run in parallel.
  for (const field of ["bed", "allergies", "drugAllergies", "healthIssues"] as const) tasks.push((async () => {
    const values = uniqueCanonical(field).filter((canonical) => !resolution.has(`${field}:${canonical}`));
    const resolved = await resolveCategoryValues(field, values, lookups, createdItems, input.importId, input.signal);
    for (const [canonical, id] of resolved) resolution.set(`${field}:${canonical}`, id);
  })());
  for (const canonical of uniqueCanonical("leader")) {
    tasks.push((async () => {
      if (resolution.has(`leader:${canonical}`)) return;
      const match = deterministicLeader(canonical, staff);
      let id = match.id;
      if (!id && match.options.length <= 1) id = await matchLeaderWithAi(canonical, staff.map((s) => ({ id: s._id, name: s.name })), input.signal);
      resolution.set(`leader:${canonical}`, id);
      if (!id) resolution.set(`leaderOptions:${canonical}`, match.options.map((s) => ({ id: s._id, label: s.name })));
    })());
  }
  await Promise.all(tasks);

  for (const field of groupedFields) for (const raw of grouped[field]) {
    const canonical = deduped[field]?.[raw] ?? raw;
    const normalized = normalize(raw);
    let value: unknown = canonical;
    let kind: CamperImportDictionaryEntry["kind"] = "text";
    if (field === "neurodivergent") { value = canonical === true; kind = "boolean"; }
    else if (["bedroom", "transportation", "team", "leader"].includes(field)) { value = resolution.get(`${field === "leader" ? "leader" : field}:${String(canonical)}`) ?? null; kind = field === "leader" ? "staff" : field as CamperImportDictionaryEntry["kind"]; }
    else if (["bed", "allergies", "drugAllergies", "healthIssues"].includes(field)) { value = resolution.get(`${field}:${String(canonical)}`) ?? null; kind = "category"; }
    const old = existingDict.get(`${field}:${normalized}`);
    const finalValue = value ?? old?.value ?? null;
    const resolvedLabel = typeof finalValue === "string"
      ? field === "bedroom" ? lookups.bedrooms.find((x) => x._id === finalValue)?.name
        : field === "transportation" ? lookups.transports.find((x) => x._id === finalValue) && transportLabel(lookups.transports.find((x) => x._id === finalValue)!)
          : field === "team" ? lookups.teams.find((x) => x._id === finalValue)?.name
            : field === "leader" ? lookups.staff.find((x) => x._id === finalValue)?.name
              : lookups.categories.flatMap((x) => x.options).find((x) => x.id === finalValue)?.label
      : null;
    dictionaries.push({ field, raw, normalized, value: finalValue, label: resolvedLabel || String(canonical), draft: true, kind });
  }
  dictionaries.push({ field: "birthDate", raw: "*", normalized: "*", value: dateFunction, label: "Função de data", draft: true, kind: "date" });
  for (const col of columns) dictionaries.push({ field: `column:${normalize(col.source)}`, raw: col.source, normalized: normalize(col.source), value: col.target, label: col.target ?? "Ignorar", draft: true, kind: "column" });

  const dictValue = (field: string, raw: string) => dictionaries.find((d) => d.field === field && d.normalized === normalize(raw))?.value;
  const defaultBed = categories.find((c) => c.key === CAMPER_CATEGORY_KEYS.bed)?.options.filter((o) => o.active).at(-1)?.id ?? null;
  const leaderReviews = new Map<string, CamperImportReviewItem>();

  for (let i = 0; i < parsed.rows.length; i++) {
    const row = parsed.rows[i];
    const line = i + 2;
    const name = titleCaseName(valueOf(row, sources, "name"));
    const birthRaw = valueOf(row, sources, "birthDate");
    const birthDate = parseDate(birthRaw);
    const guardianName = titleCaseName(valueOf(row, sources, "guardianName"));
    const guardianPhoneRaw = valueOf(row, sources, "guardianPhone");
    const guardianPhone = importPhone(guardianPhoneRaw);
    const cpfRaw = valueOf(row, sources, "cpf");
    const guardianCpfRaw = valueOf(row, sources, "guardianCpf");
    const emailRaw = valueOf(row, sources, "guardianEmail");
    const email = validEmail(emailRaw);
    const leaderRaw = valueOf(row, sources, "leader");
    const leaderCanonical = String(deduped.leader?.[leaderRaw] ?? leaderRaw);
    const caretakerId = leaderRaw ? (dictValue("leader", leaderRaw) as string | null) : null;
    if (!birthDate) reviews.push(review("date", line, name, birthRaw, { guardianName, emergencyContact: valueOf(row, sources, "emergencyContact") }));
    const age = ageOfIso(birthDate);
    if (!guardianName) reviews.push(review("guardianName", line, name, "", { birthDate: birthDate ?? "", age, emergencyContact: valueOf(row, sources, "emergencyContact") }));
    if (!guardianPhone) reviews.push(review("phone", line, name, guardianPhoneRaw, { guardianName, emergencyContact: valueOf(row, sources, "emergencyContact") }));
    if (cpfRaw && !validCpf(cpfRaw)) reviews.push(review("cpf", line, name, cpfRaw, { field: "cpf", guardianName }));
    if (guardianCpfRaw && !validCpf(guardianCpfRaw)) reviews.push(review("cpf", line, name, guardianCpfRaw, { field: "guardianCpf", guardianName }));
    if (emailRaw && !email) reviews.push(review("email", line, name, emailRaw, { guardianName }));
    if (leaderRaw && !caretakerId) {
      const key = normalize(leaderCanonical);
      const existing = leaderReviews.get(key);
      if (existing) existing.affectedRows!.push(line);
      else {
        const item = review("leader", line, name, leaderRaw, { guardianName, affectedRows: [line], options: (resolution.get(`leaderOptions:${leaderCanonical}`) as { id: string; label: string }[] | undefined) ?? [] });
        leaderReviews.set(key, item);
        reviews.push(item);
      }
    }

    const allergiesRaw = valueOf(row, sources, "allergies");
    const drugRaw = valueOf(row, sources, "drugAllergies");
    const healthIssuesRaw = valueOf(row, sources, "healthIssues");
    const bedRaw = valueOf(row, sources, "bed");
    const notePieces = [
      valueOf(row, sources, "dailyMedication") && `Medicação de uso diário: ${valueOf(row, sources, "dailyMedication")}.`,
      valueOf(row, sources, "foodRestrictions") && `Restrição alimentar: ${valueOf(row, sources, "foodRestrictions")}.`,
      valueOf(row, sources, "healthNotes") && `Observações médicas: ${valueOf(row, sources, "healthNotes")}.`,
      allergiesRaw && !isEmptyCategoryValue(allergiesRaw) && !dictValue("allergies", allergiesRaw) && `Alergias informadas: ${allergiesRaw}.`,
      drugRaw && !isEmptyCategoryValue(drugRaw) && !dictValue("drugAllergies", drugRaw) && `Alergias a medicamentos informadas: ${drugRaw}.`,
      healthIssuesRaw && !isEmptyCategoryValue(healthIssuesRaw) && !dictValue("healthIssues", healthIssuesRaw) && `Condições de saúde informadas: ${healthIssuesRaw}.`,
      valueOf(row, sources, "generalNotes"),
      concatOtherColumns(row, mappedSources),
    ].filter(Boolean).join(" ").trim();
    const item = {
      row: line,
      name,
      birthDate,
      sex: null,
      cpf: validCpf(cpfRaw),
      rg: valueOf(row, sources, "rg"),
      school: valueOf(row, sources, "school"),
      schoolGrade: valueOf(row, sources, "schoolGrade"),
      church: valueOf(row, sources, "church"),
      invitedBy: valueOf(row, sources, "invitedBy"),
      caretakerId,
      team: valueOf(row, sources, "team") ? dictValue("team", valueOf(row, sources, "team")) ?? null : null,
      transportation: valueOf(row, sources, "transportation") ? dictValue("transportation", valueOf(row, sources, "transportation")) ?? null : null,
      bed: bedRaw ? dictValue("bed", bedRaw) ?? defaultBed : defaultBed,
      bedroom: valueOf(row, sources, "bedroom") ? dictValue("bedroom", valueOf(row, sources, "bedroom")) ?? null : null,
      weightKg: parseWeight(valueOf(row, sources, "weightKg")),
      allergies: allergiesRaw && dictValue("allergies", allergiesRaw) ? [dictValue("allergies", allergiesRaw)] : [],
      drugAllergies: drugRaw && dictValue("drugAllergies", drugRaw) ? [dictValue("drugAllergies", drugRaw)] : [],
      healthIssues: healthIssuesRaw && dictValue("healthIssues", healthIssuesRaw) ? [dictValue("healthIssues", healthIssuesRaw)] : [],
      neurodivergent: valueOf(row, sources, "neurodivergent") ? dictValue("neurodivergent", valueOf(row, sources, "neurodivergent")) === true : false,
      medications: [],
      foodRestrictions: valueOf(row, sources, "foodRestrictions"),
      healthNotes: valueOf(row, sources, "healthNotes"),
      generalNotes: notePieces,
      bedroomPreference: valueOf(row, sources, "bedroomPreference"),
      insurance: valueOf(row, sources, "insurance"),
      insuranceCard: valueOf(row, sources, "insuranceCard"),
      emergencyContact: valueOf(row, sources, "emergencyContact"),
      guardianName,
      guardianPhone,
      guardianCpf: validCpf(guardianCpfRaw),
      guardianEmail: email,
      dailyMedicationText: valueOf(row, sources, "dailyMedication"),
      foodRestrictionText: valueOf(row, sources, "foodRestrictions"),
    };
    const blocking = !name || !birthDate || !guardianName || !guardianPhone || (!!leaderRaw && !caretakerId);
    if (blocking) skipped.push({ row: line, name, reason: !name ? "Nome ausente" : !birthDate ? "Data inválida" : !guardianName ? "Responsável ausente" : !guardianPhone ? "Telefone inválido" : "Líder não encontrado" });
    preview.push({ ...item, blocked: blocking });
  }

  const status = panicMessage ? "panic" : reviews.some((r) => ["leader", "date", "guardianName", "phone"].includes(r.kind)) ? "review" : "ready";
  return { columns, rows: parsed.rows, dictionaries, reviews, preview, skipped, createdItems, dateFunction, status, panicMessage };
}

export function applyImportDelta(preview: Record<string, unknown>[], reviews: CamperImportReviewItem[], delta: Record<string, { value?: string; skip?: boolean }>): { rows: Record<string, unknown>[]; skipped: Record<string, unknown>[] } {
  const rows: Record<string, unknown>[] = preview.map((r) => ({ ...r, blocked: false }));
  const skipped: Record<string, unknown>[] = [];
  const blockedRows = new Set<number>();
  for (const item of reviews) {
    const change = delta[item.id] ?? {};
    const affectedRows = new Set(item.affectedRows?.length ? item.affectedRows : [item.row]);
    const targets = rows.filter((r) => affectedRows.has(Number(r.row)));
    if (!targets.length) continue;
    const value = (change.value ?? item.value).trim();
    const skip = change.skip ?? item.skip;
    if (skip) {
      if (["leader", "date", "guardianName", "phone"].includes(item.kind)) {
        for (const row of targets) {
          row.blocked = true;
          blockedRows.add(Number(row.row));
        }
      }
      continue;
    }
    for (const row of targets) {
      if (item.kind === "leader") {
        const allowed = !!value && ((item.resolved && value === item.value) || (item.options ?? []).some((option) => option.id === value));
        row.caretakerId = allowed ? value : null;
        if (!allowed) blockedRows.add(Number(row.row));
      }
      else if (item.kind === "date") row.birthDate = parseBuiltInDate(value);
      else if (item.kind === "guardianName") row.guardianName = titleCaseName(value);
      else if (item.kind === "phone") row.guardianPhone = importPhone(value);
      else if (item.kind === "cpf") row[item.field] = validCpf(value);
      else if (item.kind === "email") row.guardianEmail = validEmail(value);
    }
  }
  for (const row of rows) {
    let reason = blockedRows.has(Number(row.row)) ? "Revisão obrigatória ignorada" : "";
    if (!row.name) reason = "Nome ausente";
    else if (!row.birthDate) reason = "Data inválida";
    else if (!row.guardianName) reason = "Responsável ausente";
    else if (row.guardianPhone === null) reason = "Telefone inválido";
    if (reason) {
      row.blocked = true;
      skipped.push({ row: row.row, name: row.name, reason });
    }
  }
  return { rows, skipped };
}

export async function createLeaderFromReview(name: string, phone: string, importId: string): Promise<Staff> {
  const normalized = normalizeBrazilPhone(phone);
  if (!normalized) throw new Error("Informe um celular brasileiro válido com DDD.");
  const data: StaffData = { name: titleCaseName(name), sex: null, phone: normalized, active: true, team: null, transportation: null, bedroom: null, roomRole: "caretaker", allergies: [], drugAllergies: [], foodRestrictions: "", healthIssues: [], medications: [], healthNotes: "", draft: true, importId };
  data.sex = await resolveCamperSex({ name: data.name, bedroomId: null, requested: null, guessIfMissing: true });
  const staff = await insertStaff(data);
  await ensureLoginAccount(staff.name, normalized, "staff");
  return staff;
}

export function camperDataFromPreview(row: Record<string, unknown>, importId: string): CamperData | null {
  if (row.blocked === true || !row.name || !row.birthDate) return null;
  return {
    name: String(row.name), birthDate: String(row.birthDate), sex: (row.sex as CamperSex | null) ?? null,
    cpf: String(row.cpf ?? ""), rg: String(row.rg ?? ""), school: String(row.school ?? ""), schoolGrade: String(row.schoolGrade ?? ""), church: String(row.church ?? ""), invitedBy: String(row.invitedBy ?? ""),
    caretakerId: (row.caretakerId as string | null) ?? null, qrToken: "", externalId: "", team: (row.team as string | null) ?? null, transportation: (row.transportation as string | null) ?? null, bed: (row.bed as string | null) ?? null, bedroom: (row.bedroom as string | null) ?? null,
    weightKg: typeof row.weightKg === "number" ? row.weightKg : null, allergies: (row.allergies as string[]) ?? [], drugAllergies: (row.drugAllergies as string[]) ?? [], healthIssues: (row.healthIssues as string[]) ?? [], neurodivergent: row.neurodivergent === true, medications: [],
    foodRestrictions: String(row.foodRestrictions ?? ""), healthNotes: String(row.healthNotes ?? ""), generalNotes: String(row.generalNotes ?? ""), bedroomPreference: String(row.bedroomPreference ?? ""), insurance: String(row.insurance ?? ""), insuranceCard: String(row.insuranceCard ?? ""), emergencyContact: String(row.emergencyContact ?? ""),
    guardianName: String(row.guardianName ?? ""), guardianPhone: (row.guardianPhone as string | null) ?? null, guardianCpf: String(row.guardianCpf ?? ""), guardianEmail: String(row.guardianEmail ?? ""),
    importId, aiReviewStatus: "pending", aiReviewError: "", aiReviewStartedAt: null, aiReviewFinishedAt: null,
  };
}

export async function publishImportDrafts(importId: string): Promise<void> {
  const db = await getDb();
  const now = new Date();
  await Promise.all([
    db.collection("bedrooms").updateMany({ importId, draft: true }, { $set: { draft: false, updatedAt: now } }),
    db.collection("transports").updateMany({ importId, draft: true }, { $set: { draft: false, updatedAt: now } }),
    db.collection("teams").updateMany({ importId, draft: true }, { $set: { draft: false, updatedAt: now } }),
    db.collection("staff").updateMany({ importId, draft: true }, { $set: { draft: false, updatedAt: now } }),
    db.collection("categories").updateMany({ "options.importId": importId }, { $set: { "options.$[option].draft": false, updatedAt: now } }, { arrayFilters: [{ "option.importId": importId }] }),
  ]);
}

export async function insertImportCampers(rows: Record<string, unknown>[], importId: string): Promise<{ inserted: number; skipped: Record<string, unknown>[] }> {
  let inserted = 0;
  const skipped: Record<string, unknown>[] = [];
  const rooms = await listBedrooms({ includeDraft: true });
  for (const row of rows) {
    const data = camperDataFromPreview(row, importId);
    if (!data) { skipped.push({ row: row.row, name: row.name, reason: "Campos obrigatórios não revisados" }); continue; }
    const room = data.bedroom ? rooms.find((b) => b._id === data.bedroom) : null;
    if (room && bedroomCapacity(room) <= 0) { skipped.push({ row: row.row, name: row.name, reason: "Quarto sem camas" }); continue; }
    if (room?.group === "girls") data.sex = "F";
    else if (room?.group === "boys") data.sex = "M";
    const camper = await insertCamper(data);
    if (camper.guardianPhone) await ensureLoginAccount(camper.guardianName || camper.name, camper.guardianPhone, "parent");
    inserted++;
  }
  return { inserted, skipped };
}
