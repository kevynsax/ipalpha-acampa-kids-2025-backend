import sanitizeHtml from "sanitize-html";

/**
 * The ONE policy for rich text written in the admin WYSIWYG (role
 * instructions, role preparation, preparation sections). Only what the editor
 * produces survives; everything else is stripped.
 *
 * Layout vocabulary (no classes / styles, the reader CSS does the look):
 *   blockquote           soft callout box (✅ 🔓 ⚠️ as first char pick the colour)
 *   mark                 small pill / tag ("PROMESSA", "📖 Gênesis 15:5")
 *   details > summary + div[data-type=detailsContent]   collapsible section
 *
 * Images: only the ones uploaded through POST /api/files (relative
 * `/api/files/<id>` URLs) or plain http(s) links — never `data:` blobs, which
 * would bloat the documents pushed to every phone.
 */
const HTML_POLICY: sanitizeHtml.IOptions = {
  allowedTags: ["p", "br", "strong", "b", "em", "i", "u", "s", "ul", "ol", "li", "h2", "h3", "blockquote", "a", "hr", "img", "mark", "details", "summary", "div"],
  allowedAttributes: {
    a: ["href", "target", "rel"],
    img: ["src", "alt", "title", "width", "height", "loading"],
    details: ["open"],
    // only the editor's content wrapper; any other div keeps its children but loses the attributes
    div: [{ name: "data-type", values: ["detailsContent"] }],
  },
  allowedSchemes: ["http", "https", "mailto", "tel"],
  allowedSchemesByTag: { img: ["http", "https"] },
  transformTags: {
    a: sanitizeHtml.simpleTransform("a", { target: "_blank", rel: "noopener noreferrer" }),
    img: sanitizeHtml.simpleTransform("img", { loading: "lazy" }),
  },
  // an <img> without an acceptable src is dropped entirely (not left as an empty tag)
  exclusiveFilter: (frame) => frame.tag === "img" && !isAllowedImageSrc(frame.attribs.src),
};

const FILE_URL_RE = /^\/api\/files\/[a-f0-9]{16,64}$/;

export function isAllowedImageSrc(src: string | undefined): boolean {
  if (!src) return false;
  return FILE_URL_RE.test(src) || /^https?:\/\//i.test(src);
}

/**
 * Sanitizes editor HTML. Returns "" when the content is effectively empty
 * (no text and no image), `null` when it is not a string / too long.
 */
export function cleanHtml(value: unknown, max: number): string | null {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") return null;
  if (value.length > max) return null;
  const html = sanitizeHtml(value, HTML_POLICY);
  const html2 = unwrapStrayDivs(html).trim();
  const text = sanitizeHtml(html2, { allowedTags: [], allowedAttributes: {} }).replace(/\s|&nbsp;/g, "");
  return text || /<img\s/i.test(html2) ? html2 : "";
}

/**
 * `div` is allowed only as the editor's details-content wrapper. Any other div
 * (pasted from the web, or written by the AI) is unwrapped: children kept,
 * tag gone — so the document stays a flat list of blocks the editor understands.
 */
function unwrapStrayDivs(html: string): string {
  if (!/<div(?![^>]*data-type="detailsContent")[\s>]/.test(html)) return html;
  // walk tags; keep a stack so each </div> is matched to its opener
  const keep: boolean[] = [];
  return html.replace(/<div(\s[^>]*)?>|<\/div>/g, (m) => {
    if (m === "</div>") return keep.pop() ? m : "";
    const ok = /data-type="detailsContent"/.test(m);
    keep.push(ok);
    return ok ? m : "";
  });
}

/** `/api/files/<id>` ids referenced by a piece of HTML (to know which uploads are still in use). */
export function referencedFileIds(html: string): string[] {
  const ids: string[] = [];
  for (const m of html.matchAll(/\/api\/files\/([a-f0-9]{16,64})/g)) ids.push(m[1]);
  return ids;
}
