/**
 * Hand audit of the production campers after the xlsx import: the raw
 * "Observações médicas" dump ("Peso: … | Convênio médico: … | Prefere dividir
 * quarto com: …") landed whole in `healthNotes`, although every part already
 * lives in its own field (weightKg, insurance, insuranceCard, medicines,
 * generalNotes, bedroomPreference, chips).
 *
 * Every kid was reviewed one by one (12 Sep 2026). Rules applied:
 *   • healthNotes  ← ONLY free-text medical info not already carried by the
 *                    chips / medicines (crisis protocols, cardiac details…)
 *   • foodRestrictions ← anything about eating / drinking
 *   • generalNotes ← non-medical care info (bed, sleep, behaviour, groups)
 *   • bedroomPreference ← names only ("N/A", "indicarei depois" → empty)
 *   • chips added where the text names an allergy / condition we have
 *   • neurodivergent ← explicit TDAH / TEA
 *   • weightKg fixed where "26kkg" / "40kgkg" broke the parser
 *   • insurance / insuranceCard: "Sim" / "Não" / "Não tem" / Excel-mangled
 *     numbers → empty
 * Kids not listed in FIX only get `healthNotes` cleared (it was a pure
 * duplicate of the other fields).
 *
 *   bun run src/scripts/auditCampersByHand.ts [--dry]
 */
import { closeDb, getDb } from "../db";
import { findCategoryByKey } from "../models/categories";

const DRY = process.argv.includes("--dry");

interface Fix {
  healthNotes?: string;
  generalNotes?: string;
  foodRestrictions?: string;
  bedroomPreference?: string;
  insurance?: string;
  insuranceCard?: string;
  weightKg?: number;
  neurodivergent?: boolean;
  /** chip LABELS to add (resolved against the categories) */
  addAllergies?: string[];
  addHealthIssues?: string[];
}

