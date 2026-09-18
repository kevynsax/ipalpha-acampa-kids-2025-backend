import { describe, expect, test } from "bun:test";
import { birthdayEmail, busCheckinEmail, checkinEmail, occurrenceEmail, parentWelcomeEmail, rewriteDocHtml, sampleNotificationEmails, wrapEmail } from "./emails";

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
    expect(html.includes('src="/api/files/abc"') || html.includes("src=\"http")).toBe(true);
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
  });
});
