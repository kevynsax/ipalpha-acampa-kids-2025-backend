import { randomUUID } from "node:crypto";
import { listBedrooms } from "../models/bedrooms";
import { listCategories } from "../models/categories";
import { listImportDictionary, type CamperImportColumn, type CamperImportCreatedItem } from "../models/camperImports";
import { insertStaff, listStaff, updateStaff, type StaffData } from "../models/staff";
import { listTeams } from "../models/teams";
import { listTransports } from "../models/transports";
import { ensureLoginAccount, listAdmins } from "../models/users";
import { STAFF_CATEGORY_KEYS, type CamperImportDictionaryEntry, type CamperSex, type Staff, type StaffImportReviewItem } from "../types";
import { titleCaseName } from "../utils";
import { resolveCamperSex } from "./camperSex";
import { dedupeImportValues, guessIndividualNamesSex, mapImportColumns } from "./importAi";
import { concatOtherColumns, deterministicLeader, importPhone, isEmptyCategoryValue, normalizeImportValue, parseSpreadsheet, resolveBedroom, resolveCategoryValues, resolveTeam, resolveTransport, sourceMap, valueOf, type ImportLookups } from "./camperImport";

export const STAFF_IMPORT_FIELDS = [
  { key: "name", label: "Nome", aliases: ["nome completo", "quem vai servir", "voluntario", "voluntário", "tio", "tia"], required: true },
  { key: "phone", label: "Celular", aliases: ["telefone", "fone", "whatsapp", "celular whatsapp", "contato pra entrar"] },
  { key: "active", label: "Ativo", aliases: ["ativa", "status", "ativo", "está participando", "esta participando"] },
  { key: "roomRole", label: "Função no quarto", aliases: ["lider", "líder", "tio lider", "checkin leader", "lider_checkin", "cuida do quarto"] },
  { key: "team", label: "Time", aliases: ["equipe", "team", "time_name", "cor da galera"] },
  { key: "bedroom", label: "Quarto", aliases: ["room", "room_name", "dormitorio", "alojamento", "qual alojamento"] },
  { key: "transportation", label: "Transporte", aliases: ["onibus", "ônibus", "bus", "bus_name", "veiculo", "como chega"] },
  { key: "allergies", label: "Alergias", aliases: ["alergia", "alergia restricao", "reações do corpo", "reacoes do corpo"] },
  { key: "drugAllergies", label: "Alergia a medicamentos", aliases: ["alergia medicamentos", "alergia-medicamentos", "remedio que da alergia", "remédio que dá alergia"] },
  { key: "healthIssues", label: "Condições crônicas", aliases: ["condicao cronica", "problema de saude", "tem algum problema de saúde", "tem algum problema de saude", "diagnóstico contínuo", "diagnostico continuo", "doenca"] },
  { key: "foodRestrictions", label: "Restrição alimentar", aliases: ["restricao alimentar", "alimentacao", "o que não come", "o que nao come"] },
  { key: "dailyMedication", label: "Medicação de uso diário", aliases: ["medicacao", "remedio diario", "remédios todo dia", "remedios todo dia"] },
  { key: "healthNotes", label: "Observações de saúde", aliases: ["observacoes", "observação", "problema de saúde", "recado médico", "recado medico", "alergias alimentar tópica ou de medicamentos", "alergias alimentar topica ou de medicamentos"] },
] as const;
type Field = (typeof STAFF_IMPORT_FIELDS)[number]["key"];

const compact = (s: string) => normalizeImportValue(s).replace(/\s/g, "");
const STAFF_EXTRA_COLUMNS = ["rg", "cpf", "idade", "data de nascimento", "nascimento", "email", "e mail", "created at", "criado em", "colete", "pode trocar time", "pode gerenciar colete"];
const isKnownExtra = (header: string) => {
  const normalized = normalizeImportValue(header);
  return STAFF_EXTRA_COLUMNS.some((extra) => normalized === extra || normalized.startsWith(`${extra} `));
};
export function directStaffField(header: string): { key: Field; confidence: number } | null {
  const h = normalizeImportValue(header); let best: { key: Field; confidence: number; specificity: number } | null = null, bestConfidence=0, bestSpecificity=0;
  for (const f of STAFF_IMPORT_FIELDS) for (const alias of [f.label, ...f.aliases]) {
    const a = normalizeImportValue(alias), specificity = a.split(" ").filter(Boolean).length * 100 + a.length;
    const contains = (longer:string,shorter:string)=>` ${longer} `.includes(` ${shorter} `);
    const confidence = h === a ? 1 : compact(h) === compact(a) ? .97 : contains(h,a)&&a.split(" ").length>=2 ? .86 : contains(a,h)&&h.split(" ").length>=2 ? .83 : 0;
    if (confidence>bestConfidence||(confidence===bestConfidence&&specificity>bestSpecificity)){best={key:f.key,confidence,specificity};bestConfidence=confidence;bestSpecificity=specificity;}
  }
  return best && best.confidence >= .82 ? {key:best.key,confidence:best.confidence} : null;
}
const direct = directStaffField;

