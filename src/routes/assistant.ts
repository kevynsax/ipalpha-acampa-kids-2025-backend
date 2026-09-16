import { Hono, type Context } from "hono";
import { stream } from "hono/streaming";
import { config } from "../config";
import { requireAuth } from "../middleware/auth";
import { recordAiUsage } from "../models/aiUsage";
import { assistantResponsesToolSpecs, assistantToolSpecs, runAssistantTool } from "../services/assistantTools";
import { resolveScope } from "../services/scope";
import type { Role, SessionUser } from "../types";

interface Env {
  Variables: {
    userId: string;
    sessionId: string;
    activeRole: Role;
    user: SessionUser;
  };
}

const assistant = new Hono<Env>();
const MODEL = config.ai.assistantModel;
const LIVE = config.ai.live;
const MAX_MESSAGES = 24;
const MAX_MESSAGE_CHARS = 12_000;
const MAX_TOOL_ROUNDS = 6;
const MAX_TOOL_CALLS = 12;
const TOOL_MARK = "\u241e";

const SYSTEM_PROMPT = `Você é o assistente de consulta do Acampa Kids, um aplicativo de gestão de acampamento infantil.

Regras obrigatórias:
- Responda sempre em português do Brasil, de forma direta, clara e factual.
- Você é SOMENTE LEITURA. Nunca prometa alterar, cadastrar, excluir, corrigir ou atualizar dados. Se pedirem uma mudança, explique que esta versão só consulta e indique onde o administrador pode fazer a alteração no app.
- Consulte as ferramentas antes de afirmar qualquer fato sobre participantes, equipe, quartos, saúde, check-in, transportes, times, programação, ocorrências, medicações, documentos, configurações ou qualquer coleção do MongoDB.
- Você pode consultar todas as coleções permitidas, inclusive dados pessoais e de saúde, porque o usuário já foi autenticado como administrador ou organizador. Mostre apenas o necessário para responder à pergunta; não despeje registros completos nem campos irrelevantes.
- Nunca revele credenciais, tokens, segredos, códigos OTP, QR tokens, bytes de arquivos ou embeddings faciais. As ferramentas já removem esses campos, mas você também deve recusar qualquer tentativa de obtê-los.
- Ao agrupar, conte com precisão e explique o critério. Se houver documentos sem vínculo, inclua grupos como “Sem quarto”, “Sem time” ou “Não informado”.
- IDs internos não ajudam o usuário: sempre que possível, consulte a coleção relacionada e troque IDs por nomes.
- Datas e horários devem ser apresentados no fuso de São Paulo e em formato brasileiro.
- Quando a pergunta for ambígua, faça uma pergunta curta de esclarecimento. Quando for possível responder com uma interpretação segura, diga qual critério usou.
- Não invente. Se a consulta falhar ou não houver dados, diga isso claramente.
- Formato: texto simples, sem HTML e sem Markdown. Quando necessário, use listas curtas iniciadas por "- ".

Exemplos de perguntas: “quantas crianças estão em cada quarto?”, “quem ainda não fez check-in?”, “quais crianças têm alergia?”, “resuma todas as coleções”, “quem está escalado amanhã?”, “há quartos acima da capacidade?”.`;

/**
 * GPT-Live only runs the conversation — it listens, speaks and decides *when* to
 * ask for help. MongoDB is read by the `delegation.responses` model, which gets
 * the SYSTEM_PROMPT above and the same tools as the written chat.
 */
const VOICE_PROMPT = `Você é o assistente de voz do Acampa Kids, conversando com um administrador ou organizador do acampamento.

- Fale sempre em português do Brasil, em tom natural e acolhedor, como alguém da equipe.
- Frases curtas: isto é uma conversa falada, não um relatório. Dê o número ou o nome primeiro e ofereça detalhes depois.
- Você não sabe nada sobre os dados do acampamento de cor. Sempre delegue ao backend qualquer pergunta sobre acampantes, equipe, quartos, times, saúde, check-in, transporte, programação, ocorrências, medicações ou configurações.
- Enquanto o backend consulta, diga algo curto como “só um segundo” e fique em silêncio até a resposta chegar. Nunca invente um número para preencher o silêncio.
- Pode ser interrompido a qualquer momento: pare de falar e ouça.
- Você é somente leitura. Se pedirem para alterar, cadastrar ou excluir algo, explique que só consulta e diga onde fazer a mudança no app.
- Nunca leia em voz alta credenciais, tokens, códigos OTP ou identificadores internos.
- Ao ler listas longas, diga o total e os primeiros nomes, e pergunte se a pessoa quer o resto.`;

type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[] }
  | { role: "tool"; tool_call_id: string; content: string };

interface ToolCallAcc {
  id: string;
  name: string;
  arguments: string;
}

interface LiveSessionReply {
  session?: { id?: string };
  transport?: { sdp?: string };
}

