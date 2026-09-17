import { describe, expect, test } from "bun:test";
import { applyStaffCategoryChoices, applyStaffDelta, directStaffField, normalizeStaffFreeText, parseStaffImportSex, staffDataFromPreview } from "./staffImport";
import type { StaffImportReviewItem } from "../types";

const item = (patch: Partial<StaffImportReviewItem>): StaffImportReviewItem => ({ id:"r1",row:2,kind:"phone",field:"phone",memberName:"Ana",original:"",value:"",skip:false,resolved:false,...patch });

describe("staff import review delta",()=>{
  test("skipping an invalid phone still imports a staff member without login",()=>{
    const [row]=applyStaffDelta([{row:2,name:"Ana",phone:null}], [item({})], {r1:{skip:true}});
    expect(row.phone).toBeNull();
    expect(staffDataFromPreview(row,"import-1").aiReviewStatus).toBe("pending");
  });
  test("different people never keep a conflicting phone",()=>{
    const [row]=applyStaffDelta([{row:2,name:"Ana",phone:"+5561999999999",existingStaffId:"old"}], [item({kind:"duplicate",existingId:"old"})], {r1:{value:"insert"}});
    expect(row.existingStaffId).toBeNull();
    expect(row.phone).toBeNull();
  });
  test("admin-safe preview data defaults to helper-compatible values",()=>{
    const data=staffDataFromPreview({name:"Ana",phone:null,active:true,roomRole:"helper",team:null},"import-1",true);
    expect(data.draft).toBe(true);
    expect(data.roomRole).toBe("helper");
    expect(data.aiReviewStatus).toBeNull();
  });
  test("spreadsheet sex is persisted only as probable gender",()=>{
    const data=staffDataFromPreview({name:"Ana",sex:null,probableGender:"F"},"import-1");
    expect(data.sex).toBeNull();
    expect(data.probableGender).toBe("F");
  });
  test("parses only explicit staff sex values",()=>{
    expect(parseStaffImportSex("Feminino")).toBe("F");
    expect(parseStaffImportSex("menina")).toBe("F");
    expect(parseStaffImportSex("MASCULINO")).toBe("M");
    expect(parseStaffImportSex("João")).toBeNull();
    expect(parseStaffImportSex("provavelmente F")).toBeNull();
  });
  test("keeps imported free text untouched for the background AI pass",()=>{
    expect(normalizeStaffFreeText(" Marcela/11999488182 ")).toBe("Marcela/11999488182");
    expect(normalizeStaffFreeText("Bruna 11 984989876 André 11964762460")).toBe("Bruna 11 984989876 André 11964762460");
  });
  test("declined staff category options move their raw wording to observations",()=>{
    const [row]=applyStaffCategoryChoices([{name:"Ana",allergies:["a","keep"],drugAllergies:["d"],healthIssues:[],healthNotes:"Já existia.",categoryNotesById:{a:["Alergias informadas: castanha."],d:["Alergias a medicamentos informadas: dipirona."]}}],["a","d"]);
    expect(row.allergies).toEqual(["keep"]);
    expect(row.drugAllergies).toEqual([]);
    expect(row.healthNotes).toBe("Já existia. Alergias informadas: castanha. Alergias a medicamentos informadas: dipirona.");
  });
  test("staff duplicate choices use the phone-matched registry",()=>{
    const duplicate=item({kind:"duplicate",existingId:"old",existingData:{name:"Ana",phone:"+5511999999999",healthNotes:"Atual"},incomingData:{name:"Ana Nova",phone:"+5511999999999",healthNotes:"Planilha"},mergedData:{name:"Ana Nova",phone:"+5511999999999",healthNotes:"Planilha"},mergeAvailable:true});
    expect(applyStaffDelta([{row:2,name:"Ana Nova",phone:"+5511999999999",blocked:true}],[duplicate],{r1:{value:"keep"}})[0]?.skipReason).toBe("Cadastro existente mantido");
    const updated=applyStaffDelta([{row:2,name:"Ana Nova",phone:"+5511999999999",blocked:true}],[duplicate],{r1:{value:"update"}})[0];
    expect(updated.existingStaffId).toBe("old");expect(updated.blocked).toBe(false);
    const merged=applyStaffDelta([{row:2,name:"Ana Nova",phone:"+5511999999999",blocked:true}],[duplicate],{r1:{value:"merge"}})[0];
    expect(merged.existingStaffId).toBe("old");expect(merged.healthNotes).toBe("Planilha");
  });
  test("maps adversarial staff headers deterministically",()=>{
    expect(directStaffField("Quem vai servir?")?.key).toBe("name");
    expect(directStaffField("Qual alojamento?")?.key).toBe("bedroom");
    expect(directStaffField("Remédio que dá alergia")?.key).toBe("drugAllergies");
    expect(directStaffField("Está participando?")?.key).toBe("active");
    expect(directStaffField("Gênero")?.key).toBe("probableGender");
    expect(directStaffField("Alergias (alimentar, tópica ou de medicamentos)")?.key).toBe("healthNotes");
  });
  test("never leaves the same imported phone on two rows",()=>{
    const rows=applyStaffDelta([{row:2,name:"Ana",phone:"+5511999999999"},{row:3,name:"Bia",phone:"+5511999999999"}],[],{});
    expect(rows.map((row)=>row.phone)).toEqual(["+5511999999999",null]);
  });
  test("review delta cannot turn an admin roster row into a leader or team member",()=>{
    const [row]=applyStaffDelta([{row:2,name:"Admin",adminProtected:true,roomRole:"helper",team:null}], [item({kind:"roomRole",value:"helper"})], {r1:{value:"caretaker"}});
    expect(row.roomRole).toBe("helper");
    expect(row.team).toBeNull();
  });
});
