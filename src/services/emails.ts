import { config } from "../config";
import type { Camper, CamperChangeLog, InstructionDoc, Medication, Occurrence, PrepSection, ScheduleRole, Staff } from "../types";
import { PARENT_FIELD_LABEL } from "../types";
import { formatBrazilPhone } from "../utils";

/** Paper-cut icons in `frontend/public/icons/` — same files the app uses. */
export type MailIcon = "parent" | "staff" | "camper" | "bunk" | "transport" | "preparation" | "camera" | "health" | "notifications" | "badge" | "report" | "schedule";

function origin(): string {
  return config.publicOrigin || config.appUrl.replace(/\/$/, "");
}

function appHref(): string {
  return config.appUrl || origin() || "#";
}

export function mailAsset(path: string): string {
  const base = origin();
  if (!base) return path;
  if (/^https?:\/\//i.test(path)) return path;
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

/** Editor HTML → absolute image/file URLs the mail client can fetch. */
export function rewriteDocHtml(html: string): string {
  const base = origin();
  if (!html) return "";
  if (!base) return html;
  return html.replace(/(src|href)="(\/[^"]+)"/gi, (_, attr: string, url: string) => `${attr}="${base}${url}"`);
}

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function firstName(name: string): string {
  return name.split(" ")[0] || name;
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function ctaHtml(href: string, label: string): string {
  return `<p style="margin:28px 0 8px;text-align:center"><a href="${esc(href)}" style="display:inline-block;background:#183d36;color:#ffffff;font-family:'Trebuchet MS',system-ui,sans-serif;font-weight:700;font-size:16px;text-decoration:none;padding:14px 28px;border-radius:999px">${esc(label)}</a></p>`;
}

function factsHtml(rows: { label: string; value: string }[]): string {
  const shown = rows.filter((r) => r.value);
  if (!shown.length) return "";
  const body = shown
    .map(
      (r) =>
        `<tr><td style="padding:10px 0;border-bottom:1px solid #e2ebe5;color:#668078;font-size:13px;width:38%;vertical-align:top">${esc(r.label)}</td><td style="padding:10px 0;border-bottom:1px solid #e2ebe5;color:#183d36;font-family:'Trebuchet MS',system-ui,sans-serif;font-weight:800;font-size:15px">${esc(r.value)}</td></tr>`,
    )
    .join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0 8px">${body}</table>`;
}

function listHtml(items: string[]): string {
  if (!items.length) return "";
  return `<ul style="margin:8px 0 0;padding:0 0 0 1.2em;color:#18332f">${items.map((i) => `<li style="margin:4px 0">${esc(i)}</li>`).join("")}</ul>`;
}

export function wrapEmail(opts: { subject: string; title: string; icon: MailIcon; bodyHtml: string; cta?: { href: string; label: string }; preheader?: string }): { subject: string; html: string; text: string } {
  const logo = mailAsset("/church-logo.png");
  const icon = mailAsset(`/icons/${opts.icon}.png`);
  const cta = opts.cta ? ctaHtml(opts.cta.href, opts.cta.label) : "";
  const preheader = opts.preheader ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(opts.preheader)}</div>` : "";
  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<body style="margin:0;padding:0;background:#f4f0e5">
${preheader}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f0e5;padding:24px 12px">
  <tr><td align="center">
    <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="width:100%;max-width:560px;background:#fffdf8;border-radius:18px;overflow:hidden">
      <tr><td style="background:#086338;padding:22px 24px;text-align:center">
        <img src="${esc(logo)}" width="72" height="72" alt="Acampa Kids" style="display:block;margin:0 auto;border:0;border-radius:50%">
      </td></tr>
      <tr><td style="padding:28px 28px 4px;text-align:center">
        <img src="${esc(icon)}" width="48" height="48" alt="" style="display:block;margin:0 auto 12px;border:0">
        <h1 style="margin:0;font-family:'Trebuchet MS',system-ui,sans-serif;font-size:22px;line-height:1.25;font-weight:800;color:#183d36">${esc(opts.title)}</h1>
      </td></tr>
      <tr><td style="padding:12px 28px 32px;font-family:system-ui,-apple-system,sans-serif;font-size:16px;line-height:1.55;color:#18332f">
        ${opts.bodyHtml}
        ${cta}
      </td></tr>
      <tr><td style="background:#183d36;padding:16px 24px;text-align:center;font-family:system-ui,sans-serif;font-size:12px;line-height:1.4;color:#a9c2a0">
        Igreja Presbiteriana em Alphaville · Acampa Kids
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
  const text = [opts.title, stripHtml(opts.bodyHtml), opts.cta ? `${opts.cta.label}: ${opts.cta.href}` : ""].filter(Boolean).join("\n\n");
  return { subject: opts.subject, html, text };
}

function appCta(label = "Abrir o app"): { href: string; label: string } | undefined {
  const href = appHref();
  return href && href !== "#" ? { href, label } : undefined;
}

function kidArticle(kid: Pick<Camper, "sex" | "probableGender">): { article: string; pron: string; fem: boolean } {
  const fem = (kid.sex ?? kid.probableGender) === "F";
  return { article: fem ? "a" : "o", pron: fem ? "dela" : "dele", fem };
}

export function medicationLine(m: Medication): string {
  const when = m.asNeeded ? "quando necessário" : m.times.length ? m.times.join(", ") : "horário a confirmar";
  return [[m.name, m.dose].filter(Boolean).join(" "), when, m.notes].filter(Boolean).join(" · ");
}

function showChangeValue(v: unknown, labelOf: (id: string) => string): string {
  if (v === null || v === undefined || v === "") return "—";
  if (Array.isArray(v)) {
    if (!v.length) return "—";
    if (typeof v[0] === "object" && v[0] !== null) return (v as Medication[]).map(medicationLine).join("; ");
    return v.map((id) => labelOf(String(id)) || String(id)).join(", ");
  }
  if (typeof v === "boolean") return v ? "sim" : "não";
  if (typeof v === "number") return String(v).replace(".", ",");
  return String(v);
}

export function parentWelcomeEmail(parent: { name: string; phone: string }, kids: Pick<Camper, "name" | "sex" | "probableGender">[], windowLabel: string | null): { subject: string; html: string; text: string } {
  const names = kids.map((k) => firstName(k.name));
  const who =
    kids.length === 0
      ? "sua criança está inscrita"
      : kids.length === 1
        ? `${kidArticle(kids[0]).article} ${esc(names[0])} está inscrit${kidArticle(kids[0]).fem ? "a" : "o"}`
        : `${esc(names.slice(0, -1).join(", "))} e ${esc(names[names.length - 1])} estão inscrit${kids.every((k) => kidArticle(k).fem) ? "as" : "os"}`;
  const body = [
    `<p style="margin:0 0 12px">Olá, <strong>${esc(firstName(parent.name))}</strong>.</p>`,
    `<p style="margin:0 0 12px">${who} no Acampa Kids. Pelo app você acompanha a preparação, as fotos e os recados da equipe.</p>`,
    factsHtml([
      { label: "Entrar com o celular", value: formatBrazilPhone(parent.phone) },
      { label: "Acesso ao app", value: windowLabel ?? "" },
      { label: kids.length === 1 ? "Criança" : "Crianças", value: kids.map((k) => k.name).join(", ") },
    ]),
    `<p style="margin:16px 0 0;color:#668078;font-size:14px">O código de acesso chega por SMS neste celular. Não compartilhe o código.</p>`,
  ].join("");
  return wrapEmail({
    subject: "Sua criança está inscrita no Acampa Kids",
    title: "Bem-vindo ao Acampa Kids",
    icon: "parent",
    preheader: `${firstName(parent.name)}, acompanhe a inscrição pelo app.`,
    bodyHtml: body,
    cta: appCta("Entrar no app"),
  });
}

export function parentPrepEmail(parentName: string, section: Pick<PrepSection, "title" | "emoji" | "content">, isNew: boolean): { subject: string; html: string; text: string } {
  const title = `${section.emoji ? `${section.emoji} ` : ""}${section.title}`;
  const body = [
    `<p style="margin:0 0 12px">Olá, <strong>${esc(firstName(parentName))}</strong>.</p>`,
    `<p style="margin:0 0 16px">${isNew ? "Há uma preparação nova para vocês:" : "A preparação abaixo foi atualizada:"}</p>`,
    `<h2 style="margin:0 0 12px;font-family:'Trebuchet MS',system-ui,sans-serif;font-size:18px;color:#183d36">${esc(title)}</h2>`,
    `<div style="margin:0">${rewriteDocHtml(section.content)}</div>`,
  ].join("");
  return wrapEmail({
    subject: isNew ? `Nova preparação: ${section.title}` : `Preparação atualizada: ${section.title}`,
    title: isNew ? "Nova preparação" : "Preparação atualizada",
    icon: "preparation",
    bodyHtml: body,
    cta: appCta("Ver no app"),
  });
}

export function busCheckinEmail(
  kid: Pick<Camper, "name" | "sex" | "probableGender" | "guardianName">,
  contacts: { title: string; name: string; phone: string | null }[],
): { subject: string; html: string; text: string } {
  const { article, pron } = kidArticle(kid);
  const greet = kid.guardianName ? `${esc(firstName(kid.guardianName))}, ` : "";
  const contactRows = contacts.filter((c) => c.phone);
  const body = [
    `<p style="margin:0 0 12px">${greet}${article} <strong>${esc(firstName(kid.name))}</strong> está a caminho de um fim de semana incrível para aprender sobre Jesus.</p>`,
    `<p style="margin:0 0 12px">Aproveite o fim de semana livre: vamos cuidar muito bem ${pron}.</p>`,
    contactRows.length
      ? `<p style="margin:18px 0 6px;font-family:'Trebuchet MS',system-ui,sans-serif;font-weight:800;color:#183d36">Se precisar falar com a equipe</p>${listHtml(contactRows.map((c) => `${c.title}: ${c.name}${c.phone ? ` · ${formatBrazilPhone(c.phone)}` : ""}`))}`
      : "",
  ].join("");
  return wrapEmail({
    subject: `${firstName(kid.name)} embarcou no ônibus`,
    title: "A caminho do acampamento",
    icon: "transport",
    preheader: `${article.toUpperCase()}${article.slice(1)} ${firstName(kid.name)} embarcou. Vamos cuidar muito bem ${pron}.`,
    bodyHtml: body,
    cta: appCta(),
  });
}

export function staffWelcomeEmail(
  staff: Pick<Staff, "name" | "phone">,
  roles: string[],
  facts: { room?: string | null; team?: string | null; bus?: string | null },
): { subject: string; html: string; text: string } {
  const what = roles.length ? `você agora é ${roles.length > 1 ? `${roles.slice(0, -1).join(", ")} e ${roles[roles.length - 1]}` : roles[0]}` : "o app do acampamento está liberado para você";
  const body = [
    `<p style="margin:0 0 12px">Olá, <strong>${esc(firstName(staff.name))}</strong>.</p>`,
    `<p style="margin:0 0 12px">${esc(what.charAt(0).toUpperCase() + what.slice(1))}.</p>`,
    factsHtml([
      { label: "Entrar com o celular", value: staff.phone ? formatBrazilPhone(staff.phone) : "" },
      { label: "Quarto", value: facts.room ?? "" },
      { label: "Time", value: facts.team ?? "" },
      { label: "Transporte", value: facts.bus ?? "" },
    ]),
    roles.length ? `<p style="margin:16px 0 0;color:#668078;font-size:14px">Funções: ${esc(roles.join(" · "))}</p>` : "",
  ].join("");
  return wrapEmail({
    subject: roles.length ? "Nova responsabilidade no Acampa Kids" : "O app do Acampa Kids está liberado",
    title: roles.length ? "Nova responsabilidade" : "Bem-vindo à equipe",
    icon: "staff",
    bodyHtml: body,
    cta: appCta("Entrar no app"),
  });
}

export function documentEmail(toName: string, kind: "instructions" | "preparation", title: string, emoji: string, content: string, isNew: boolean): { subject: string; html: string; text: string } {
  const label = kind === "instructions" ? "Instruções" : "Preparação";
  const heading = `${emoji ? `${emoji} ` : ""}${title}`;
  const body = [
    `<p style="margin:0 0 12px">Olá, <strong>${esc(firstName(toName))}</strong>.</p>`,
    `<p style="margin:0 0 16px">${isNew ? `Há ${kind === "instructions" ? "novas instruções" : "uma preparação nova"}:` : `${label} atualizada:`}</p>`,
    `<h2 style="margin:0 0 12px;font-family:'Trebuchet MS',system-ui,sans-serif;font-size:18px;color:#183d36">${esc(heading)}</h2>`,
    `<div style="margin:0">${rewriteDocHtml(content)}</div>`,
  ].join("");
  return wrapEmail({
    subject: isNew ? `${label}: ${title}` : `${label} atualizada: ${title}`,
    title: isNew ? `Nova ${label.toLowerCase()}` : `${label} atualizada`,
    icon: kind === "instructions" ? "report" : "preparation",
    bodyHtml: body,
    cta: appCta("Ver no app"),
  });
}

export function instructionEmail(toName: string, doc: Pick<InstructionDoc, "title" | "emoji" | "content">, isNew: boolean): { subject: string; html: string; text: string } {
  return documentEmail(toName, "instructions", doc.title, doc.emoji, doc.content, isNew);
}

export function prepEmail(toName: string, section: Pick<PrepSection, "title" | "emoji" | "content">, isNew: boolean): { subject: string; html: string; text: string } {
  return documentEmail(toName, "preparation", section.title, section.emoji, section.content, isNew);
}

export function roleDocEmail(toName: string, role: Pick<ScheduleRole, "name" | "emoji" | "instructions" | "preparation">, field: "instructions" | "preparation"): { subject: string; html: string; text: string } {
  const label = field === "instructions" ? "Instruções" : "Preparação";
  const content = field === "instructions" ? role.instructions : role.preparation;
  return documentEmail(toName, field, `Função ${role.name}`, role.emoji, content, false);
}

export function parentEditEmail(
  toName: string,
  kid: Pick<Camper, "name">,
  entry: Pick<CamperChangeLog, "byName" | "medical" | "changes">,
  labelOf: (id: string) => string,
): { subject: string; html: string; text: string } {
  const what = entry.medical ? "dados médicos" : "observações";
  const rows = entry.changes
    .map((x) => {
      const field = PARENT_FIELD_LABEL[x.field] ?? x.field;
      return `<tr>
        <td style="padding:10px 0;border-bottom:1px solid #e2ebe5;color:#183d36;font-weight:800;font-size:14px">${esc(field)}</td>
        <td style="padding:10px 8px;border-bottom:1px solid #e2ebe5;color:#668078;font-size:14px">${esc(showChangeValue(x.before, labelOf))}</td>
        <td style="padding:10px 0;border-bottom:1px solid #e2ebe5;color:#183d36;font-size:14px;font-weight:700">${esc(showChangeValue(x.after, labelOf))}</td>
      </tr>`;
    })
    .join("");
  const body = [
    `<p style="margin:0 0 12px">Olá, <strong>${esc(firstName(toName))}</strong>.</p>`,
    `<p style="margin:0 0 16px"><strong>${esc(entry.byName)}</strong> alterou ${what} de <strong>${esc(kid.name)}</strong>.</p>`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr><td style="padding:8px 0;color:#668078;font-size:12px;font-weight:700">Campo</td><td style="padding:8px;color:#668078;font-size:12px;font-weight:700">Antes</td><td style="padding:8px 0;color:#668078;font-size:12px;font-weight:700">Agora</td></tr>
      ${rows}
    </table>`,
  ].join("");
  return wrapEmail({
    subject: `${entry.byName} alterou ${what} de ${firstName(kid.name)}`,
    title: entry.medical ? "Dados médicos atualizados" : "Observações atualizadas",
    icon: "health",
    bodyHtml: body,
    cta: appCta("Ver a ficha"),
  });
}

