import { describe, expect, test } from "bun:test";
import { camperMatchKey, normalizeKey, remapLink, settingsToImport, staffMatchKey, stripForCopy, type SettingsRemap } from "./campImport";
import { DEFAULT_SETTINGS } from "../models/settings";
import type { Settings } from "../types";

describe("normalizeKey", () => {
  test("is accent and case insensitive", () => {
    expect(normalizeKey("Ana Lúcia")).toBe(normalizeKey("ana lucia"));
    expect(normalizeKey("JOÃO")).toBe(normalizeKey("joão"));
  });
});

describe("camperMatchKey", () => {
  test("matches by name + birth date when both are known", () => {
    const key = camperMatchKey({ name: "Ana Lúcia", birthDate: "2012-05-01" });
    expect(key).toBe(camperMatchKey({ name: "ana lucia", birthDate: "2012-05-01" }));
  });
  test("falls back to cpf when there is no birth date", () => {
    expect(camperMatchKey({ name: "Ana", birthDate: null, cpf: "111.222.333-44" })).toBe("cpf:11122233344");
  });
  test("falls back to externalId when there is neither birth date nor cpf", () => {
    expect(camperMatchKey({ name: "Ana", birthDate: null, externalId: "ext-1" })).toBe("ext:ext-1");
  });
  test("null when nothing identifies the camper", () => {
    expect(camperMatchKey({ name: "", birthDate: null })).toBeNull();
  });
});

describe("staffMatchKey", () => {
  test("matches by phone when known", () => {
    expect(staffMatchKey({ name: "Ana", phone: "+5511999999999" })).toBe("phone:5511999999999");
  });
  test("falls back to normalized name when there is no phone", () => {
    expect(staffMatchKey({ name: "Ana Lúcia", phone: null })).toBe(`name:${normalizeKey("Ana Lucia")}`);
  });
  test("null when neither identifies the person", () => {
    expect(staffMatchKey({ name: "", phone: null })).toBeNull();
  });
});

describe("remapLink", () => {
  test("prefers the idMap over the soft match", () => {
    const idMap = new Map([["old1", "fromMap"]]);
    const soft = new Map([["old1", "fromSoft"]]);
    expect(remapLink("old1", idMap, soft)).toBe("fromMap");
  });
  test("falls back to the soft match when the idMap misses", () => {
    const idMap = new Map<string, string>();
    const soft = new Map([["old1", "fromSoft"]]);
    expect(remapLink("old1", idMap, soft)).toBe("fromSoft");
  });
  test("null when neither has it, or the input is null", () => {
    expect(remapLink("old1", new Map(), new Map())).toBeNull();
    expect(remapLink(null, new Map(), new Map())).toBeNull();
  });
});

describe("stripForCopy", () => {
  test("never leaks _id, campId, importId or aiReview* fields", () => {
    const doc = {
      _id: "abc",
      campId: "camp1",
      createdAt: new Date(),
      updatedAt: new Date(),
      importId: "import-1",
      aiReviewStatus: "reviewed",
      aiReviewError: "",
      name: "Ana",
    };
    const out = stripForCopy(doc);
    expect(out).not.toHaveProperty("_id");
    expect(out).not.toHaveProperty("campId");
    expect(out).not.toHaveProperty("importId");
    expect(out).not.toHaveProperty("aiReviewStatus");
    expect(out).not.toHaveProperty("aiReviewError");
    expect(out.name).toBe("Ana");
  });
  test("never leaks check-in fields when they are named in extraStrip", () => {
    const doc = { checkin: { at: new Date() }, busCheckin: null, vest: { delivered: null, returned: null }, name: "Ana" };
    const out = stripForCopy(doc, ["checkin", "busCheckin", "vest"]);
    expect(out).not.toHaveProperty("checkin");
    expect(out).not.toHaveProperty("busCheckin");
    expect(out).not.toHaveProperty("vest");
    expect(out.name).toBe("Ana");
  });
});

describe("settingsToImport", () => {
  const remap: SettingsRemap = {
    staff: (id) => (id === "known" ? "known-new" : null),
    vehicle: (id) => (id === "vehicle-known" ? "vehicle-new" : null),
  };

  test("drops staff ids that don't remap", () => {
    const source: Settings = { ...DEFAULT_SETTINGS, organizers: { staffIds: ["known", "unknown"] } };
    expect(settingsToImport(source, remap).organizers).toEqual({ staffIds: ["known-new"] });
  });
  test("drops bus helpers whose staff or vehicle didn't remap", () => {
    const source: Settings = { ...DEFAULT_SETTINGS, busHelpers: { helpers: [{ staffId: "known", vehicleId: "vehicle-known" }, { staffId: "known", vehicleId: "unknown" }, { staffId: "unknown", vehicleId: "vehicle-known" }] } };
    expect(settingsToImport(source, remap).busHelpers).toEqual({ helpers: [{ staffId: "known-new", vehicleId: "vehicle-new" }] });
  });
  test("drops parent contacts whose staff didn't remap", () => {
    const source: Settings = { ...DEFAULT_SETTINGS, parentContacts: [{ id: "c1", title: "Coordenação", staffId: "known" }, { id: "c2", title: "Outro", staffId: "unknown" }] };
    expect(settingsToImport(source, remap).parentContacts).toEqual([{ id: "c1", title: "Coordenação", staffId: "known-new" }]);
  });
  test("never copies windows, drafts, wizardMode or galleryPublished", () => {
    const source: Settings = { ...DEFAULT_SETTINGS, wizardMode: true, galleryPublished: true, kidsRoomsDraft: true, scoreDraft: true };
    const out = settingsToImport(source, remap);
    expect(out).not.toHaveProperty("wizardMode");
    expect(out).not.toHaveProperty("galleryPublished");
    expect(out).not.toHaveProperty("kidsRoomsDraft");
    expect(out).not.toHaveProperty("scoreDraft");
    expect(out).not.toHaveProperty("checkinWindow");
    expect(out).not.toHaveProperty("busReturnWindow");
    expect(out).not.toHaveProperty("staffAccessWindow");
    expect(out).not.toHaveProperty("parentAccessWindow");
    expect(out).not.toHaveProperty("scoreHideWindow");
    expect(out).not.toHaveProperty("checkinReminder");
  });
  test("keeps checkinLocations, notifications and smsRedirect verbatim", () => {
    const out = settingsToImport(DEFAULT_SETTINGS, remap);
    expect(out.checkinLocations).toEqual(DEFAULT_SETTINGS.checkinLocations);
    expect(out.notifications).toEqual(DEFAULT_SETTINGS.notifications);
    expect(out.smsRedirect).toEqual(DEFAULT_SETTINGS.smsRedirect);
  });
});
