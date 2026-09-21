import { describe, expect, test } from "bun:test";
import { config } from "../config";
import { adminInviteEmail, birthdayEmail, busCheckinEmail, checkinEmail, enrolHero, occurrenceEmail, parentEditEmail, parentWelcomeEmail, rewriteDocHtml, sampleNotificationEmails, staffWelcomeEmail, wrapEmail } from "./emails";

describe("notification emails", () => {
  test("wraps the camp look with a CTA and no underline", () => {
    const mail = wrapEmail({
      subject: "Teste",
      title: "Olá",
      icon: "parent",
      bodyHtml: "<p>corpo</p>",
      cta: { href: "https://example.com", label: "Abrir o app" },
    });
    expect(mail.subject).toBe("Teste");
    expect(mail.html).toContain("#183d36");
    expect(mail.html).toContain("text-decoration:none");
    expect(mail.html).toContain("Abrir o app");
    expect(mail.text).toContain("Olá");
  });

  test("rewrites relative file URLs against the public origin when set", () => {
    const html = rewriteDocHtml('<p><img src="/api/files/abc"></p>');
    if (config.publicOrigin) expect(html).toBe(`<p><img src="${config.publicOrigin}/api/files/abc"></p>`);
    else expect(html).toContain('src="/api/files/abc"');
  });

  test("parent welcome names the kids and the login phone", () => {
    const mail = parentWelcomeEmail(
      { name: "Marcela Souza", phone: "+5511999999999" },
      [{ name: "Ana Souza", sex: "F", probableGender: "F" }],
      "liberado",
    );
    expect(mail.subject).toContain("Acampa Kids");
    expect(mail.html).toContain("Ana");
    expect(mail.html).toContain("(11) 99999-9999");
  });

  test("parent welcome lists every kid", () => {
    const mail = parentWelcomeEmail(
      { name: "Marcela Souza", phone: "+5511999999999" },
      [
        { name: "Ana Souza", sex: "F", probableGender: "F" },
        { name: "Pedro Souza", sex: "M", probableGender: "M" },
      ],
      "liberado",
    );
    expect(mail.subject).toContain("crianças estão inscritas");
    expect(mail.html).toContain("Ana e Pedro estão inscritos");
    expect(mail.html).toContain("Ana Souza, Pedro Souza");
  });

  test("bus check-in includes parent contacts", () => {
    const mail = busCheckinEmail(
      { name: "Ana Souza", sex: "F", probableGender: "F", guardianName: "Marcela Souza" },
      [{ title: "Coordenação", name: "João", phone: "+5511988887777" }],
    );
    expect(mail.subject).toContain("embarcou");
    expect(mail.html).toContain("Coordenação");
    expect(mail.html).toContain("João");
  });

  test("check-in lists the kids of the room", () => {
    const mail = checkinEmail({ name: "João Silva", roomRole: "caretaker" }, { room: "103", bus: "Ônibus Azul 1", kids: [{ name: "Ana" }, { name: "Bia" }] });
    expect(mail.html).toContain("103");
    expect(mail.html).toContain("Ana");
    expect(mail.html).toContain("Bia");
  });

  test("birthday names the room team", () => {
    const mail = birthdayEmail("João", { name: "Ana Souza", sex: "F", probableGender: "F", birthDate: "2018-09-12" }, "103", "2026-09-12", ["Ana Souza", "Bia"], ["João", "Maria"]);
    expect(mail.subject).toContain("Ana");
    expect(mail.html).toContain("103");
    expect(mail.html).toContain("Maria");
  });

  test("enrol hero matches the new responsibility", () => {
    expect(enrolHero(["organizador dos jogos (programação e placar)"])).toBe("enrol-games");
    expect(enrolHero(["organizador (acesso de administração)"])).toBe("enrol-organizer");
    expect(enrolHero(["na porta do ônibus (embarque das crianças)"])).toBe("enrol-bus");
    expect(enrolHero(["equipe médica"])).toBe("enrol-medical");
    expect(enrolHero(["fotógrafo do acampamento (envia as fotos)"])).toBe("enrol-photo");
    expect(enrolHero([])).toBe("staff-enrol");
  });

  test("bus door enrol explains the door, not the ride", () => {
    const mail = staffWelcomeEmail({ name: "João Silva", phone: "+5511988887777" }, ["na porta do ônibus (embarque das crianças)"]);
    expect(mail.html).toContain("não deixá-las saírem");
    expect(mail.html).toContain("não coloca as malas");
    expect(mail.html).not.toContain("Não precisa ir nele");
  });

  test("staff welcome and enrol only show the login phone", () => {
    const welcome = staffWelcomeEmail({ name: "João Silva", phone: "+5511988887777" }, []);
    const enrol = staffWelcomeEmail({ name: "João Silva", phone: "+5511988887777" }, ["organizador (acesso de administração)"]);
    for (const mail of [welcome, enrol]) {
      expect(mail.html).toContain("(11) 98888-7777");
      expect(mail.html).not.toContain(">Quarto<");
      expect(mail.html).not.toContain(">Time<");
      expect(mail.html).not.toContain(">Transporte<");
    }
  });

  test("church check-in enrol asks to verify medical info with the parent", () => {
    const mail = staffWelcomeEmail({ name: "João Silva", phone: "+5511988887777" }, ["ajudante do check-in"]);
    expect(mail.html).toContain("informações médicas");
    expect(mail.html).not.toContain("Não entregue de volta");
  });

  test("medical enrol does not joke about corridor diagnoses", () => {
    const mail = staffWelcomeEmail({ name: "João Silva", phone: "+5511988887777" }, ["equipe médica"]);
    expect(mail.html).toContain("ficha de saúde");
    expect(mail.html).not.toContain("diagnóstico de corredor");
  });

  test("admin invite names the login phone and the wizard", () => {
    const mail = adminInviteEmail({ name: "João Silva", phone: "+5511988887777" });
    expect(mail.subject).toContain("administra");
    expect(mail.html).toContain("João");
    expect(mail.html).toContain("(11) 98888-7777");
    expect(mail.html).toContain("assistente de configuração");
  });

  test("sample catalog covers parent and staff emails", () => {
    const samples = sampleNotificationEmails();
    expect(samples.length).toBeGreaterThan(5);
    expect(samples.some((s) => s.audience === "parent")).toBe(true);
    expect(samples.some((s) => s.audience === "staff")).toBe(true);
    expect(new Set(samples.map((s) => s.id)).size).toBe(samples.length);
    for (const s of samples) {
      expect(s.subject.length).toBeGreaterThan(0);
      expect(s.html).toContain("#183d36");
    }
  });

  test("parent edit capitalizes field names and values", () => {
    const mail = parentEditEmail(
      "João",
      { name: "Ana Souza" },
      { byName: "Marcela Souza", medical: true, changes: [{ field: "allergies", before: [], after: ["amendoim"] }] },
      (id) => id,
    );
    expect(mail.html).toContain(">Alergias<");
    expect(mail.html).toContain("Amendoim");
    expect(mail.html).not.toContain(">alergias<");
  });

  test("occurrence includes the description HTML", () => {
    const mail = occurrenceEmail("Admin", {
      _id: "1",
      campers: [{ id: "k", name: "Ana Souza" }],
      staff: [],
      description: "<p>Caiu no campo</p>",
      createdByUserId: "u",
      createdByName: "Maria",
      createdByRole: "admin",
      createdAt: new Date(),
    });
    expect(mail.html).toContain("Caiu no campo");
    expect(mail.html).toContain("Ana Souza");
    expect(mail.html).not.toContain("precisa agir");
  });
});