export function occurrenceEmail(adminName: string, o: Occurrence): { subject: string; html: string; text: string } {
  const people = [
    ...o.campers.map((p) => `criança ${p.name}`),
    ...o.staff.map((p) => `equipe ${p.name}`),
  ];
  const body = [
    `<p style="margin:0 0 12px">Olá, <strong>${esc(firstName(adminName))}</strong>.</p>`,
    `<p style="margin:0 0 12px">Nova ocorrência registrada por <strong>${esc(o.createdByName)}</strong>${people.length ? ` (${esc(people.join(", "))})` : ""}.</p>`,
    `<div style="margin:16px 0 0;padding:16px;background:#f4f0e5;border-radius:14px">${rewriteDocHtml(o.description)}</div>`,
  ].join("");
  return wrapEmail({
    subject: `Nova ocorrência · ${o.createdByName}`,
    title: "Nova ocorrência",
    icon: "report",
    bodyHtml: body,
    cta: appCta("Ver ocorrências"),
  });
}

export function checkinEmail(
  staff: Pick<Staff, "name" | "roomRole">,
  ctx: { room?: string | null; bus?: string | null; kids: { name: string }[] },
): { subject: string; html: string; text: string } {
  const caretaker = staff.roomRole === "caretaker";
  const body = [
    `<p style="margin:0 0 12px">Olá, <strong>${esc(firstName(staff.name))}</strong>.</p>`,
    `<p style="margin:0 0 12px">Check-in feito. Confira as crianças do seu quarto no app.</p>`,
    factsHtml([
      { label: "Quarto", value: ctx.room ? `${ctx.room}${ctx.kids.length ? ` (${ctx.kids.length} criança${ctx.kids.length === 1 ? "" : "s"})` : ""}` : "" },
      { label: "Transporte", value: ctx.bus ?? "" },
    ]),
    caretaker && ctx.kids.length ? `<p style="margin:18px 0 6px;font-family:'Trebuchet MS',system-ui,sans-serif;font-weight:800;color:#183d36">Crianças do quarto</p>${listHtml(ctx.kids.map((k) => k.name))}` : "",
  ].join("");
  return wrapEmail({
    subject: "Check-in feito",
    title: "Check-in feito",
    icon: "badge",
    bodyHtml: body,
    cta: appCta("Ver o quarto"),
  });
}

