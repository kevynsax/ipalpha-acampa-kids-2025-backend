import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { stream } from "hono/streaming";
import { config } from "../config";
import { requireAuth } from "../middleware/auth";
import { requireAdmin } from "../middleware/roles";
import { aiUsageByVendor, recordAiUsage } from "../models/aiUsage";
import { resolveScope } from "../services/scope";
import { isEmojiLike } from "../utils";
import { runTool, toolSpecs } from "../services/aiTools";
import type { Role, SessionUser } from "../types";

interface Env {
  Variables: {
    userId: string;
    sessionId: string;
    activeRole: Role;
    user: SessionUser;
  };
}

/**
 * AI helper for the rich-text editor.
 *
 *   GET  /api/ai/models   the 3 models answering right now (primaries first, backups fill in)
 *   POST /api/ai/edit     { model, html, selection?, messages } → streams the rewritten HTML (text/plain)
 *   POST /api/ai/suggest  { html, context?, needTitle, needEmoji } → { title?, emoji? } (fills blanks after an AI edit)
 *   POST /api/ai/transcribe  multipart { file } → { text } (voice message recorded in the chat, whisper)
 *
 * Proxies the OpenAI-compatible gateway (AI_BASE_URL / AI_API_KEY) so the key
 * never reaches the browser. Same permission as uploading images: admin,
 * organizer or medical staff.
 */
const ai = new Hono<Env>();

/** company whose logo the editor shows beside the model name */
export type AiVendor = "anthropic" | "openai" | "xai" | "meta" | "zhipu";

/** shown in the editor, in this order (first = default) */
const PRIMARY_MODELS: { id: string; label: string; vendor: AiVendor }[] = [
  { id: "claude-fable-5-1", label: "Fable 5.1", vendor: "anthropic" },
  { id: "gpt-6-astra", label: "GPT Astra", vendor: "openai" },
  { id: "grok-4.6", label: "Grok 4.6", vendor: "xai" },
];
/** used to keep 3 options when a primary one is down */
const BACKUP_MODELS: { id: string; label: string; vendor: AiVendor }[] = [
  { id: "muse-spark-1.3", label: "Muse Spark 1.3", vendor: "meta" },
  { id: "glm-5.3", label: "GLM 5.3", vendor: "zhipu" },
];
export const AI_MODELS = [...PRIMARY_MODELS, ...BACKUP_MODELS];
const OFFERED = 3;

/** small, fast model used for title/emoji suggestions */
const SUGGEST_MODEL = "gpt-5.6-luna";
const SUGGEST_VENDOR: AiVendor = "openai";

const MAX_HTML = 200_000;
const MAX_MESSAGES = 20;
/** a chat message can carry a whole pasted document (HTML) */
const MAX_MESSAGE = 60_000;
/** pictures pasted into the chat (data urls, already shrunk by the app) */
const MAX_IMAGES = 4;
const MAX_IMAGE_CHARS = 3_000_000; // ~2 MB base64

/**
 * What the editor is being used for. Sent by the frontend so the prompt can
 * explain who reads the text and what shape it should have.
 */
export const AI_CONTEXTS = {
  instruction: {
    name: "Instruções gerais do acampamento",
    description:
      "Um documento grande que TODA a equipe de voluntários lê no celular, como 'Regras do acampamento', 'Plano de emergência', 'Rotina do dia', 'Horários das refeições'. É referência: a pessoa abre para consultar algo no meio da correria. Estrutura com títulos (h2/h3) por assunto, frases curtas e diretas, listas quando houver passos ou regras. Informações críticas (segurança, o que fazer em emergência, quem chamar) devem ficar em destaque e nunca ser removidas ou suavizadas.",
  },
  preparation: {
    name: "Preparação (antes do acampamento)",
    description:
      "Uma seção curta de checklist que cada voluntário lê e marca como feita ANTES de viajar, como 'O que levar', 'Chegada', 'Uniforme', 'Documentos'. Precisa ser objetiva e acionável: prefira listas com um item por linha, quantidades e horários explícitos, nada de texto longo.",
  },
  role_instructions: {
    name: "Instruções de uma função da escala",
    description:
      "O que a pessoa escalada em uma função específica deve fazer durante o evento (ex.: 'Inspeção dos quartos', 'Rádio', 'Cuidar das crianças na piscina', 'Pontuação'). É lido no celular minutos antes de assumir a função. Deve responder: o que fazer, onde ficar, com quem falar, o que observar e o que NÃO fazer. Passos numerados funcionam bem.",
  },
  role_preparation: {
    name: "Preparação de uma função da escala",
    description:
      "O que a pessoa escalada em uma função precisa providenciar ou levar antes do acampamento (materiais, roupas, treinamento). Checklist curto e acionável.",
  },
  occurrence: {
    name: "Registro de ocorrência",
    description:
      "Um registro permanente feito pela equipe médica ou pela organização sobre algo que aconteceu com uma ou mais crianças (queda, febre, alergia, medicação dada, conflito). Pode ser lido depois pelos pais e pela liderança. Tom factual, cronológico e respeitoso: o que aconteceu, quando, o que foi feito, quem acompanhou, orientações seguintes. Não invente fatos, horários, doses ou nomes; não faça diagnósticos que não estão no texto.",
  },
  generic: {
    name: "Texto do sistema do acampamento",
    description: "Um texto lido pela equipe do acampamento no celular. Claro, curto e bem organizado.",
  },
} as const;

