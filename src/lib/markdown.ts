/**
 * Markdown — `src/lib/markdown.ts`
 *
 * Safe Markdown-to-HTML rendering for accepted deliverable text.
 *
 * Security invariants:
 * 1. Rendered model output never emits raw HTML. `marked@18.1.3` has no
 *    `escapeRawHtml` option, so raw HTML tokens are neutralized by overriding
 *    `renderer.html` to HTML-escape the token text — the equivalent of the
 *    `escapeRawHtml` behavior available in later marked releases.
 * 2. Link and image destinations are sanitized in `walkTokens`: every `href`
 *    whose trimmed, lower-cased value starts with `javascript:`, `vbscript:`,
 *    or `data:` is replaced with `#`.
 * 3. Inputs longer than 250,000 characters are rejected without invoking the
 *    parser and return exactly
 *    `<p>Error: Output exceeds maximum safe rendering length.</p>`.
 * 4. This module owns a single private `Marked` instance; it never mutates the
 *    global `marked` singleton via `marked.use`.
 */

import { Marked } from "marked";
import type { Token, Tokens } from "marked";

/** Maximum accepted input length; longer output is rejected before parsing. */
const MAX_MARKDOWN_LENGTH = 250_000;

/** Exact HTML returned when model output exceeds `MAX_MARKDOWN_LENGTH`. */
const RENDER_LIMIT_ERROR =
  "<p>Error: Output exceeds maximum safe rendering length.</p>";

/** URL protocols that are never allowed in rendered links or images. */
const DANGEROUS_PROTOCOLS = ["javascript:", "vbscript:", "data:"] as const;

/**
 * Escapes `&`, `<`, `>`, `"`, and `'` for safe interpolation into HTML text
 * and attribute values. The ampersand replacement runs first so existing
 * entities are not double-escaped.
 */
export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Narrows a generic marked token to the link/image tokens carrying `href`. */
function isLinkOrImageToken(
  token: Token,
): token is Tokens.Link | Tokens.Image {
  return token.type === "link" || token.type === "image";
}

/** True when a URL uses a script-capable or inline-data protocol. */
function hasDangerousProtocol(href: string): boolean {
  const normalized = href.trim().toLowerCase();
  return DANGEROUS_PROTOCOLS.some((protocol) => normalized.startsWith(protocol));
}

/** Replaces dangerous link/image destinations with an inert fragment. */
function sanitizeTokenUrls(token: Token): void {
  if (!isLinkOrImageToken(token)) {
    return;
  }
  if (typeof token.href !== "string") {
    return;
  }
  if (hasDangerousProtocol(token.href)) {
    token.href = "#";
  }
}

const markdown = new Marked({
  gfm: true,
  renderer: {
    html({ text }) {
      return escapeHtml(text);
    },
  },
  walkTokens: sanitizeTokenUrls,
});

/**
 * Renders trusted Markdown source to sanitized HTML.
 *
 * Rejects inputs over 250,000 characters with the fixed error paragraph
 * before parsing. Parsing is synchronous, so `parse` uses the `async: false`
 * overload and returns a plain string.
 */
export function renderMarkdown(text: string): string {
  if (text.length > MAX_MARKDOWN_LENGTH) {
    return RENDER_LIMIT_ERROR;
  }
  return markdown.parse(text, { async: false });
}