export function roomsAppliedEmail(
  name: string,
  change: { room?: { after: string | null }; role?: "caretaker" | "helper"; kids?: { gained: string[]; lost: string[]; sameAfterMove: boolean } },
): { subject: string; html: string; text: string } {
  const facts: { label: string; value: string }[] = [];
  if (change.room) facts.push({ label: "Quarto", value: change.room.after ?? "sem quarto" });
  if (change.role) facts.push({ label: "Função no quarto", value: change.role === "caretaker" ? "Líder de crianças" : "Auxiliar (sem crianças próprias)" });
  const g = change.kids?.gained ?? [];
  const l = change.kids?.lost ?? [];
  const body = [
    `<p style="margin:0 0 12px">Olá, <strong>${esc(firstName(name))}</strong>.</p>`,
    `<p style="margin:0 0 12px">Os quartos foram definidos. Veja o que mudou para você:</p>`,
    factsHtml(facts),
    g.length ? `<p style="margin:18px 0 6px;font-family:'Trebuchet MS',system-ui,sans-serif;font-weight:800;color:#183d36">Passaram a ser sua responsabilidade</p>${listHtml(g)}` : "",
    l.length ? `<p style="margin:18px 0 6px;font-family:'Trebuchet MS',system-ui,sans-serif;font-weight:800;color:#183d36">Não estão mais com você</p>${listHtml(l)}` : "",
    change.kids?.sameAfterMove && !g.length && !l.length ? `<p style="margin:12px 0 0;color:#668078">As crianças sob seus cuidados são as mesmas.</p>` : "",
  ].join("");
  return wrapEmail({
    subject: "Seu quarto no Acampa Kids",
    title: "Quartos definidos",
    icon: "bunk",
    bodyHtml: body,
    cta: appCta("Ver o quarto"),
  });
}