export type AiContext = keyof typeof AI_CONTEXTS;

function systemPrompt(ctx: AiContext): string {
  const kind = AI_CONTEXTS[ctx];
  return `Você é o assistente de escrita embutido no editor de texto do sistema de gestão de um ACAMPAMENTO INFANTIL de igreja (Igreja Presbiteriana em Alphaville, São Paulo, Brasil).

## Sobre o sistema
- É um app de celular (PWA) usado durante um acampamento de fim de semana com cerca de 150 crianças e 70 voluntários adultos da equipe.
- Quem usa: a ORGANIZAÇÃO (admins/organizadores, que escrevem os textos), a EQUIPE de voluntários (monitores por quarto e por time, ajudantes de check-in e ônibus), a EQUIPE MÉDICA (enfermeiras/médicos voluntários) e os PAIS.
- O app cuida de: check-in das crianças na igreja e no ônibus, quartos e beliches, times, programação com escala de funções por evento, informações de saúde (alergias, medicações, restrições), ocorrências, e documentos que a equipe lê (instruções e preparação).
- Os textos são lidos em telas pequenas, muitas vezes com pressa, por voluntários que não são profissionais. Clareza e objetividade valem mais que elegância. Frases curtas, uma ideia por parágrafo, listas para passos e regras.
- Idioma: SEMPRE português do Brasil, com ortografia e acentuação corretas. Trate o leitor por "você".

## O que mais importa para a organização (guie TODA edição por isto)
1. SEGURANÇA DAS CRIANÇAS é a prioridade absoluta. Os pais confiaram os filhos à igreja por um fim de semana. Todo texto deve deixar claro, sem ambiguidade: quem é responsável por quais crianças em cada momento, onde as crianças podem e não podem estar, como contar as crianças e conferir presença, o que fazer e quem chamar em caso de emergência, acidente, criança perdida, alergia ou mal-estar. Regras de piscina, ônibus, quartos à noite, medicação e contato físico apropriado são inegociáveis. Nunca uma criança sozinha, nunca um adulto sozinho com uma criança fora da vista dos outros. Quando o texto tocar nesses assuntos, torne-o mais explícito e fácil de seguir, nunca mais vago.
2. ESPÍRITO DE VOLUNTARIADO: a equipe é formada por voluntários que doaram o fim de semana para servir as crianças. Os textos devem tratar cada um como parceiro valioso: explicar o porquê das regras (sem ordens secas), reconhecer o esforço, encorajar a iniciativa de ajudar onde for preciso, cuidar uns dos outros e das crianças com paciência, alegria e amor. Tom acolhedor, cordial e firme quando necessário, sem ser infantil, piegas ou autoritário. Nada de gírias, jargão técnico ou ironia.
3. O ambiente é cristão (igreja presbiteriana): valores de serviço, cuidado, respeito e exemplo para as crianças são naturais no texto quando fizer sentido, sem forçar linguagem religiosa em instruções práticas.

## O que está sendo editado agora
Tipo: ${kind.name}.
${kind.description}

## Prioridades ao editar
1. Segurança das crianças em primeiro lugar: nunca remova, resuma ou suavize avisos de segurança, supervisão, contagem de crianças, alergias, medicações, procedimentos de emergência, horários e contatos, mesmo que peçam para "resumir". Se precisar encurtar, encurte o resto. Se o texto original tiver uma lacuna óbvia de segurança (ex.: fala de piscina sem citar supervisão), não invente a regra: acrescente um marcador [CONFIRMAR: quem supervisiona?] para a organização decidir.
2. Não invente informações: nomes, horários, locais, telefones, regras, doses. Se o pedido exige um dado que não está no texto nem no pedido, deixe um marcador claro como [CONFIRMAR: horário] em vez de chutar.
3. Preserve o sentido e as decisões de quem escreveu. Você melhora a forma; não muda regras nem acrescenta regras novas por conta própria.
4. Faça exatamente o que foi pedido. "Corrija" = só ortografia/gramática. "Melhore" = clareza e fluidez mantendo o conteúdo. "Resuma" = menos texto, mesmas informações essenciais. "Em tópicos" = reorganize em lista. Se o pedido for vago, prefira a mudança mais conservadora.
5. Mantenha a estrutura existente (títulos, ordem das seções) a menos que o pedido seja reorganizar.

## Estilo do texto (obrigatório)
- Conciso e preciso: cada frase afirma uma coisa concreta. Corte introduções, conclusões, rodeios e frases de efeito.
- Nunca seja vago. Prefira "Conte as crianças ao entrar e ao sair da piscina" a "Fique atento às crianças". Prefira números, horários, locais e nomes de função a generalidades. Se o dado não existir, use o marcador [CONFIRMAR: …], não uma frase genérica.
- Nunca se repita: cada informação aparece UMA vez, no lugar certo. Não reafirme no fim o que já foi dito; não repita a mesma regra em duas seções; não escreva um parágrafo que só reformula o anterior.
- Sem enchimento: nada de "é importante lembrar que", "vale ressaltar", "como sabemos", "não esqueça de", "fique à vontade para". Vá direto à instrução.
- Voz ativa e imperativo direto ("Conte", "Leve", "Chame"), não "deve-se", "é recomendável", "procure".
- Um item de lista = uma ação ou um objeto. Um parágrafo = uma ideia. Se der para dizer em menos palavras com o mesmo sentido, diga.

## Informações do acampamento (ferramentas)
Você tem ferramentas de consulta só leitura (check-in, programação, funções, documentos, categorias, campos das fichas, contatos, quartos, equipe). Regra: consulte APENAS o fato que o texto vai citar e que não está no pedido. Exemplos: o texto fala do horário do check-in → get_checkin_info, e nada mais; o texto cita um time → get_categories. Um pedido típico precisa de zero ou uma consulta; nunca consulte "para ter mais contexto". Se o pedido já traz o conteúdo (texto colado ou imagem), não consulte nada além do fato estritamente necessário. NUNCA acrescente ao texto informações que vieram de uma consulta e que o usuário não pediu (telefones, nomes de organizadores, outros eventos da programação, regras de outros documentos). Ao consultar, pode escrever no máximo uma frase curta em português dizendo o que está fazendo (ex.: "Vou conferir o horário do check-in."). Esse texto aparece para o usuário como andamento e nunca entra no documento — por isso, nunca escreva nele trechos do documento, conclusões ou o texto final.

## Imagens e textos colados no pedido
- O documento, o trecho selecionado e o conteúdo colado chegam em HTML. Trate o HTML como a fonte principal: títulos (h2/h3), listas, negritos e links do que foi colado são estrutura INTENCIONAL do autor — preserve essa hierarquia (um título continua título, uma lista continua lista) em vez de reescrever tudo como parágrafos. Adapte apenas ao vocabulário de tags permitido abaixo.
- Quando o usuário anexa uma imagem (foto de comunicado, print de mensagem, cartaz), o CONTEÚDO DELA é a fonte principal do pedido. Leia tudo o que está escrito nela e baseie a resposta nisso.
- Se pedirem "uma versão para a equipe" de um comunicado, o resultado fala do MESMO assunto do original, com tamanho parecido e só os acréscimos que o usuário pediu. Não transforme um aviso curto em um manual: não acrescente seções, regras, horários ou contatos que não estão no original nem no pedido.

## Tamanho da resposta
O tamanho segue o pedido: um aviso vira um aviso, um manual vira um manual. Se o pedido cabe em três parágrafos, escreva três parágrafos. Nunca use o pedido como pretexto para escrever tudo o que sabe sobre o acampamento.

## Formato da resposta (obrigatório)
Você recebe o documento atual em HTML e o pedido. Responda SOMENTE com o HTML resultante: sem explicações, sem comentários, sem markdown, sem cercas de código, sem texto antes ou depois.
- Use apenas estas tags: p, br, strong, em, s, ul, ol, li, h2, h3, blockquote, a, hr, img, mark, details, summary. Nenhuma outra (nada de h1, span, table, style, class, atributos de estilo). Não existe controle de espaçamento, cor, fonte ou alinhamento: o app renderiza tudo com o visual padrão. Se pedirem algo assim, use o elemento de layout mais próximo abaixo ou devolva sem alteração.
- Use h2 para seções e h3 para subseções; nunca h1.

## Elementos de layout (o app estiliza; você só usa a tag certa)
- CAIXA DE DESTAQUE: <blockquote><p>…</p></blockquote>. A cor vem do PRIMEIRO caractere do texto: ✅ = cartão verde escuro (senha, resposta, confirmação final); 🔓 = caixa amarela (condição para liberar / próximo passo); ⚠️ = caixa vermelha (alerta, proibição); qualquer outro início = caixa amarela neutra. Padrão: <blockquote><p><strong>✅ TÍTULO CURTO</strong><br>conteúdo</p></blockquote>. No cartão verde a segunda linha em <strong> vira o texto grande (ex.: a senha).
- ETIQUETA/PÍLULA: <mark>texto curto</mark> — rótulo pequeno e arredondado, inline. Use para categoria, referência bíblica, horário, nome de time ("<mark>PROMESSA</mark>", "<mark>📖 Gênesis 15:5</mark>"). Várias pílulas cabem no mesmo parágrafo. Nunca para frases inteiras.
- SEÇÃO RECOLHÍVEL: <details open><summary>Título da seção</summary><div data-type="detailsContent">…blocos…</div></details>. O summary é só texto inline (pode ter <strong> e <mark>). Use quando o documento tem várias partes paralelas que a pessoa consulta uma por vez (bases, estações, dias, quartos). Sem o atributo open a seção começa fechada. Um details pode conter tudo menos outro details.
- Exemplo de uma base de gincana:
<details open><summary><strong>Base 1 — Abraão e Sara</strong> <mark>PROMESSA</mark></summary><div data-type="detailsContent"><p><mark>📖 Gênesis 15:5</mark> <mark>📖 Gênesis 17:5</mark></p><h3>🧩 Atividade</h3><p>As crianças deverão …</p><blockquote><p><strong>🔓 Pra liberar a equipe:</strong><br>Quando …</p></blockquote><blockquote><p><strong>✅ SENHA + REFERÊNCIA DA BASE</strong><br><strong>PROMESSA, GÊNESIS 15:5</strong></p></blockquote></div></details>
- Use <strong> para destacar o que é crítico (proibições, horários, alergias). Emojis são bem-vindos com moderação em títulos e itens de lista, pois ajudam a escanear no celular.
- Preserve TODAS as tags <img> exatamente como estão (mesmo src, alt e posição relativa ao conteúdo), a menos que o usuário peça explicitamente para removê-las. Nunca crie novas <img>.
- Preserve os links existentes (mesmo href). Não invente links.
- Se o pedido for sobre um TRECHO selecionado, devolva apenas o HTML que substitui esse trecho, coerente com o documento ao redor (mesmo nível de título, mesmo tipo de lista).
- Se o pedido não for uma edição possível (uma pergunta, um pedido sem relação com o texto, algo que exigiria inventar dados), devolva o documento sem alterações.`;
}