export async function mapStaffColumns(columns: { name: string; samples: string[] }[], override: Record<string, string | null> = {}, signal?: AbortSignal): Promise<CamperImportColumn[]> {
  const saved = new Map((await listImportDictionary()).filter((d) => d.kind === "column" && d.field.startsWith("staff-column:")).map((d) => [d.normalized, typeof d.value === "string" ? d.value : null]));
  const unresolved = columns.filter((c) => override[c.name] === undefined && !isKnownExtra(c.name) && !direct(c.name) && !saved.has(normalizeImportValue(c.name)));
  const ai = unresolved.length ? await mapImportColumns(unresolved, STAFF_IMPORT_FIELDS.map((f) => ({ key: f.key, label: f.label, aliases: [...f.aliases], required: "required" in f })), signal) : {};
  const used = new Set<string>();
  return columns.map((c) => { const d = direct(c.name); const ignored = isKnownExtra(c.name); const wanted = ignored ? null : override[c.name] !== undefined ? override[c.name] : d?.key ?? saved.get(normalizeImportValue(c.name)) ?? ai[c.name]?.target ?? null; const target = wanted && STAFF_IMPORT_FIELDS.some((f) => f.key === wanted) && !used.has(wanted) ? wanted : null; if (target) used.add(target); return { source: c.name, target, confidence: ignored ? 1 : override[c.name] !== undefined ? 1 : d?.confidence ?? ai[c.name]?.confidence ?? 0, samples: c.samples }; });
}

const bool = (raw: string, fallback: boolean) => { const n = normalizeImportValue(raw); if (!n) return fallback; if (["sim", "s", "true", "1", "ativo", "lider", "líder"].includes(n)) return true; if (["nao", "não", "n", "false", "0", "inativo", "auxiliar"].includes(n)) return false; return fallback; };
const review = (kind: StaffImportReviewItem["kind"], row: number, memberName: string, original: string, extra: Partial<StaffImportReviewItem> = {}): StaffImportReviewItem => ({ id: randomUUID(), row, kind, field: kind, memberName, original, value: "", skip: false, resolved: false, ...extra });
function nameCandidates(raw: string, staff: Staff[]) { return deterministicLeader(raw, staff); }

export interface StaffImportAnalysis { columns: CamperImportColumn[]; dictionaries: CamperImportDictionaryEntry[]; reviews: StaffImportReviewItem[]; preview: Record<string, unknown>[]; skipped: Record<string, unknown>[]; createdItems: CamperImportCreatedItem[]; status: "needs_mapping" | "review" | "ready"; panicMessage: string; }

