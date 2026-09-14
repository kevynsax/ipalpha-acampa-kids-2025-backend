/**
 * The style vocabulary of the documents.
 *
 * Admins (and the AI) can change spacing, alignment, size, colour and font —
 * but only through a CLOSED set of tokens written as `data-*` attributes, never
 * through `style=""` or `class=""`. Reasons:
 *   - free CSS lets one document drift away from the app's identity, and looks
 *     broken on a 360 px phone (fixed px sizes, dark text on dark callouts…);
 *   - free CSS is an injection surface the sanitizer would have to parse;
 *   - tokens survive a redesign: change the CSS once and every document follows.
 *
 * The reader CSS (`frontend/src/styles.css`) implements each token, the editor
 * offers them in a menu, and the AI prompt lists them. This file is the single
 * source of truth for the server; `frontend/src/htmlStyle.ts` mirrors it and is
 * kept in sync by a test.
 */

/** where the text sits on the line */
export const ALIGNS = ["left", "center", "right"] as const;

/** relative text size — never absolute px, so it scales with the reader's settings */
export const SIZES = ["sm", "lg", "xl"] as const;

/** space above/below a block */
export const SPACES = ["none", "sm", "lg", "xl"] as const;

/** ink colours: the app palette, nothing else */
export const COLORS = ["forest", "pine", "sun", "red", "muted", "sky"] as const;

/** soft background band for a block */
export const TONES = ["sand", "sage", "sky", "sun", "red", "forest"] as const;

/** the two families the app already ships (display = títulos, body = texto) */
export const FONTS = ["display", "body"] as const;

/**
 * How tight a list is. `tight` puts a checklist on one screen ("O que levar");
 * `airy` gives room to items the reader has to act on one by one. Applies to
 * `ul`/`ol` and cascades to the items.
 */
export const DENSITIES = ["tight", "airy"] as const;

export type Align = (typeof ALIGNS)[number];
export type Size = (typeof SIZES)[number];
export type Space = (typeof SPACES)[number];
export type Color = (typeof COLORS)[number];
export type Tone = (typeof TONES)[number];
export type Font = (typeof FONTS)[number];
export type Density = (typeof DENSITIES)[number];

/** attribute name → the values it accepts */
export const STYLE_TOKENS = {
  "data-align": ALIGNS,
  "data-size": SIZES,
  "data-space": SPACES,
  "data-color": COLORS,
  "data-tone": TONES,
  "data-font": FONTS,
  "data-density": DENSITIES,
} as const;

export type StyleAttr = keyof typeof STYLE_TOKENS;

export const STYLE_ATTRS = Object.keys(STYLE_TOKENS) as StyleAttr[];

/**
 * Tags that may carry style tokens: blocks the reader sees as a unit, plus the
 * two inline marks. Not `li` (the list owns the look), not the table internals
 * (a striped table is styled as a whole), not `details`/`summary`.
 */
export const STYLEABLE_TAGS = ["p", "h2", "h3", "blockquote", "figure", "figcaption", "table", "ul", "ol", "div", "mark", "strong", "em", "hr", "img"] as const;

/** tokens that only make sense on some tags */
const TAG_ONLY: Partial<Record<StyleAttr, readonly string[]>> = {
  "data-density": ["ul", "ol"],
};

/** sanitize-html `allowedAttributes` entries for the style tokens valid on `tag` */
export function styleAttrRules(tag: string): { name: string; values: string[] }[] {
  return STYLE_ATTRS.filter((name) => (TAG_ONLY[name] ?? [tag]).includes(tag)).map((name) => ({ name, values: [...STYLE_TOKENS[name]] }));
}

/** Is this a style attribute carrying a value the app knows (optionally on a given tag)? */
export function isStyleToken(name: string, value: string, tag?: string): boolean {
  const allowed = STYLE_TOKENS[name as StyleAttr] as readonly string[] | undefined;
  if (!allowed || !allowed.includes(value)) return false;
  const only = TAG_ONLY[name as StyleAttr];
  return !only || !tag || only.includes(tag);
}

/** The vocabulary, written out for the AI prompt. */
export function describeStyleTokens(): string {
  return [
    `- data-align="${ALIGNS.join(" | ")}" — alinhamento do texto. Use center só para capas, títulos de abertura e legendas; texto corrido alinhado à esquerda é mais fácil de ler no celular.`,
    `- data-size="${SIZES.join(" | ")}" — tamanho relativo (sm = nota de rodapé, lg = destaque, xl = capa). Sem sm em texto que a equipe precisa ler com pressa.`,
    `- data-space="${SPACES.join(" | ")}" — espaço em volta do bloco (none gruda no anterior, xl separa seções).`,
    `- data-color="${COLORS.join(" | ")}" — cor do texto, só da paleta do app. Nunca use cor como único sinal de importância (daltônicos): combine com <strong> ou com uma palavra.`,
    `- data-tone="${TONES.join(" | ")}" — faixa de fundo suave no bloco (cartão colorido). Bom para um aviso curto ou uma capa; péssimo para parágrafos longos.`,
    `- data-font="${FONTS.join(" | ")}" — display é a fonte dos títulos (curta e forte), body é a de leitura.`,
    `- data-density="${DENSITIES.join(" | ")}" — só em <ul>/<ol>: tight aperta a lista (checklist longo que precisa caber na tela), airy separa os itens (cada item é uma ação demorada). Use tight em listas de 6+ itens curtos.`,
  ].join("\n");
}