ai.use("*", requireAuth);

/**
 * GET /api/ai/models — the 3 models to offer right now. Every candidate gets a
 * tiny round trip in parallel; primaries that answer come first, backups fill
 * the gaps. If nothing answers, the primaries are listed anyway.
 */
/** GET /api/ai/usage — admin: totals per vendor for the settings "about" page */
ai.get("/usage", requireAdmin, async (c) => {
  return c.json({ vendors: await aiUsageByVendor() });
});

ai.get("/models", async (c) => {
  if (!config.ai.apiKey) return c.json({ enabled: false, models: [], transcribe: false });
  const results = await Promise.all(AI_MODELS.map(async (m) => ({ ...m, ...(await pingModel(m.id)) })));
  const healthy = results.filter((r) => r.ok).slice(0, OFFERED).map(({ id, label, vendor }) => ({ id, label, vendor }));
  const models = healthy.length ? healthy : PRIMARY_MODELS;
  console.log("AI models:", results.map((r) => `${r.id}=${r.ok ? `${r.ms}ms` : `down(${r.message})`}`).join(" "));
  return c.json({ enabled: true, models, transcribe: !!config.ai.transcribeUrl });
});

// same permission as uploading editor images: admin, organizer or medical staff
ai.use("/edit", async (c, next) => {
  const role = c.get("activeRole");
  if (role !== "admin") {
    if (role !== "staff" && role !== "health_staff") {
      return c.json({ error: { code: "FORBIDDEN", message: "Você não tem permissão para usar o assistente." } }, 403);
    }
    const scope = await resolveScope(c.get("user"));
    if (scope.all || (!scope.organizer && !scope.medical)) {
      return c.json({ error: { code: "FORBIDDEN", message: "Só a organização e a equipe médica podem usar o assistente." } }, 403);
    }
  }
  await next();
});
const editorGuard = createMiddleware<Env>(async (c, next) => {
  const role = c.get("activeRole");
  if (role !== "admin") {
    if (role !== "staff" && role !== "health_staff") return c.json({ error: { code: "FORBIDDEN", message: "Sem permissão." } }, 403);
    const scope = await resolveScope(c.get("user"));
    if (scope.all || (!scope.organizer && !scope.medical)) return c.json({ error: { code: "FORBIDDEN", message: "Sem permissão." } }, 403);
  }
  await next();
});
ai.use("/suggest", editorGuard);
ai.use("/transcribe", editorGuard);