export function birthdayEmail(
  toName: string,
  kid: Pick<Camper, "name" | "sex" | "probableGender" | "birthDate">,
  room: string | null,
  day: string,
  roomKids: string[],
  roomStaff: string[],
): { subject: string; html: string; text: string } {
  const age = kid.birthDate ? Number(day.slice(0, 4)) - Number(kid.birthDate.slice(0, 4)) : null;
  const { article, pron, fem } = kidArticle(kid);
  const of = fem ? "da" : "do";
  const body = [
    `<p style="margin:0 0 12px">Olá, <strong>${esc(firstName(toName))}</strong>.</p>`,
    `<p style="margin:0 0 12px">Hoje é aniversário ${of} <strong>${esc(kid.name)}</strong>${age ? ` (${age} anos)` : ""}${room ? `, do quarto ${esc(room)}` : ""}. Vamos fazer o dia ${pron} especial.</p>`,
    factsHtml([
      { label: "Criança", value: kid.name },
      { label: "Idade", value: age ? `${age} anos` : "" },
      { label: "Quarto", value: room ?? "" },
    ]),
    roomKids.length ? `<p style="margin:18px 0 6px;font-family:'Trebuchet MS',system-ui,sans-serif;font-weight:800;color:#183d36">Crianças do quarto</p>${listHtml(roomKids)}` : "",
    roomStaff.length ? `<p style="margin:18px 0 6px;font-family:'Trebuchet MS',system-ui,sans-serif;font-weight:800;color:#183d36">Equipe do quarto</p>${listHtml(roomStaff)}` : "",
  ].join("");
  return wrapEmail({
    subject: `Aniversário ${of} ${firstName(kid.name)}`,
    title: `Parabéns, ${article} ${firstName(kid.name)}!`,
    icon: "camper",
    preheader: `Hoje é aniversário ${of} ${firstName(kid.name)}. Vamos fazer o dia ${pron} especial.`,
    bodyHtml: body,
    cta: appCta(),
  });
}

