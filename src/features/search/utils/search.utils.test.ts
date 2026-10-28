import { describe, expect, it } from "vitest";
import { buildSnippet, escapeSearchHtml } from "./search.utils";

describe("search snippets", () => {
  it("escapes HTML in the fallback path when nothing matches", () => {
    const snippet = buildSnippet({
      text: `<img src=x onerror=alert(1)> hello`,
      terms: ["zzz"],
      fallbackTerm: "zzz",
    });

    expect(snippet).toBeTruthy();
    expect(snippet).not.toContain("<img");
    expect(snippet).toContain("&lt;img");
  });

  it("escapes HTML when there are no active terms", () => {
    const snippet = buildSnippet({
      text: "<script>alert(1)</script>",
      terms: [],
      fallbackTerm: "",
    });

    expect(snippet).toBeTruthy();
    expect(snippet).toContain("&lt;script&gt;");
  });

  it("escapes HTML before highlighting matched terms", () => {
    const snippet = buildSnippet({
      text: `hello <b>world</b>`,
      terms: ["world"],
      fallbackTerm: "world",
    });

    expect(snippet).toContain("<mark>world</mark>");
    expect(snippet).not.toContain("<b>");
    expect(snippet).toContain("&lt;b&gt;");
  });

  it("escapes raw fallback strings", () => {
    expect(escapeSearchHtml(`<a href="x">x</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;x&lt;/a&gt;",
    );
  });
});