ai.post("/edit", async (c) => {
  if (!config.ai.apiKey) return c.json({ error: { code: "AI_DISABLED", message: "Assistente de IA não configurado no servidor." } }, 503);

  const body = (await c.req.json().catch(() => null)) as
    | { model?: unknown; html?: unknown; selection?: unknown; messages?: unknown; context?: unknown; title?: unknown; images?: unknown }
    | null;
  if (!body) return c.json({ error: { code: "INVALID_JSON", message: "Corpo inválido." } }, 400);

  const model = AI_MODELS.find((m) => m.id === body.model);
  if (!model) return c.json({ error: { code: "AI_MODEL", message: "Modelo não disponível." } }, 400);
  const html = typeof body.html === "string" ? body.html : "";
  const selection = typeof body.selection === "string" && body.selection.trim() ? body.selection : null;
  const ctx: AiContext = typeof body.context === "string" && body.context in AI_CONTEXTS ? (body.context as AiContext) : "generic";
  const title = typeof body.title === "string" ? body.title.trim().slice(0, 120) : "";
  if (html.length > MAX_HTML || (selection?.length ?? 0) > MAX_HTML) {
    return c.json({ error: { code: "AI_TOO_LONG", message: "Documento grande demais para o assistente." } }, 413);
  }
  const messages = Array.isArray(body.messages)
    ? (body.messages as unknown[])
        .filter((m): m is { role: string; content: string } => {
          const x = m as { role?: unknown; content?: unknown };
          return (x.role === "user" || x.role === "assistant") && typeof x.content === "string" && x.content.trim().length > 0;
        })
        .slice(-MAX_MESSAGES)
        .map((m) => ({ role: m.role as "user" | "assistant", content: m.content.slice(0, MAX_MESSAGE) }))
    : [];
  if (!messages.length || messages[messages.length - 1].role !== "user") {
    return c.json({ error: { code: "AI_MESSAGE", message: "Escreva o que você quer que a IA faça." } }, 400);
  }
  const images = Array.isArray(body.images)
    ? (body.images as unknown[]).filter((u): u is string => typeof u === "string" && /^data:image\/(png|jpeg|webp|gif);base64,/.test(u) && u.length <= MAX_IMAGE_CHARS).slice(0, MAX_IMAGES)
    : [];

  const heading = title ? `TÍTULO DO DOCUMENTO (não faz parte do HTML, só contexto): ${title}\n\n` : "";
  const context =
    heading +
    (selection
      ? `DOCUMENTO COMPLETO (apenas contexto, não devolva):\n${html || "<p></p>"}\n\nTRECHO SELECIONADO (devolva apenas o HTML que substitui este trecho):\n${selection}`
      : html
        ? `DOCUMENTO ATUAL (devolva o documento completo atualizado):\n${html}`
        : "DOCUMENTO ATUAL: vazio. O usuário quer que você escreva o conteúdo inicial a partir do pedido, seguindo o tipo de documento descrito.");

  const convo: ChatMessage[] = [
    { role: "system", content: systemPrompt(ctx) },
    { role: "user", content: context },
    { role: "assistant", content: "Entendido. Qual é o pedido?" },
    ...messages,
  ];
  // pictures ride along with the latest request, so the model can read/describe them
  if (images.length) {
    const last = convo[convo.length - 1] as { role: "user"; content: string };
    convo[convo.length - 1] = {
      role: "user",
      content: [{ type: "text", text: last.content }, ...images.map((url) => ({ type: "image_url" as const, image_url: { url } }))],
    };
  }

  // first round is awaited before we commit to a 200, so gateway errors still come back as JSON
  const userId = c.get("userId");
  if (images.length) console.log(`AI ${model.id} with ${images.length} image(s)`);
  const usage = { promptTokens: 0, completionTokens: 0 };
  const first = await callModel(model.id, convo);
  if (!first.ok) {
    void recordAiUsage({ at: new Date(), vendor: model.vendor, model: model.id, kind: "edit", userId, promptTokens: 0, completionTokens: 0, ok: false });
    const message =
      first.code === "model_cooldown" || first.code === "usage_limit_reached"
        ? `${model.label} atingiu o limite de uso por agora. Tente outro modelo.`
        : "O assistente de IA não respondeu. Tente novamente.";
    return c.json({ error: { code: "AI_UPSTREAM", message } }, 502);
  }

  c.header("content-type", "text/plain; charset=utf-8");
  c.header("cache-control", "no-cache");
  c.header("x-accel-buffering", "no");
  return stream(c, async (out) => {
    let sent = 0;
    let finish = "";
    const used: string[] = [];
    let round = first;
    for (let i = 0; ; i++) {
      const r = await pumpStream(round.body, async (chunk) => {
        sent += chunk.length;
        await out.write(chunk);
      });
      finish = r.finish;
      usage.promptTokens += r.usage.promptTokens;
      usage.completionTokens += r.usage.completionTokens;
      if (!r.toolCalls.length || i >= MAX_TOOL_ROUNDS) break;
      // the model wants facts: run the tools, tell the panel, ask again
      convo.push({ role: "assistant", content: r.text || null, tool_calls: r.toolCalls.map((t) => ({ id: t.id, type: "function", function: { name: t.name, arguments: t.arguments || "{}" } })) });
      for (const t of r.toolCalls) {
        if (used.length >= MAX_TOOL_CALLS) {
          convo.push({ role: "tool", tool_call_id: t.id, content: JSON.stringify({ error: "Limite de consultas atingido. Responda agora com o que já tem." }) });
          continue;
        }
        used.push(t.name);
        // own line: whatever the model chattered before calling tools is discarded by the panel
        await out.write(`\n${TOOL_MARK}${TOOL_LABELS[t.name] ?? t.name}\n`);
        convo.push({ role: "tool", tool_call_id: t.id, content: await runTool(t.name, t.arguments) });
      }
      const next = await callModel(model.id, convo);
      if (!next.ok) {
        console.error("AI tool round failed", model.id, next.code);
        break;
      }
      round = next;
    }
    console.log(`AI ${model.id} ctx=${ctx} sel=${selection ? "y" : "n"} tools=[${used.join(",")}] → ${sent} chars (${finish || "no finish"}) tokens=${usage.promptTokens}+${usage.completionTokens}`);
    void recordAiUsage({ at: new Date(), vendor: model.vendor, model: model.id, kind: "edit", userId, ...usage, ok: true });
  });
});