export function accessWindowLabel(from: Date | null, until: Date | null): string | null {
  if (!from && !until) return "liberado";
  const fmt = (d: Date) =>
    new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(d);
  if (from && until) return `${fmt(from)} até ${fmt(until)}`;
  if (from) return `a partir de ${fmt(from)}`;
  if (until) return `até ${fmt(until)}`;
  return null;
}

export type SampleEmailAudience = "parent" | "staff";

export interface SampleEmail {
  id: string;
  audience: SampleEmailAudience;
  title: string;
  subject: string;
  html: string;
  text: string;
}

const SAMPLE_PARENT = { name: "Marcela Souza", phone: "+5511999999999" };
const SAMPLE_KID = { name: "Ana Souza", sex: "F" as const, probableGender: "F" as const, birthDate: "2018-09-12", guardianName: "Marcela Souza" };
const SAMPLE_STAFF = { name: "João Silva", phone: "+5511988887777", roomRole: "caretaker" as const };

/** Every notification email the camp can send, with sample names — for the admin preview. */
export function sampleNotificationEmails(): SampleEmail[] {
  const parentWelcome = parentWelcomeEmail(SAMPLE_PARENT, [SAMPLE_KID], "liberado");
  const parentPrep = parentPrepEmail(SAMPLE_PARENT.name, { title: "O que levar", emoji: "🎒", content: "<p>Roupa confortável, protetor solar e a Bíblia.</p>" }, true);
  const bus = busCheckinEmail(SAMPLE_KID, [{ title: "Coordenação", name: "João Silva", phone: "+5511988887777" }]);
  const staffWelcome = staffWelcomeEmail(SAMPLE_STAFF, [], { room: "103", team: "Time Belém", bus: "Ônibus Azul 1" });
  const staffEnrol = staffWelcomeEmail(SAMPLE_STAFF, ["organizador (acesso de administração)"], { room: "103", team: "Time Belém", bus: "Ônibus Azul 1" });
  const instructions = instructionEmail(SAMPLE_STAFF.name, { title: "Regras do acampamento", emoji: "📖", content: "<p>Respeito, pontualidade e cuidado uns com os outros.</p>" }, true);
  const prep = prepEmail(SAMPLE_STAFF.name, { title: "Chegada na igreja", emoji: "📌", content: "<p>Esteja na igreja até 7h30. O ônibus sai às 8h.</p>" }, true);
  const roleInstructions = roleDocEmail(SAMPLE_STAFF.name, { name: "Monitor", emoji: "🎯", instructions: "<p>Fique com as crianças da sua base o tempo todo.</p>", preparation: "" }, "instructions");
  const rolePrep = roleDocEmail(SAMPLE_STAFF.name, { name: "Monitor", emoji: "🎯", instructions: "", preparation: "<p>Camiseta do acampamento e apito.</p>" }, "preparation");
  const parentEdit = parentEditEmail(
    SAMPLE_STAFF.name,
    SAMPLE_KID,
    { byName: "Marcela Souza", medical: true, changes: [{ field: "allergies", before: [], after: ["amendoim"] }] },
    (id) => id,
  );
  const occurrence = occurrenceEmail(SAMPLE_STAFF.name, {
    _id: "sample",
    campers: [{ id: "k", name: SAMPLE_KID.name }],
    staff: [],
    description: "<p>Caiu no campo. Sem ferimentos graves; gelo e observação.</p>",
    createdByUserId: "u",
    createdByName: "Maria",
    createdByRole: "admin",
    createdAt: new Date(),
  });
  const checkin = checkinEmail(SAMPLE_STAFF, { room: "103", bus: "Ônibus Azul 1", kids: [{ name: "Ana Souza" }, { name: "Bia Lima" }] });
  const rooms = roomsAppliedEmail(SAMPLE_STAFF.name, {
    room: { after: "103" },
    role: "caretaker",
    kids: { gained: ["Ana Souza", "Bia Lima"], lost: [], sameAfterMove: false },
  });
  const birthday = birthdayEmail(SAMPLE_STAFF.name, SAMPLE_KID, "103", "2026-09-12", ["Ana Souza", "Bia Lima"], ["João Silva", "Maria"]);
  const of = (id: string, audience: SampleEmailAudience, title: string, mail: { subject: string; html: string; text: string }): SampleEmail => ({
    id,
    audience,
    title,
    subject: mail.subject,
    html: mail.html,
    text: mail.text,
  });
  return [
    of("parent-welcome", "parent", "Boas-vindas aos pais", parentWelcome),
    of("parent-prep", "parent", "Preparação nova / alterada para os pais", parentPrep),
    of("bus-checkin", "parent", "Criança embarcou no ônibus", bus),
    of("staff-welcome", "staff", "Boas-vindas da equipe", staffWelcome),
    of("staff-enrol", "staff", "Nova responsabilidade", staffEnrol),
    of("instructions", "staff", "Instruções novas / alteradas", instructions),
    of("prep", "staff", "Preparação nova / alterada", prep),
    of("role-instructions", "staff", "Instruções da função", roleInstructions),
    of("role-prep", "staff", "Preparação da função", rolePrep),
    of("parent-edit", "staff", "Pais alteraram os pontos de atenção", parentEdit),
    of("occurrence", "staff", "Ocorrência registrada", occurrence),
    of("checkin", "staff", "Confirmação de check-in da equipe", checkin),
    of("rooms", "staff", "Quartos definidos", rooms),
    of("birthday", "staff", "Aniversário de criança no acampamento", birthday),
  ];
}