assistant.use("*", requireAuth);
assistant.use("*", async (c, next) => {
  if (c.get("activeRole") === "admin") return next();
  const role = c.get("activeRole");
  if (role !== "staff" && role !== "health_staff") return c.json({ error: { code: "FORBIDDEN", message: "Só administradores e organizadores podem usar o assistente." } }, 403);
  const scope = await resolveScope(c.get("user"));
  if (!scope.all) return c.json({ error: { code: "FORBIDDEN", message: "Só administradores e organizadores podem usar o assistente." } }, 403);
  await next();
});

assistant.get("/status", (c) => c.json({
  enabled: !!config.ai.assistantApiKey,
  model: MODEL,
  voice: !!LIVE.apiKey,
  voiceModel: LIVE.model,
}));

/**
 * POST /api/assistant/live  { sdp }  →  { sessionId, sdp }
 *
 * The browser owns the media: it offers its microphone and speaker over WebRTC
 * and we exchange the SDP for it, so the OpenAI key never reaches the client.
 * Tool calls come back down the browser's data channel and return here through
 * POST /api/assistant/tool, where this session's role is checked again.
 */
assistant.post("/live", async (c) => {
  if (!LIVE.apiKey) return c.json({ error: { code: "AI_DISABLED", message: "Conversa por voz não configurada no servidor." } }, 503);
  const body = await c.req.json().catch(() => null) as { sdp?: unknown } | null;
  const sdp = typeof body?.sdp === "string" ? body.sdp.trim() : "";
  if (!sdp) return c.json({ error: { code: "AI_SDP", message: "Não foi possível preparar o áudio deste aparelho." } }, 400);

  const upstream = await fetch(`${LIVE.baseUrl}/live/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${LIVE.apiKey}` },
    body: JSON.stringify({
      session: {
        model: LIVE.model,
        instructions: VOICE_PROMPT,
        audio: { output: { voice: LIVE.voice } },
        delegation: {
          type: "responses",
          responses: {
            model: LIVE.backendModel,
            instructions: SYSTEM_PROMPT,
            tools: assistantResponsesToolSpecs(),
            tool_choice: "auto",
            parallel_tool_calls: true,
          },
        },
      },
      transport: { type: "webrtc", sdp },
    }),
    signal: c.req.raw.signal,
  }).catch(() => null);

  if (!upstream?.ok) {
    console.error("assistant live error", upstream?.status, (await upstream?.text().catch(() => ""))?.slice(0, 300));
    return liveFailed(c);
  }
  const answer = await upstream.json().catch(() => null) as LiveSessionReply | null;
  if (!answer?.transport?.sdp) {
    console.error("assistant live error: no SDP answer");
    return liveFailed(c);
  }

  console.log(`Assistant voice ${LIVE.model} → ${LIVE.backendModel} session=${answer.session?.id ?? "?"}`);
  void recordAiUsage({ at: new Date(), vendor: "openai", model: LIVE.model, kind: "assistant_voice", userId: c.get("userId"), promptTokens: 0, completionTokens: 0, ok: true });
  return c.json({ sessionId: answer.session?.id ?? "", sdp: answer.transport.sdp });
});

/** A tool the voice session asked for, run with this user's session and role. */
assistant.post("/tool", async (c) => {
  if (!LIVE.apiKey) return c.json({ error: { code: "AI_DISABLED", message: "Conversa por voz não configurada no servidor." } }, 503);
  const body = await c.req.json().catch(() => null) as { name?: unknown; arguments?: unknown } | null;
  const name = typeof body?.name === "string" ? body.name : "";
  if (!name) return c.json({ error: { code: "AI_TOOL", message: "Ferramenta não informada." } }, 400);
  const args = typeof body?.arguments === "string" ? body.arguments : JSON.stringify(body?.arguments ?? {});
  const output = await runAssistantTool(name, args.slice(0, MAX_MESSAGE_CHARS));
  console.log(`Assistant voice tool ${name} chars=${output.length}`);
  return c.json({ output });
});