// ── streaming helpers ──────────────────────────────────────────────────

type UserPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | UserPart[] }
  | { role: "assistant"; content: string | null; tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[] }
  | { role: "tool"; tool_call_id: string; content: string };

/** how many times the model may go fetch facts before it has to answer */
const MAX_TOOL_ROUNDS = 2;
/** how many distinct lookups per request — beyond this the model gets "answer now" */
const MAX_TOOL_CALLS = 3;
/**
 * Lines starting with this in the streamed body are status notes for the
 * panel ("consultando programação…"), not document text. The frontend strips
 * them. U+241E (SYMBOL FOR RECORD SEPARATOR) never occurs in real content.
 */
const TOOL_MARK = "\u241e";
const TOOL_LABELS: Record<string, string> = {
  get_app_overview: "como o app funciona",
  get_checkin_info: "horário do check-in",
  get_schedule: "programação",
  get_roles: "funções da escala",
  get_documents: "documentos existentes",
  get_categories: "times, veículos e opções",
  get_record_fields: "campos das fichas",
  get_contacts: "contatos importantes",
  get_bedrooms: "quartos",
  get_team_summary: "equipe",
};

async function callModel(modelId: string, messages: ChatMessage[]): Promise<{ ok: true; body: ReadableStream<Uint8Array> } | { ok: false; code?: string }> {
  const upstream = await fetch(`${config.ai.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.ai.apiKey}` },
    body: JSON.stringify({ model: modelId, stream: true, stream_options: { include_usage: true }, messages, tools: toolSpecs(), tool_choice: "auto" }),
  }).catch(() => null);
  if (!upstream || !upstream.ok || !upstream.body) {
    const detail = upstream ? await upstream.text().catch(() => "") : "";
    console.error("AI gateway error", upstream?.status, detail.slice(0, 300));
    let code: string | undefined;
    try {
      code = (JSON.parse(detail) as { error?: { code?: string } }).error?.code;
    } catch {
      /* not json */
    }
    return { ok: false, code };
  }
  return { ok: true, body: upstream.body };
}

