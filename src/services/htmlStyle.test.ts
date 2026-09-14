import { expect, test } from "bun:test";
import { cleanHtml } from "./html";
import { COLORS, DENSITIES, FONTS, SIZES, SPACES, STYLE_TOKENS, STYLEABLE_TAGS, TONES, ALIGNS } from "./htmlStyle";

/**
 * The style vocabulary lives in two files — this one (authority, used by the
 * sanitizer and the AI prompt) and `frontend/src/htmlStyle.ts` (editor menu and
 * source view). If they drift, the editor offers a token the server silently
 * deletes on save, which looks like data loss to the user.
 *
 *   bun test src/services/htmlStyle.test.ts
 */
const FRONTEND = new URL("../../../frontend/src/htmlStyle.ts", import.meta.url);

/** reads `export const NAME = ["a", "b"] as const;` out of the mirror file */
function listInFrontend(source: string, name: string): string[] {
  const m = new RegExp(`export const ${name} = \\[([^\\]]*)\\]`).exec(source);
  if (!m) throw new Error(`${name} not found in frontend/src/htmlStyle.ts`);
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

test("frontend mirrors the server style vocabulary", async () => {
  const source = await Bun.file(FRONTEND).text();
  for (const [name, values] of [
    ["ALIGNS", ALIGNS],
    ["SIZES", SIZES],
    ["SPACES", SPACES],
    ["COLORS", COLORS],
    ["TONES", TONES],
    ["FONTS", FONTS],
    ["DENSITIES", DENSITIES],
    ["STYLEABLE_TAGS", STYLEABLE_TAGS],
  ] as const) {
    expect(listInFrontend(source, name), name).toEqual([...values]);
  }
});

test("every token value survives a save on every styleable tag", () => {
  for (const tag of STYLEABLE_TAGS) {
    if (tag === "img" || tag === "hr" || tag === "div") continue; // void / special-cased below
    for (const [attr, values] of Object.entries(STYLE_TOKENS)) {
      // density is list-only; covered by its own test below
      if (attr === "data-density" && tag !== "ul" && tag !== "ol") continue;
      for (const value of values) {
        const html = `<${tag} ${attr}="${value}">x</${tag}>`;
        expect(cleanHtml(html, 10_000), `${tag} ${attr}=${value}`).toContain(`${attr}="${value}"`);
      }
    }
  }
});

test("unknown values and raw CSS never survive", () => {
  const bad = [
    `<p style="color:red">x</p>`,
    `<p class="danger">x</p>`,
    `<p data-align="justify">x</p>`,
    `<p data-color="hotpink">x</p>`,
    `<p data-size="20px">x</p>`,
    `<p data-tone="rainbow">x</p>`,
  ];
  for (const html of bad) {
    const out = cleanHtml(html, 10_000);
    expect(out, html).toBe("<p>x</p>");
  }
});

test("a style token cannot smuggle markup", () => {
  const out = cleanHtml(`<p data-align="center&quot;><script>alert(1)</script>">x</p>`, 10_000) ?? "";
  expect(out).not.toContain("script");
  expect(out).toBe("<p>x</p>");
});

test("style tokens do not displace the attributes a tag already had", () => {
  const id = "a".repeat(48);
  const img = cleanHtml(`<img src="/api/files/${id}" alt="foto" data-align="center">`, 10_000) ?? "";
  expect(img).toContain(`src="/api/files/${id}"`);
  expect(img).toContain(`alt="foto"`);
  expect(img).toContain(`data-align="center"`);

  const details = cleanHtml(`<details open><summary>s</summary><div data-type="detailsContent" data-tone="sky"><p>x</p></div></details>`, 10_000) ?? "";
  expect(details).toContain(`data-type="detailsContent"`);
  expect(details).toContain(`data-tone="sky"`);
  expect(details).toContain("<details open>");
});

test("tags outside the styleable list lose the tokens", () => {
  expect(cleanHtml(`<ul><li data-color="red">x</li></ul>`, 10_000)).toBe("<ul><li>x</li></ul>");
});

test("data-density only survives on lists", () => {
  for (const value of DENSITIES) {
    expect(cleanHtml(`<ul data-density="${value}"><li>x</li></ul>`, 10_000)).toContain(`data-density="${value}"`);
    expect(cleanHtml(`<ol data-density="${value}"><li>x</li></ol>`, 10_000)).toContain(`data-density="${value}"`);
  }
  // meaningless anywhere else: dropped rather than stored as dead markup
  expect(cleanHtml(`<p data-density="tight">x</p>`, 10_000)).toBe("<p>x</p>");
  expect(cleanHtml(`<table data-density="tight"><tbody><tr><td>a</td></tr></tbody></table>`, 10_000)).not.toContain("data-density");
});