const FIX: Record<string, Fix> = {
  "Adam Jala Lucas": {
    generalNotes: "",
    foodRestrictions: "Não come nada com queijo (nenhum tipo), requeijão, manteiga, margarina, molho branco (não é alérgico, mas não come).",
  },
  "Arthur Gouveia do Nascimento": {
    healthNotes: "Em caso de crise de rinite, pode dar antialérgico (tipo Alegra D), 5ml — não tem alergia ao medicamento.",
    generalNotes: "",
  },
  "ANDRE LUCCA ZAUDE": {
    healthNotes:
      "Valva aórtica bicúspide, com insuficiência discreta e ectasia de aorta ascendente. Antibioticoterapia profilática APENAS se necessário procedimento cruento: Amoxil (500mg/5ml) 17ml via oral 60 min antes.",
    insurance: "",
  },
  "Antônio José Barbosa Guimarães Neto": {
    generalNotes: "TDAH — a mãe irá enviar abafador e o brinquedo de autorregulação emocional.",
    neurodivergent: true,
  },
  "Benício Massa Nogueira": {
    healthNotes: "Asma controlada sem medicação há 1 ano; crises cada vez mais raras. Se acontecer: 5 puffs de Aerolin com espaçador, 10 segundos entre os jatos.",
    generalNotes:
      "Às vezes tem episódios de sonambulismo: anda pelo quarto de olhos abertos, não conversa, mas entende quando falam com ele — basta pedir para deitar de novo. Atenção às portas: já tentou abrir a porta para sair de casa sonâmbulo.",
  },
  "Antonella De Mendonça Bilck": {
    generalNotes: "Dormir na parte de cima da beliche somente se tiver proteção fixa lateral.",
    foodRestrictions: "Um pouco seletiva com a alimentação.",
  },
  "Bernardo Gouveia do Nascimento": {
    healthNotes: "Em caso de crise de rinite, dar antialérgico (ideal incolor), 5ml — não tem alergia ao medicamento.",
    generalNotes: "",
  },
  "Antonela Odilon de Barros Lemos": { bedroomPreference: "" },
  "Antonella Novais": { healthNotes: "Picada de formiga: precisa ser medicada com antialérgico imediatamente." },
  "BERNARDO TINOCO ROCHA": {
    generalNotes: "Episódios raros de terror noturno: acender as luzes, oferecer água e levar ao banheiro. Normalmente volta ao sono tranquilamente.",
  },
  "Clara Barros": { bedroomPreference: "", generalNotes: "Dormir na parte de cima da beliche apenas se tiver proteção." },
  "Daniel martin ariozo Faleiros": { healthNotes: "Aerolin se ele sentir necessidade.", generalNotes: "" },
  "Daniel Camargo Leite": { foodRestrictions: "Amendoim puro ou alimentos que possam conter amendoim (nunca passou mal)." },
  "Clarice Bernardino Simões": { insurance: "" },
  "Daniel Abreu Harbich": { healthNotes: "Otite de repetição — pode se incomodar com ruído forte.", generalNotes: "", foodRestrictions: "Alergia a lactose." },
  "Davi Carvalho Evangelista de Souza": {
    weightKg: 26,
    bedroomPreference: "",
    generalNotes: "Colocar no mesmo grupo de brincadeiras da Manuela Figueiredo Gomes (sobrinha).",
  },
  "Eduardo Sabbato MACHADO": {
    generalNotes:
      "Não dormir na parte de cima da beliche (vira dormindo). Ficar próximo aos amigos Vinicius Moraes (Larissa Rebelo) e Nicole Constantin (Tais Constantin), que estão dando suporte para a decisão de ir.",
  },
  "Guilherme Carielo": { bedroomPreference: "Bernardo Santana (pais: Gustavo e Lívia) e César Milano" },
  "Heitor NAZATO": { weightKg: 20, insurance: "", insuranceCard: "" },
  "Helena Silva Luiz": { weightKg: 15 },
  "Isabela Magheli da Silva": { weightKg: 23 },
  "Isabela Rios Berbert": { healthNotes: "Diabetes tipo 1: avaliar glicemia e aplicar insulina antes de cada refeição.", generalNotes: "" },
  "João de Souza Rodrigues": {
    generalNotes: "",
    foodRestrictions: "Intolerância à lactose — tolera pequenas quantidades nas refeições; a mãe envia comprimidos para usar se necessário.",
    addAllergies: ["Lactose / leite"],
  },
  "Luca de Souza Rodrigues": {
    generalNotes: "",
    foodRestrictions: "Intolerância à lactose — tolera pequenas quantidades nas refeições; a mãe envia comprimidos para usar se necessário.",
    addAllergies: ["Lactose / leite"],
  },
  "Isaque Santos Moura": { generalNotes: "", foodRestrictions: "Só bebe suco de laranja ou água." },
  "LAURA CARMONA DA MATTA": { foodRestrictions: "Alergia a peixes e derivados do mar." },
  "Lucas Vilela Rosa": { foodRestrictions: "Alergia a glúten e corante azul." },
  "Lucca Ferreira Nishida": { weightKg: 38 },
  "Luísa Bernardino Simões": { insuranceCard: "" },
  "Lorena Dias Vasconcelos Bispo": {
    healthNotes: "Em caso de crise asmática: 4 puffs de Aerolin contando até 10; repetir mais 3 vezes de 20 em 20 minutos.",
    generalNotes: "",
  },
  "Lilliam Monteiro Ramos": { generalNotes: "", addAllergies: ["Picada de inseto"] },
  "Octávio Conte Gemmi": { healthNotes: "Usa Salbutamol e antialérgico quando tem crises.", generalNotes: "", weightKg: 40, insurance: "" },
  "Pedro Hawthorne": { addAllergies: ["Rinite alérgica"] },
  "Mateus Fernandes de Melo": { generalNotes: "", foodRestrictions: "Alergia apenas a leite com lactose.", addAllergies: ["Lactose / leite"] },
  "Rafael Saraiva Tanganelli": { bedroomPreference: "" },
  "Rafael Senra": { healthNotes: "Cardiopatia congênita — insuficiência da válvula pulmonar." },
  "Rafael Fernandes Gonçalves": { healthNotes: "Alergia a água muito gelada.", generalNotes: "", weightKg: 30 },
  "Olivia Heringer Vargas": { foodRestrictions: "Alergia leve a glúten." },
  "Pedro Siqueira Bastos": { generalNotes: "", addAllergies: ["Rinite alérgica", "Poeira / mofo"] },
  "Sofia Vitória Barbosa Bovério da Silva Gomes": { neurodivergent: true },
  "Tiago de Moraes Fim": { healthNotes: "Às vezes é necessário fazer bombinha quando está com crise de asma.", generalNotes: "", addHealthIssues: ["Asma"] },
  "Theodoro Beber Rocha": { weightKg: 13, insuranceCard: "" /* "5.57888884909929E+019" — Excel-mangled, ask the parent */ },
  "VITORIA CREMONESI WINAND": { foodRestrictions: "Alergia a frutos do mar." },
  "Nicole De Lima Alves": { bedroomPreference: "Beatriz Molina (é convidada dela)" },
};

