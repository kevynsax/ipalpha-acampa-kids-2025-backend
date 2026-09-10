import sanitizeHtml from "sanitize-html";

/**
 * The ONE policy for rich text written in the admin WYSIWYG (role
 * instructions, role preparation, preparation sections). Only what the editor
 * produces survives; everything else is stripped.
 *
 * Images: only the ones uploaded through POST /api/files (relative
 * `/api/files/<id>` URLs) or plain http(s) links — never `data:` blobs, which
 * would bloat the documents pushed to every phone.
 */
const HTML_POLICY: sanitizeHtml.IOptions = {
  allowedTags: ["p", "br", "strong", "b", "em", "i", "u", "s", "ul", "ol", "li", "h2", "h3", "blockquote", "a", "hr", "img"],
  allowedAttributes: { a: ["href", "target", "rel"], img: ["src", "alt", "title", "width", "height", "loading"] },
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
  const html = sanitizeHtml(value, HTML_POLICY).trim();
  const text = sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} }).replace(/\s|&nbsp;/g, "");
  return text || /<img\s/i.test(html) ? html : "";
}

/** `/api/files/<id>` ids referenced by a piece of HTML (to know which uploads are still in use). */
export function referencedFileIds(html: string): string[] {
  const ids: string[] = [];
  for (const m of html.matchAll(/\/api\/files\/([a-f0-9]{16,64})/g)) ids.push(m[1]);
  return ids;
}