export async function analyzeStaffImport(input: { data: Uint8Array; fileName: string; importId: string; mapping?: Record<string, string | null>; mapOnly?: boolean; signal?: AbortSignal }): Promise<StaffImportAnalysis> {
  const parsed = parseSpreadsheet(input.data, input.fileName);
  const columns = await mapStaffColumns(parsed.columns, input.mapping, input.signal); const sources = sourceMap(columns);
  if (!sources.has("name")) return { columns, dictionaries: [], reviews: [], preview: [], skipped: [], createdItems: [], status: "needs_mapping", panicMessage: "Escolha a coluna de Nome." };
  if (input.mapOnly) return { columns, dictionaries: [], reviews: [], preview: [], skipped: [], createdItems: [], status: "needs_mapping", panicMessage: "" };
  const [bedrooms, transports, teams, rawCategories, staff, previous, admins] = await Promise.all([listBedrooms(), listTransports(), listTeams(), listCategories(), listStaff({ includeDraft: true }), listImportDictionary(), listAdmins()]);
  const categories = rawCategories.map((c) => ({ ...c, options: c.options.filter((o) => !o.draft) })); const lookups: ImportLookups = { bedrooms, transports, teams, categories, staff };
  const createdItems: CamperImportCreatedItem[] = [], dictionaries: CamperImportDictionaryEntry[] = [], reviews: StaffImportReviewItem[] = [], preview: Record<string, unknown>[] = [];
  const fields = ["bedroom", "team", "transportation", "allergies", "drugAllergies", "healthIssues"] as const;
  const grouped = Object.fromEntries(fields.map((f) => [f, [...new Set(parsed.rows.map((r) => valueOf(r, sources, f)).filter(Boolean))]])) as Record<(typeof fields)[number], string[]>;
  const prior = new Map(previous.map((d) => [`${d.field}:${d.normalized}`, d]));
  const dedupPairs = await Promise.all(fields.map(async (f) => { const known: Record<string,string> = {}, unknown: string[] = []; for (const raw of grouped[f]) { const old = prior.get(`${f}:${normalizeImportValue(raw)}`); old ? known[raw] = old.label || raw : unknown.push(raw); } return [f, { ...known, ...(await dedupeImportValues(f, unknown, input.signal)) }] as const; }));
  const deduped = Object.fromEntries(dedupPairs) as Record<string, Record<string,string>>; const resolution = new Map<string, string | null>();
  const unique = (f: typeof fields[number]) => [...new Set(grouped[f].map((r) => String(deduped[f]?.[r] ?? r)))];
  const namesByRoom = new Map<string,string[]>(); for (const row of parsed.rows) { const raw = valueOf(row,sources,"bedroom"); if (raw) { const c = String(deduped.bedroom?.[raw] ?? raw); namesByRoom.set(c,[...(namesByRoom.get(c)??[]),valueOf(row,sources,"name")]); } }
  const tasks: Promise<void>[] = [];
  for (const f of fields) for (const raw of grouped[f]) { const old = prior.get(`${f}:${normalizeImportValue(raw)}`); if (typeof old?.value === "string") resolution.set(`${f}:${String(deduped[f]?.[raw] ?? raw)}`, old.value); }
  for (const v of unique("transportation")) if (!resolution.has(`transportation:${v}`)) tasks.push(resolveTransport(v,lookups,createdItems,input.importId,input.signal).then((x)=>void resolution.set(`transportation:${v}`,x)));
  for (const v of unique("team")) if (!resolution.has(`team:${v}`)) tasks.push(resolveTeam(v,lookups,createdItems,input.importId,input.signal).then((x)=>void resolution.set(`team:${v}`,x)));
  for (const v of unique("bedroom")) if (!resolution.has(`bedroom:${v}`)) tasks.push(resolveBedroom(v,namesByRoom.get(v)??[],lookups,createdItems,input.importId,input.signal).then((x)=>void resolution.set(`bedroom:${v}`,x)));
  for (const f of ["allergies","drugAllergies","healthIssues"] as const) tasks.push((async()=>{ const values=unique(f).filter((v)=>!resolution.has(`${f}:${v}`)); const resolved=await resolveCategoryValues(f,values,lookups,createdItems,input.importId,input.signal); for(const [value,id] of resolved) resolution.set(`${f}:${value}`,id); })());
  const guesses = new Map<string,CamperSex>();
  tasks.push((async()=>{ const names=[...new Set(parsed.rows.map((r)=>valueOf(r,sources,"name").split(" ")[0]).filter(Boolean))]; const chunks=Array.from({length:Math.ceil(names.length/50)},(_,i)=>names.slice(i*50,i*50+50)); const answers=await Promise.all(chunks.map((chunk)=>guessIndividualNamesSex(chunk,input.signal))); for(const answer of answers) for(const [name,sex] of Object.entries(answer)) if(sex) guesses.set(normalizeImportValue(name),sex); })());
  await Promise.all(tasks);
  for (const f of fields) for (const raw of grouped[f]) { const canonical=String(deduped[f]?.[raw]??raw), value=resolution.get(`${f}:${canonical}`)??null; dictionaries.push({ field:f,raw,normalized:normalizeImportValue(raw),value,label:canonical,draft:true,kind:(["bedroom","team","transportation"].includes(f)?f:"category") as CamperImportDictionaryEntry["kind"] }); }
  for (const c of columns) dictionaries.push({ field:`staff-column:${normalizeImportValue(c.source)}`,raw:c.source,normalized:normalizeImportValue(c.source),value:c.target,label:c.target??"Ignorar",draft:true,kind:"column" });
  const get=(f:string,raw:string)=>dictionaries.find((d)=>d.field===f&&d.normalized===normalizeImportValue(raw))?.value as string|null|undefined; const mapped=new Set(columns.filter((c)=>c.target).map((c)=>c.source));
  const phoneRows=new Map<string,number[]>();
  for(let i=0;i<parsed.rows.length;i++){const phone=importPhone(valueOf(parsed.rows[i],sources,"phone"));if(phone)phoneRows.set(phone,[...(phoneRows.get(phone)??[]),i+2]);}
  const adminPhones=new Set(admins.map((admin)=>admin.phone));
  for (let i=0;i<parsed.rows.length;i++) { const row=parsed.rows[i], line=i+2, name=titleCaseName(valueOf(row,sources,"name")); if(!name) continue; const rawPhone=valueOf(row,sources,"phone"), phone=importPhone(rawPhone); const phoneMatch=phone?staff.find((s)=>s.phone===phone):null; const nm=nameCandidates(name,staff); let existing=phoneMatch ?? (nm.id?staff.find((s)=>s._id===nm.id)??null:null); const phoneConflict=!!phoneMatch&&compact(phoneMatch.name)!==compact(name)&&!nameCandidates(name,[phoneMatch]).id; const repeatedLines=phone?phoneRows.get(phone)??[]:[]; const ambiguous=phoneConflict || repeatedLines.length>1 || (!phoneMatch&&nm.options.length>1);
    if(!phone) reviews.push(review("phone",line,name,rawPhone,{context:[valueOf(row,sources,"team"),valueOf(row,sources,"bedroom")].filter(Boolean).join(" · ")}));
    if(ambiguous) { reviews.push(review("duplicate",line,name,rawPhone,{context:repeatedLines.length>1?`Celular repetido nas linhas ${repeatedLines.join(", ")}.`:undefined,existingId:phoneMatch?._id,existingName:phoneMatch?.name,existingPhone:phoneMatch?.phone,options:nm.options.map((s)=>({id:s._id,label:`${s.name}${s.phone?` · ${s.phone}`:""}`}))})); existing=null; }
    const bedroomRaw=valueOf(row,sources,"bedroom"), bedroom=bedroomRaw?get("bedroom",bedroomRaw)??null:null; const room=bedroom?bedrooms.find((b)=>b._id===bedroom):null; const sex:CamperSex|null=room?.group==="girls"?"F":room?.group==="boys"?"M":guesses.get(normalizeImportValue(name.split(" ")[0]))??null; if(!bedroom) reviews.push(review("bedroom",line,name,"",{context:[phone,valueOf(row,sources,"team"),valueOf(row,sources,"transportation")].filter(Boolean).join(" · ")}));
    const adminProtected=!!((phone&&adminPhones.has(phone))||(existing?.phone&&adminPhones.has(existing.phone))); const roleRaw=valueOf(row,sources,"roomRole"), roomRole=adminProtected?"helper":bool(roleRaw,false)?"caretaker":"helper"; if(roleRaw||adminProtected) reviews.push(review("roomRole",line,name,roleRaw,{value:roomRole,resolved:true,context:adminProtected?"Administrador mantido ativo, como auxiliar e sem time.":undefined})); const activeRaw=valueOf(row,sources,"active"), active=adminProtected?true:bool(activeRaw,true); if(activeRaw&&!active) reviews.push(review("inactive",line,name,activeRaw,{value:"false",resolved:true}));
    const categoryNote=(field:"allergies"|"drugAllergies"|"healthIssues",label:string)=>{const raw=valueOf(row,sources,field);return raw&&!isEmptyCategoryValue(raw)&&!get(field,raw)?`${label}: ${raw}.`:"";};
    const notes=[valueOf(row,sources,"healthNotes"),valueOf(row,sources,"dailyMedication")&&`Medicação de uso diário: ${valueOf(row,sources,"dailyMedication")}.`,valueOf(row,sources,"foodRestrictions")&&`Restrição alimentar: ${valueOf(row,sources,"foodRestrictions")}.`,categoryNote("allergies","Alergias informadas"),categoryNote("drugAllergies","Alergias a medicamentos informadas"),categoryNote("healthIssues","Condições de saúde informadas"),concatOtherColumns(row,mapped)].filter(Boolean).join(" ").trim();
    preview.push({row:line,name,phone:adminProtected&&existing?.phone?existing.phone:phone,active,roomRole,team:adminProtected?null:valueOf(row,sources,"team")?get("team",valueOf(row,sources,"team"))??null:null,bedroom,transportation:valueOf(row,sources,"transportation")?get("transportation",valueOf(row,sources,"transportation"))??null:null,sex,allergies:valueOf(row,sources,"allergies")&&get("allergies",valueOf(row,sources,"allergies"))?[get("allergies",valueOf(row,sources,"allergies"))]:[],drugAllergies:valueOf(row,sources,"drugAllergies")&&get("drugAllergies",valueOf(row,sources,"drugAllergies"))?[get("drugAllergies",valueOf(row,sources,"drugAllergies"))]:[],healthIssues:valueOf(row,sources,"healthIssues")&&get("healthIssues",valueOf(row,sources,"healthIssues"))?[get("healthIssues",valueOf(row,sources,"healthIssues"))]:[],foodRestrictions:valueOf(row,sources,"foodRestrictions"),medications:[],healthNotes:notes,existingStaffId:existing?._id??null,adminProtected,blocked:false});
  }
  return {columns,dictionaries,reviews,preview,skipped:[],createdItems,status:reviews.length?"review":"ready",panicMessage:""};
}