const norm = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
const lc = (s: string) => s.toLocaleLowerCase("pt-BR");

async function main() {
  const db = await getDb();
  const [allergies, conditions] = await Promise.all([findCategoryByKey("alergias"), findCategoryByKey("condicao-cronica")]);
  if (!allergies || !conditions) throw new Error("categories missing");
  const optId = (cat: typeof allergies, label: string) => {
    const o = cat.options.find((x) => lc(x.label) === lc(label));
    if (!o) throw new Error(`option "${label}" not in ${cat.key}`);
    return o.id;
  };

  const kids = await db.collection("campers").find({}).toArray();
  const byName = new Map(kids.map((k) => [norm(String(k.name)), k]));
  for (const name of Object.keys(FIX)) if (!byName.has(norm(name))) throw new Error(`camper not found: ${name}`);

  let changed = 0;
  for (const k of kids) {
    const fix = FIX[Object.keys(FIX).find((n) => norm(n) === norm(String(k.name))) ?? ""] ?? {};
    const set: Record<string, unknown> = {};
    const want = (field: string, value: unknown) => {
      const cur = k[field] ?? (typeof value === "string" ? "" : typeof value === "boolean" ? false : null);
      if (cur !== value) set[field] = value;
    };
    // the raw dump is never kept: only the curated text (default: nothing)
    want("healthNotes", fix.healthNotes ?? "");
    if (fix.generalNotes !== undefined) want("generalNotes", fix.generalNotes);
    if (fix.foodRestrictions !== undefined) want("foodRestrictions", fix.foodRestrictions);
    if (fix.bedroomPreference !== undefined) want("bedroomPreference", fix.bedroomPreference);
    if (fix.insurance !== undefined) want("insurance", fix.insurance);
    if (fix.insuranceCard !== undefined) want("insuranceCard", fix.insuranceCard);
    if (fix.weightKg !== undefined) want("weightKg", fix.weightKg);
    if (fix.neurodivergent !== undefined) want("neurodivergent", fix.neurodivergent);
    if (fix.addAllergies) {
      const next = [...new Set([...((k.allergies as string[]) ?? []), ...fix.addAllergies.map((l) => optId(allergies, l))])];
      if (next.length !== ((k.allergies as string[]) ?? []).length) set.allergies = next;
    }
    if (fix.addHealthIssues) {
      const next = [...new Set([...((k.healthIssues as string[]) ?? []), ...fix.addHealthIssues.map((l) => optId(conditions, l))])];
      if (next.length !== ((k.healthIssues as string[]) ?? []).length) set.healthIssues = next;
    }
    if (!Object.keys(set).length) continue;
    changed++;
    console.log(`\n${String(k.name)}`);
    for (const [f, v] of Object.entries(set)) {
      const before = f === "healthNotes" ? "(dump)" : JSON.stringify(k[f] ?? "");
      console.log(`  ${f}: ${before} → ${JSON.stringify(v)}`);
    }
    if (!DRY) await db.collection("campers").updateOne({ _id: k._id }, { $set: { ...set, updatedAt: new Date() } });
  }
  console.log(`\n${DRY ? "[dry] " : ""}${changed} alterados, ${kids.length - changed} mantidos.\n`);
  await closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
