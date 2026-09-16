import { describe, expect, test } from "bun:test";
import { applyStaffDelta, directStaffField, staffDataFromPreview } from "./staffImport";
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
  test("preview sex is persisted on apply",()=>{
    expect(staffDataFromPreview({name:"Ana",sex:"F"},"import-1").sex).toBe("F");
    expect(staffDataFromPreview({name:"João",sex:"M"},"import-1").sex).toBe("M");
    expect(staffDataFromPreview({name:"Alex"},"import-1").sex).toBeNull();
  });
  test("maps adversarial staff headers deterministically",()=>{
    expect(directStaffField("Quem vai servir?")?.key).toBe("name");
    expect(directStaffField("Qual alojamento?")?.key).toBe("bedroom");
    expect(directStaffField("Remédio que dá alergia")?.key).toBe("drugAllergies");
    expect(directStaffField("Está participando?")?.key).toBe("active");
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