export function applyStaffDelta(preview: Record<string,unknown>[], reviews: StaffImportReviewItem[], delta: Record<string,{value?:string;skip?:boolean}>): Record<string,unknown>[] { const rows=preview.map((r)=>({...r})); for(const item of reviews){const d=delta[item.id]??{}, row=rows.find((r)=>Number(r.row)===item.row); if(!row)continue; const value=d.value??item.value; if(item.kind==="phone") row.phone=d.skip?null:importPhone(value); else if(item.kind==="bedroom") row.bedroom=d.skip?null:value||null; else if(item.kind==="roomRole") row.roomRole=value==="caretaker"?"caretaker":"helper"; else if(item.kind==="inactive") row.active=value!=="false"; else if(item.kind==="duplicate"){ if(d.skip) row.blocked=true; else if(value==="insert"){row.existingStaffId=null;row.phone=null;} else if(value) row.existingStaffId=value; } }
  const claimed=new Set<string>();
  for(const row of rows){if(row.adminProtected){row.roomRole="helper";row.team=null;}const phone=typeof row.phone==="string"?row.phone:"";if(phone&&claimed.has(phone))row.phone=null;else if(phone)claimed.add(phone);}
  return rows;
}

export function staffDataFromPreview(row:Record<string,unknown>,importId:string,draft=false):StaffData { return {name:String(row.name),phone:(row.phone as string|null)??null,active:row.active!==false,roomRole:row.roomRole==="caretaker"?"caretaker":"helper",team:(row.team as string|null)??null,bedroom:(row.bedroom as string|null)??null,transportation:(row.transportation as string|null)??null,sex:(row.sex as CamperSex|null)??null,allergies:(row.allergies as string[])??[],drugAllergies:(row.drugAllergies as string[])??[],healthIssues:(row.healthIssues as string[])??[],foodRestrictions:String(row.foodRestrictions??""),medications:[],healthNotes:String(row.healthNotes??""),draft,importId,aiReviewStatus:draft?null:"pending",aiReviewError:"",aiReviewStartedAt:null,aiReviewFinishedAt:null}; }
export async function insertImportStaff(rows: Record<string,unknown>[], importId:string): Promise<{inserted:number;updated:number;loginsCreated:number;eligiblePhones:number;skipped:Record<string,unknown>[]}> { let inserted=0,updated=0,loginsCreated=0,eligiblePhones=0; const skipped:Record<string,unknown>[]=[], [all,admins]=await Promise.all([listStaff({includeDraft:true}),listAdmins()]); const usedPhones=new Set(all.map((s)=>s.phone).filter((phone):phone is string=>!!phone)); const adminPhones=new Set(admins.map((admin)=>admin.phone)); for(const row of rows){ if(row.blocked||!row.name){skipped.push({row:row.row,name:row.name,reason:"Revisão ignorada"});continue;} const data=staffDataFromPreview(row,importId); const id=typeof row.existingStaffId==="string"?row.existingStaffId:""; const old=id?all.find((s)=>s._id===id):null; const adminProtected=!!(old?.phone&&adminPhones.has(old.phone))||!!(data.phone&&adminPhones.has(data.phone)); if(adminProtected){data.phone=old?.phone??data.phone;data.active=true;data.roomRole="helper";data.team=null;} if(data.phone&&usedPhones.has(data.phone)&&old?.phone!==data.phone){skipped.push({row:row.row,name:row.name,reason:"Celular repetido; inserido sem login"});data.phone=null;} data.sex=await resolveCamperSex({name:data.name,bedroomId:data.bedroom,requested:data.sex,guessIfMissing:data.sex!=="F"&&data.sex!=="M"}); if(id){await updateStaff(id,data);updated++;} else {await insertStaff(data);inserted++;} if(data.phone){usedPhones.add(data.phone);eligiblePhones++;const x=await ensureLoginAccount(data.name,data.phone,"staff");if(x.created)loginsCreated++;} } return {inserted,updated,loginsCreated,eligiblePhones,skipped}; }