interface ToolCallAcc {
  id: string;
  name: string;
  arguments: string;
}

/** Reads an OpenAI SSE stream: forwards text deltas, accumulates tool calls. */
async function pumpStream(
  body: ReadableStream<Uint8Array>,
  onText: (chunk: string) => Promise<void>,
): Promise<{ text: string; toolCalls: ToolCallAcc[]; finish: string; usage: { promptTokens: number; completionTokens: number } }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let finish = "";
  const usage = { promptTokens: 0, completionTokens: 0 };
  const calls: ToolCallAcc[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const raw of lines) {
        const line = raw.trim();
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") return { text, toolCalls: calls, finish, usage };
        try {
          const json = JSON.parse(data) as {
            choices?: { delta?: { content?: string | null; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string | null }[];
            usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
            error?: unknown;
          };
          if (json.error) console.error("AI stream error", JSON.stringify(json.error).slice(0, 300));
          if (json.usage) {
            usage.promptTokens = json.usage.prompt_tokens ?? usage.promptTokens;
            usage.completionTokens = json.usage.completion_tokens ?? usage.completionTokens;
          }
          const choice = json.choices?.[0];
          if (choice?.finish_reason) finish = choice.finish_reason;
          const chunk = choice?.delta?.content;
          if (chunk) {
            text += chunk;
            await onText(chunk);
          }
          for (const tc of choice?.delta?.tool_calls ?? []) {
            const idx = tc.index ?? calls.length;
            if (!calls[idx]) calls[idx] = { id: tc.id ?? `call_${idx}`, name: "", arguments: "" };
            if (tc.id) calls[idx].id = tc.id;
            if (tc.function?.name) calls[idx].name = tc.function.name;
            if (tc.function?.arguments) calls[idx].arguments += tc.function.arguments;
          }
        } catch {
          /* keep-alive / partial line */
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  return { text, toolCalls: calls.filter(Boolean), finish, usage };
}

const PING_TIMEOUT_MS = 15_000;

/** Tiny round trip: is this model answering right now? */
async function pingModel(id: string): Promise<{ ok: boolean; ms: number; message?: string }> {
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PING_TIMEOUT_MS);
  try {
    const res = await fetch(`${config.ai.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.ai.apiKey}` },
      body: JSON.stringify({ model: id, max_tokens: 5, messages: [{ role: "user", content: "Responda apenas: ok" }] }),
      signal: ctrl.signal,
    });
    const ms = Date.now() - started;
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      let code: string | undefined;
      try {
        code = (JSON.parse(detail) as { error?: { code?: string } }).error?.code;
      } catch {
        /* not json */
      }
      return { ok: false, ms, message: code ?? `http ${res.status}` };
    }
    const data = (await res.json().catch(() => null)) as { choices?: unknown[] } | null;
    // reasoning models may spend the 5 tokens thinking; a 200 with a choice still means "answering"
    const answered = Array.isArray(data?.choices) && data.choices.length > 0;
    return { ok: answered, ms, message: answered ? undefined : "empty" };
  } catch (err) {
    return { ok: false, ms: Date.now() - started, message: (err as Error)?.name === "AbortError" ? "timeout" : "unreachable" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * POST /api/ai/suggest — after the assistant edits a document whose title /
 * emoji are still blank, the frontend asks for suggestions. Non-streaming,
 * small fast model, JSON in/out.
 */
ai.post("/suggest", async (c) => {
  if (!config.ai.apiKey) return c.json({ error: { code: "AI_DISABLED", message: "Assistente de IA não configurado no servidor." } }, 503);
  const body = (await c.req.json().catch(() => null)) as
    | { html?: unknown; context?: unknown; needTitle?: unknown; needEmoji?: unknown }
    | null;
  const html = typeof body?.html === "string" ? body.html : "";
  const needTitle = body?.needTitle === true;
  const needEmoji = body?.needEmoji === true;
  if (!html.trim() || (!needTitle && !needEmoji)) return c.json({});
  if (html.length > MAX_HTML) return c.json({ error: { code: "AI_TOO_LONG", message: "Documento grande demais." } }, 413);
  const ctx: AiContext = typeof body?.context === "string" && body.context in AI_CONTEXTS ? (body.context as AiContext) : "generic";

  const wants = [needTitle && '"title": título curto (2 a 5 palavras, português do Brasil, sem ponto final, sem emoji)', needEmoji && '"emoji": UM único emoji que represente o assunto']
    .filter(Boolean)
    .join(" e ");
  const upstream = await fetch(`${config.ai.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.ai.apiKey}` },
    body: JSON.stringify({
      model: SUGGEST_MODEL,
      reasoning_effort: "high",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `Você nomeia documentos do app de um acampamento infantil de igreja. Tipo do documento: ${AI_CONTEXTS[ctx].name}. Leia o HTML e responda SOMENTE um objeto JSON com ${wants}. Seja específico ao conteúdo (ex.: "Regras da piscina", não "Instruções").`,
        },
        { role: "user", content: html.slice(0, 20_000) },
      ],
    }),
  }).catch(() => null);
  if (!upstream?.ok) {
    console.error("AI suggest error", upstream?.status, (await upstream?.text().catch(() => ""))?.slice(0, 300));
    void recordAiUsage({ at: new Date(), vendor: SUGGEST_VENDOR, model: SUGGEST_MODEL, kind: "suggest", userId: c.get("userId"), promptTokens: 0, completionTokens: 0, ok: false });
    return c.json({});
  }
  const data = (await upstream.json().catch(() => null)) as { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } } | null;
  void recordAiUsage({
    at: new Date(),
    vendor: SUGGEST_VENDOR,
    model: SUGGEST_MODEL,
    kind: "suggest",
    userId: c.get("userId"),
    promptTokens: data?.usage?.prompt_tokens ?? 0,
    completionTokens: data?.usage?.completion_tokens ?? 0,
    ok: true,
  });
  const raw = data?.choices?.[0]?.message?.content ?? "";
  let parsed: { title?: unknown; emoji?: unknown } = {};
  try {
    parsed = JSON.parse(raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
  } catch {
    console.error("AI suggest: bad json", raw.slice(0, 200));
  }
  const title = needTitle && typeof parsed.title === "string" ? parsed.title.trim().replace(/\.$/, "").slice(0, 80) : undefined;
  const emoji = needEmoji && typeof parsed.emoji === "string" && isEmojiLike(parsed.emoji.trim()) ? parsed.emoji.trim() : undefined;
  return c.json({ ...(title ? { title } : {}), ...(emoji ? { emoji } : {}) });
});