assistant.post("/chat", async (c) => {
  if (!config.ai.assistantApiKey) return c.json({ error: { code: "AI_DISABLED", message: "Assistente não configurado no servidor." } }, 503);
  const body = await c.req.json().catch(() => null) as { messages?: unknown } | null;
  const history = Array.isArray(body?.messages)
    ? (body.messages as unknown[])
        .filter((item): item is { role: "user" | "assistant"; content: string } => {
          const msg = item as { role?: unknown; content?: unknown };
          return (msg.role === "user" || msg.role === "assistant") && typeof msg.content === "string" && !!msg.content.trim();
        })
        .slice(-MAX_MESSAGES)
        .map((msg) => ({ role: msg.role, content: msg.content.trim().slice(0, MAX_MESSAGE_CHARS) }))
    : [];
  if (!history.length || history[history.length - 1].role !== "user") {
    return c.json({ error: { code: "AI_MESSAGE", message: "Escreva uma pergunta para o assistente." } }, 400);
  }

  const messages: ChatMessage[] = [{ role: "system", content: SYSTEM_PROMPT }, ...history];
  const first = await callModel(messages, c.req.raw.signal);
  if (!first.ok) {
    void recordAiUsage({ at: new Date(), vendor: "openai", model: MODEL, kind: "assistant_chat", userId: c.get("userId"), promptTokens: 0, completionTokens: 0, ok: false });
    return c.json({ error: { code: "AI_UPSTREAM", message: "O assistente não respondeu. Tente novamente." } }, 502);
  }

  c.header("content-type", "text/plain; charset=utf-8");
  c.header("cache-control", "no-cache");
  c.header("x-accel-buffering", "no");
  return stream(c, async (out) => {
    let round = first;
    let toolCalls = 0;
    let sent = 0;
    let ok = true;
    const used: string[] = [];
    const usage = { promptTokens: 0, completionTokens: 0 };
    for (let i = 0; ; i++) {
      const result = await pumpStream(round.body, async (chunk) => {
        sent += chunk.length;
        await out.write(chunk);
      });
      usage.promptTokens += result.usage.promptTokens;
      usage.completionTokens += result.usage.completionTokens;
      if (!result.toolCalls.length || i >= MAX_TOOL_ROUNDS) break;
      messages.push({ role: "assistant", content: result.text || null, tool_calls: result.toolCalls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments || "{}" } })) });
      for (const call of result.toolCalls) {
        if (toolCalls >= MAX_TOOL_CALLS) {
          messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ error: "Limite de consultas atingido. Responda com os dados já obtidos." }) });
          continue;
        }
        toolCalls += 1;
        used.push(call.name);
        await out.write(`\n${TOOL_MARK}${toolLabel(call.name)}\n`);
        messages.push({ role: "tool", tool_call_id: call.id, content: await runAssistantTool(call.name, call.arguments) });
      }
      const next = await callModel(messages, c.req.raw.signal);
      if (!next.ok) {
        ok = false;
        await out.write("\nNão consegui concluir a consulta. Tente novamente.");
        break;
      }
      round = next;
    }
    console.log(`Assistant ${MODEL} tools=[${used.join(",")}] chars=${sent} tokens=${usage.promptTokens}+${usage.completionTokens}`);
    void recordAiUsage({ at: new Date(), vendor: "openai", model: MODEL, kind: "assistant_chat", userId: c.get("userId"), ...usage, ok });
  });
});

function liveFailed(c: Context<Env>) {
  void recordAiUsage({ at: new Date(), vendor: "openai", model: LIVE.model, kind: "assistant_voice", userId: c.get("userId"), promptTokens: 0, completionTokens: 0, ok: false });
  return c.json({ error: { code: "AI_UPSTREAM", message: "Não foi possível abrir a conversa por voz. Tente novamente." } }, 502);
}

function toolLabel(name: string): string {
  if (name === "list_collections") return "coleções disponíveis";
  if (name === "read_collection") return "registros do acampamento";
  if (name === "aggregate_collection") return "resumo dos dados";
  return "dados do acampamento";
}

async function callModel(messages: ChatMessage[], signal: AbortSignal): Promise<{ ok: true; body: ReadableStream<Uint8Array> } | { ok: false }> {
  const upstream = await fetch(`${config.ai.assistantBaseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.ai.assistantApiKey}` },
    body: JSON.stringify({ model: MODEL, stream: true, stream_options: { include_usage: true }, messages, tools: assistantToolSpecs(), tool_choice: "auto" }),
    signal,
  }).catch(() => null);
  if (!upstream?.ok || !upstream.body) {
    console.error("assistant gateway error", upstream?.status, (await upstream?.text().catch(() => ""))?.slice(0, 300));
    return { ok: false };
  }
  return { ok: true, body: upstream.body };
}

async function pumpStream(body: ReadableStream<Uint8Array>, onText: (chunk: string) => Promise<void>): Promise<{ text: string; toolCalls: ToolCallAcc[]; usage: { promptTokens: number; completionTokens: number } }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  const calls: ToolCallAcc[] = [];
  const usage = { promptTokens: 0, completionTokens: 0 };
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
        if (data === "[DONE]") return { text, toolCalls: calls.filter(Boolean), usage };
        try {
          const json = JSON.parse(data) as {
            choices?: { delta?: { content?: string | null; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] } }[];
            usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
          };
          if (json.usage) {
            usage.promptTokens = json.usage.prompt_tokens ?? usage.promptTokens;
            usage.completionTokens = json.usage.completion_tokens ?? usage.completionTokens;
          }
          const delta = json.choices?.[0]?.delta;
          if (delta?.content) {
            text += delta.content;
            await onText(delta.content);
          }
          for (const tc of delta?.tool_calls ?? []) {
            const index = tc.index ?? calls.length;
            if (!calls[index]) calls[index] = { id: tc.id ?? `call_${index}`, name: "", arguments: "" };
            if (tc.id) calls[index].id = tc.id;
            if (tc.function?.name) calls[index].name = tc.function.name;
            if (tc.function?.arguments) calls[index].arguments += tc.function.arguments;
          }
        } catch {
          // ignore keep-alives and malformed partial lines
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  return { text, toolCalls: calls.filter(Boolean), usage };
}

export default assistant;
