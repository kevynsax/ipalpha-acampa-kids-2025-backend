import { config } from "../config";
import type { Camper, CamperChangeLog, InstructionDoc, Medication, Occurrence, PrepSection, ScheduleRole, Staff } from "../types";
import { PARENT_FIELD_LABEL } from "../types";
import { formatBrazilPhone } from "../utils";

/** Paper-cut icons in `frontend/public/icons/` — same files the app uses. */
export type MailIcon = "parent" | "staff" | "camper" | "bunk" | "transport" | "preparation" | "camera" | "health" | "notifications" | "badge" | "report" | "schedule";

function origin(): string {
  return config.publicOrigin;
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

export function wrapEmail(opts: { subject: string; title: string; icon: MailIcon; hero?: string; bodyHtml: string; cta?: { href: string; label: string }; preheader?: string }): { subject: string; html: string; text: string } {
  const logo = mailAsset("/church-logo.png");
  const icon = mailAsset(`/icons/${opts.icon}.png`);
  const hero = opts.hero ? mailAsset(`/mail/${opts.hero}.png`) : "";
  const heroRow = hero
    ? `<tr><td style="padding:0;background:#fffdf8"><img src="${esc(hero)}" width="560" alt="" style="display:block;width:100%;height:auto;border:0"></td></tr>`
    : "";
  const cta = opts.cta ? ctaHtml(opts.cta.href, opts.cta.label) : "";
  const preheader = opts.preheader ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(opts.preheader)}</div>` : "";
  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<body style="margin:0;padding:0;background:#f4f0e5">
${preheader}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f0e5;padding:24px 12px">
  <tr><td align="center">
    <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="width:100%;max-width:560px;background:#fffdf8;border-radius:18px;overflow:hidden">
      <tr><td style="background:#086338;padding:18px 24px;text-align:center">
        <img src="${esc(logo)}" width="64" height="64" alt="Acampa Kids" style="display:block;margin:0 auto;border:0;border-radius:50%">
      </td></tr>
      ${heroRow}
      <tr><td style="padding:24px 28px 4px;text-align:center">
        <img src="${esc(icon)}" width="40" height="40" alt="" style="display:block;margin:0 auto 10px;border:0">
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

function capFirst(s: string): string {
  const t = s.trim();
  if (!t || t === "—") return t;
  return t.charAt(0).toLocaleUpperCase("pt-BR") + t.slice(1);
}

function showChangeValue(v: unknown, labelOf: (id: string) => string): string {
  if (v === null || v === undefined || v === "") return "—";
  if (Array.isArray(v)) {
    if (!v.length) return "—";
    if (typeof v[0] === "object" && v[0] !== null) return (v as Medication[]).map((m) => capFirst(medicationLine(m))).join("; ");
    return v.map((id) => capFirst(labelOf(String(id)) || String(id))).join(", ");
  }
  if (typeof v === "boolean") return v ? "Sim" : "Não";
  if (typeof v === "number") return String(v).replace(".", ",");
  return capFirst(String(v));
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
    `<p style="margin:16px 0 0;color:#668078;font-size:14px">O código de acesso chega por SMS neste celular. Não compartilhe o código com ninguém.</p>`,
  ].join("");
  return wrapEmail({
    subject: kids.length > 1 ? "Suas crianças estão inscritas no Acampa Kids" : "Sua criança está inscrita no Acampa Kids",
    title: "Bem-vindo ao Acampa Kids",
    icon: "parent",
    hero: "parent-welcome",
    preheader: `${firstName(parent.name)}, acompanhe a inscrição pelo app.`,
    bodyHtml: body,
    cta: appCta("Entrar no app"),
  });
}

export function parentPrepEmail(parentName: string, section: Pick<PrepSection, "title" | "emoji" | "content">, isNew: boolean): { subject: string; html: string; text: string } {
  const title = `${section.emoji ? `${section.emoji} ` : ""}${section.title}`;
  const body = [
    `<p style="margin:0 0 12px">Olá, <strong>${esc(firstName(parentName))}</strong>.</p>`,
    isNew ? "" : `<p style="margin:0 0 16px">A preparação abaixo foi atualizada. Leia de novo, por favor — pode ter mudado o que levar ou o horário.</p>`,
    `<h2 style="margin:0 0 12px;font-family:'Trebuchet MS',system-ui,sans-serif;font-size:18px;color:#183d36">${esc(title)}</h2>`,
    `<div style="margin:0">${rewriteDocHtml(section.content)}</div>`,
  ].join("");
  return wrapEmail({
    subject: isNew ? `Nova preparação: ${section.title}` : `Preparação atualizada: ${section.title}`,
    title: isNew ? "Nova preparação" : "Preparação atualizada",
    icon: "preparation",
    hero: "parent-prep",
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
    `<p style="margin:0 0 12px">Aproveite o fim de semana livre. Vamos cuidar muito bem ${pron}.</p>`,
    contactRows.length
      ? `<p style="margin:18px 0 6px;font-family:'Trebuchet MS',system-ui,sans-serif;font-weight:800;color:#183d36">Se precisar falar com a equipe</p>${listHtml(contactRows.map((c) => `${c.title}: ${c.name}${c.phone ? ` · ${formatBrazilPhone(c.phone)}` : ""}`))}`
      : "",
  ].join("");
  return wrapEmail({
    subject: `${firstName(kid.name)} embarcou no ônibus`,
    title: "A caminho do acampamento",
    icon: "transport",
    hero: "bus-checkin",
    preheader: `${article.toUpperCase()}${article.slice(1)} ${firstName(kid.name)} embarcou. Vamos cuidar muito bem ${pron}.`,
    bodyHtml: body,
    cta: appCta(),
  });
}

function noteBox(inner: string): string {
  return `<div style="margin:16px 0 0;padding:16px;background:#f4f0e5;border-radius:14px">${inner}</div>`;
}
function noteP(text: string, last = false): string {
  return `<p style="margin:0${last ? "" : " 0 10px"}">${text}</p>`;
}

/** Hero illustration for a new-responsibility email — first matching role wins. */
export function enrolHero(roles: string[]): string {
  const text = roles.join(" ").toLowerCase();
  if (text.includes("organizador dos jogos") || text.includes("games organizer") || text.includes("organisateur des jeux") || text.includes("organizador de juegos")) return "enrol-games";
  if (text.includes("organizador") || text.includes("organizer") || text.includes("organisateur")) return "enrol-organizer";
  if (text.includes("placar") || text.includes("scoreboard") || text.includes("marcador") || text.includes("score")) return "enrol-score";
  if (text.includes("check-in")) return "enrol-checkin";
  if (text.includes("ônibus") || text.includes("onibus") || text.includes("bus") || text.includes("autobus") || text.includes("porta do") || text.includes("at the door") || text.includes("à la porte")) return "enrol-bus";
  if (text.includes("médica") || text.includes("medica") || text.includes("medical")) return "enrol-medical";
  if (text.includes("colete") || text.includes("vest") || text.includes("gilet") || text.includes("chaleco")) return "enrol-vest";
  if (text.includes("fotógraf") || text.includes("fotograf") || text.includes("photo")) return "enrol-photo";
  if (text.includes("contato dos pais") || text.includes("parent contact") || text.includes("contact parents") || text.includes("contacto de padres")) return "enrol-contact";
  return "staff-enrol";
}

function enrolBriefing(roles: string[]): string {
  const hero = enrolHero(roles);
  if (!roles.length) {
    return noteBox(
      noteP("O app do acampamento está liberado para você. Entre com o celular cadastrado.") +
        noteP("Dá para ver o seu quarto, o transporte, a programação e as crianças que estão com você.", true),
    );
  }
  const brief: Record<string, string> = {
    "enrol-organizer":
      noteP("Você foi escalado como organizador — tem acesso de administração no app.") +
      noteP("Pode montar a programação, os quartos e o que a equipe precisa. Cuidado ao salvar: as mudanças chegam na hora para todo mundo.", true),
    "enrol-games":
      noteP("Você foi escalado para organizar os jogos — programação e placar.") +
      noteP("Quem lança ponto no placar é o ajudante do placar. Você define as regras e acompanha o resultado.", true),
    "enrol-score":
      noteP("Você foi escalado para lançar pontos no placar.") +
      noteP("Só marque ponto depois de conferir o crachá da criança no aplicativo. Não invente pontuação fora do jogo.", true),
    "enrol-checkin":
      noteP("Você foi escalado para nos ajudar no check-in das crianças na igreja.") +
      noteP("Só faça o check-in depois de conferir as informações médicas com o pai ou a mãe.", true),
    "enrol-bus":
      noteP("Você foi escalado para nos ajudar também a fazer o check-in das crianças no ônibus.") +
      noteP("É importante <strong>não deixá-las saírem</strong> depois de terem entrado. Só deixe entrar depois de ter marcado no aplicativo. No checkout é a mesma coisa: só entregue a criança para o pai ou a mãe dela.") +
      noteP("Você <strong>não coloca as malas</strong> no ônibus. Quem coloca é o pai. E não saia da porta — senão uma criança pode sair sem o seu controle.", true),
    "enrol-medical":
      noteP("Você foi escalado para a equipe médica.") +
      noteP("Você vê a ficha de saúde de todas as crianças. O que registrar no app fica no histórico — escreva com clareza.", true),
    "enrol-vest":
      noteP("Você foi escalado para entregar e recolher os coletes da equipe.") +
      noteP("Marque no aplicativo na hora da entrega e na hora da devolução. Colete sem dono no app é colete perdido.", true),
    "enrol-photo":
      noteP("Você foi escalado como fotógrafo do acampamento.") +
      noteP("As fotos só aparecem para pais e equipe quando você publicar o álbum. Não publique foto de criança em situação constrangedora.", true),
    "enrol-contact":
      noteP("Você foi escalado como contato dos pais.") +
      noteP("Eles podem te ligar pelo número do cadastro. Atenda com calma e, se for saúde, chame a equipe médica.", true),
    "staff-enrol":
      noteP("Você recebeu uma nova responsabilidade no acampamento.") +
      noteP("Abra o app para ver o que mudou e o que precisa fazer.", true),
  };
  return noteBox(brief[hero] ?? brief["staff-enrol"]);
}

export function staffWelcomeEmail(
  staff: Pick<Staff, "name" | "phone">,
  roles: string[],
): { subject: string; html: string; text: string } {
  const what = roles.length
    ? `você agora é ${roles.length > 1 ? `${roles.slice(0, -1).join(", ")} e ${roles[roles.length - 1]}` : roles[0]}`
    : "o app do acampamento está liberado para você";
  const body = [
    `<p style="margin:0 0 12px">Olá, <strong>${esc(firstName(staff.name))}</strong>.</p>`,
    `<p style="margin:0 0 12px">${esc(what.charAt(0).toUpperCase() + what.slice(1))}.</p>`,
    factsHtml([{ label: "Entrar com o celular", value: staff.phone ? formatBrazilPhone(staff.phone) : "" }]),
    enrolBriefing(roles),
  ].join("");
  return wrapEmail({
    subject: roles.length ? "Nova responsabilidade no Acampa Kids" : "O app do Acampa Kids está liberado",
    title: roles.length ? "Nova responsabilidade" : "Bem-vindo à equipe",
    icon: "staff",
    hero: roles.length ? enrolHero(roles) : "staff-welcome",
    bodyHtml: body,
    cta: appCta("Entrar no app"),
  });
}

export function documentEmail(toName: string, kind: "instructions" | "preparation", title: string, emoji: string, content: string, isNew: boolean): { subject: string; html: string; text: string } {
  const label = kind === "instructions" ? "Instruções" : "Preparação";
  const heading = `${emoji ? `${emoji} ` : ""}${title}`;
  const body = [
    `<p style="margin:0 0 12px">Olá, <strong>${esc(firstName(toName))}</strong>.</p>`,
    `<p style="margin:0 0 16px">${isNew ? (kind === "instructions" ? "Tem instrução nova para a equipe. Leia antes de começar o dia." : "Tem uma preparação nova. É o que você precisa levar e saber antes de sair de casa.") : `${label} atualizada. Leia de novo — pode ter mudado o combinado.`}</p>`,
    `<h2 style="margin:0 0 12px;font-family:'Trebuchet MS',system-ui,sans-serif;font-size:18px;color:#183d36">${esc(heading)}</h2>`,
    `<div style="margin:0">${rewriteDocHtml(content)}</div>`,
  ].join("");
  return wrapEmail({
    subject: isNew ? `${label}: ${title}` : `${label} atualizada: ${title}`,
    title: isNew ? `Nova ${label.toLowerCase()}` : `${label} atualizada`,
    icon: kind === "instructions" ? "report" : "preparation",
    hero: kind === "instructions" ? "instructions" : "prep",
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
  const heading = `${role.emoji ? `${role.emoji} ` : ""}Função ${role.name}`;
  return wrapEmail({
    subject: `${label} atualizada: Função ${role.name}`,
    title: `${label} da função`,
    icon: field === "instructions" ? "report" : "preparation",
    hero: field === "instructions" ? "role-instructions" : "role-prep",
    bodyHtml: `<p style="margin:0 0 12px">Olá, <strong>${esc(firstName(toName))}</strong>.</p><p style="margin:0 0 16px">${field === "instructions" ? "As instruções da sua função foram atualizadas. Leia de novo antes do próximo horário." : "A preparação da sua função foi atualizada. Confira o que levar e o que vestir."}</p><h2 style="margin:0 0 12px;font-family:'Trebuchet MS',system-ui,sans-serif;font-size:18px;color:#183d36">${esc(heading)}</h2><div style="margin:0">${rewriteDocHtml(content)}</div>`,
    cta: appCta("Ver no app"),
  });
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
      const field = capFirst(PARENT_FIELD_LABEL[x.field] ?? x.field);
      return `<tr>
        <td style="padding:10px 0;border-bottom:1px solid #e2ebe5;color:#183d36;font-weight:800;font-size:14px">${esc(field)}</td>
        <td style="padding:10px 8px;border-bottom:1px solid #e2ebe5;color:#668078;font-size:14px">${esc(showChangeValue(x.before, labelOf))}</td>
        <td style="padding:10px 0;border-bottom:1px solid #e2ebe5;color:#183d36;font-size:14px;font-weight:700">${esc(showChangeValue(x.after, labelOf))}</td>
      </tr>`;
    })
    .join("");
  const body = [
    `<p style="margin:0 0 12px">Olá, <strong>${esc(firstName(toName))}</strong>.</p>`,
    `<p style="margin:0 0 16px"><strong>${esc(entry.byName)}</strong> alterou ${what} de <strong>${esc(kid.name)}</strong>. Confira no app o que mudou — se for medicação ou alergia, avise a equipe do quarto.</p>`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr><td style="padding:8px 0;color:#668078;font-size:12px;font-weight:700">Campo</td><td style="padding:8px;color:#668078;font-size:12px;font-weight:700">Antes</td><td style="padding:8px 0;color:#668078;font-size:12px;font-weight:700">Agora</td></tr>
      ${rows}
    </table>`,
  ].join("");
  return wrapEmail({
    subject: `${entry.byName} alterou ${what} de ${firstName(kid.name)}`,
    title: entry.medical ? "Dados médicos atualizados" : "Observações atualizadas",
    icon: "health",
    hero: "parent-edit",
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
    `<p style="margin:0 0 12px">Tem uma ocorrência nova, registrada por <strong>${esc(o.createdByName)}</strong>${people.length ? ` (${esc(people.join(", "))})` : ""}.</p>`,
    `<div style="margin:16px 0 0;padding:16px;background:#f4f0e5;border-radius:14px">${rewriteDocHtml(o.description)}</div>`,
  ].join("");
  return wrapEmail({
    subject: `Nova ocorrência · ${o.createdByName}`,
    title: "Nova ocorrência",
    icon: "report",
    hero: "occurrence",
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
    `<p style="margin:0 0 12px">Seu check-in na igreja está feito. Confira no app as crianças do seu quarto — é a sua lista daqui para frente.</p>`,
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
    hero: "checkin",
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
    `<p style="margin:0 0 12px">Os quartos foram definidos. Veja o que mudou para você — quarto, função e crianças.</p>`,
    factsHtml(facts),
    g.length ? `<p style="margin:18px 0 6px;font-family:'Trebuchet MS',system-ui,sans-serif;font-weight:800;color:#183d36">Passaram a ser sua responsabilidade</p>${listHtml(g)}` : "",
    l.length ? `<p style="margin:18px 0 6px;font-family:'Trebuchet MS',system-ui,sans-serif;font-weight:800;color:#183d36">Não estão mais com você</p>${listHtml(l)}` : "",
    change.kids?.sameAfterMove && !g.length && !l.length ? `<p style="margin:12px 0 0;color:#668078">As crianças sob seus cuidados são as mesmas.</p>` : "",
  ].join("");
  return wrapEmail({
    subject: "Seu quarto no Acampa Kids",
    title: "Quartos definidos",
    icon: "bunk",
    hero: "rooms",
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
    `<p style="margin:0 0 12px">Hoje é aniversário ${of} <strong>${esc(kid.name)}</strong>${age ? ` (${age} anos)` : ""}${room ? `, do quarto ${esc(room)}` : ""}. Combinado: vamos fazer o dia ${pron} especial — um parabéns, um cantinho na refeição, sem expor se a criança não quiser festa.</p>`,
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
    hero: "birthday",
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
const SAMPLE_KID_2 = { name: "Pedro Souza", sex: "M" as const, probableGender: "M" as const, birthDate: "2016-03-04", guardianName: "Marcela Souza" };
const SAMPLE_STAFF = { name: "João Silva", phone: "+5511988887777", roomRole: "caretaker" as const };

/** Every notification email the camp can send, with sample names — for the admin preview. */
export function sampleNotificationEmails(): SampleEmail[] {
  const parentWelcome = parentWelcomeEmail(SAMPLE_PARENT, [SAMPLE_KID, SAMPLE_KID_2], "liberado");
  const parentPrep = parentPrepEmail(SAMPLE_PARENT.name, { title: "O que levar", emoji: "🎒", content: "<p>Roupa confortável, protetor solar e a Bíblia.</p>" }, true);
  const bus = busCheckinEmail(SAMPLE_KID, [{ title: "Coordenação", name: "João Silva", phone: "+5511988887777" }]);
  const staffWelcome = staffWelcomeEmail(SAMPLE_STAFF, []);
  const enrol = (roles: string[]) => staffWelcomeEmail(SAMPLE_STAFF, roles);
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
    of("enrol-organizer", "staff", "Nova responsabilidade: organizador", enrol(["organizador (acesso de administração)"])),
    of("enrol-games", "staff", "Nova responsabilidade: jogos", enrol(["organizador dos jogos (programação e placar)"])),
    of("enrol-score", "staff", "Nova responsabilidade: placar", enrol(["ajudante do placar (lança pontos)"])),
    of("enrol-checkin", "staff", "Nova responsabilidade: check-in", enrol(["ajudante do check-in"])),
    of("enrol-bus", "staff", "Nova responsabilidade: ônibus", enrol(["na porta do ônibus (embarque das crianças)"])),
    of("enrol-medical", "staff", "Nova responsabilidade: equipe médica", enrol(["equipe médica"])),
    of("enrol-vest", "staff", "Nova responsabilidade: coletes", enrol(["responsável pelos coletes (entrega e devolução)"])),
    of("enrol-photo", "staff", "Nova responsabilidade: fotógrafo", enrol(["fotógrafo do acampamento (envia as fotos)"])),
    of("enrol-contact", "staff", "Nova responsabilidade: contato dos pais", enrol(["contato dos pais (Coordenação)"])),
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