/** voice messages: browsers record webm/opus (Chrome, Firefox) or mp4/aac (Safari) */
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const AUDIO_TYPES = /^audio\/|^video\/(webm|mp4|ogg|quicktime)|^application\/(octet-stream|ogg)|^$/;

/**
 * POST /api/ai/transcribe — a voice message recorded in the chat input.
 * Proxies the OpenAI-compatible speech-to-text (AI_TRANSCRIBE_URL) and returns
 * the Portuguese text so the user can review it before sending.
 */
ai.post("/transcribe", async (c) => {
  if (!config.ai.transcribeUrl) return c.json({ error: { code: "AI_DISABLED", message: "Transcrição de áudio não configurada no servidor." } }, 503);
  const form = await c.req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File) || !file.size) return c.json({ error: { code: "AUDIO_MISSING", message: "Envie o áudio no campo 'file'." } }, 400);
  if (!AUDIO_TYPES.test(file.type)) {
    console.error("AI transcribe: unsupported type", JSON.stringify(file.type), file.name);
    return c.json({ error: { code: "AUDIO_TYPE", message: `Formato de áudio não suportado (${file.type || "desconhecido"}).` } }, 415);
  }
  if (file.size > MAX_AUDIO_BYTES) return c.json({ error: { code: "AUDIO_TOO_LARGE", message: "Áudio muito grande (máx. 10 MB)." } }, 413);

  const type = file.type || "audio/webm";
  const ext = type.includes("mp4") || type.includes("quicktime") ? "m4a" : type.includes("ogg") ? "ogg" : type.includes("wav") ? "wav" : type.includes("mpeg") || type.includes("mp3") ? "mp3" : "webm";
  const upstreamForm = new FormData();
  upstreamForm.append("file", file, `voice.${ext}`);
  upstreamForm.append("model", config.ai.transcribeModel);
  upstreamForm.append("language", "pt");
  upstreamForm.append("response_format", "json");

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 90_000);
  try {
    const upstream = await fetch(`${config.ai.transcribeUrl}/audio/transcriptions`, {
      method: "POST",
      headers: config.ai.transcribeKey ? { authorization: `Bearer ${config.ai.transcribeKey}` } : {},
      body: upstreamForm,
      signal: ctrl.signal,
    });
    if (!upstream.ok) {
      console.error("AI transcribe error", upstream.status, (await upstream.text().catch(() => "")).slice(0, 300));
      return c.json({ error: { code: "AI_UPSTREAM", message: "Não foi possível transcrever o áudio." } }, 502);
    }
    const data = (await upstream.json().catch(() => null)) as { text?: unknown } | null;
    const text = typeof data?.text === "string" ? data.text.trim() : "";
    return c.json({ text });
  } catch (err) {
    console.error("AI transcribe failed", err);
    return c.json({ error: { code: "AI_UPSTREAM", message: "A transcrição demorou demais ou falhou." } }, 502);
  } finally {
    clearTimeout(timer);
  }
});

export default ai;
