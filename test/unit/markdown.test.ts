// Covers: 2, 7

import { describe, expect, it } from "vitest";

import { escapeHtml, renderMarkdown } from "../../src/lib/markdown.ts";

const LIMIT = 250_000;

describe("renderMarkdown", () => {
  it("renders ordinary markdown", () => {
    const html = renderMarkdown("# Title\n\n- one\n- two\n\n**bold**");
    expect(html).toContain("<h1");
    expect(html).toContain("<li>one</li>");
    expect(html).toContain("<strong>bold</strong>");
  });

  it("neutralizes raw HTML instead of emitting it", () => {
    const html = renderMarkdown('<img src=x onerror="alert(1)">\n\n<script>alert(2)</script>');
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;img");
    expect(html).toContain("&lt;script");
  });

  it("neutralizes dangerous link and image protocols", () => {
    const html = renderMarkdown("[click](javascript:alert(1))\n\n![img](data:text/html;base64,AAAA)");
    expect(html.toLowerCase()).not.toContain("javascript:");
    expect(html.toLowerCase()).not.toContain("data:text/html");
    expect(html).toContain('href="#"');
  });

  it("accepts exactly the limit and rejects one character over", () => {
    const atLimit = renderMarkdown("a".repeat(LIMIT));
    expect(atLimit).not.toContain("maximum safe rendering length");

    const overLimit = renderMarkdown("a".repeat(LIMIT + 1));
    expect(overLimit).toBe("<p>Error: Output exceeds maximum safe rendering length.</p>");
  });
});

describe("escapeHtml", () => {
  it("escapes every HTML-significant character, ampersand first", () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;",
    );
  });
});