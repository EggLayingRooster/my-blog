import { describe, expect, it } from "vitest";
import { escapeHtml } from "./html";

describe("escapeHtml", () => {
  it("escapes code-block fallback content", () => {
    expect(escapeHtml(`</code><img src=x onerror=alert(1)>`)).toBe(
      "&lt;/code&gt;&lt;img src=x onerror=alert(1)&gt;",
    );
  });

  it("escapes quotes and ampersands", () => {
    expect(escapeHtml(`"&"`)).toBe("&quot;&amp;&quot;");
  });
});
