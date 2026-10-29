import { describe, expect, it } from "vitest";
import type { JSONContent } from "@tiptap/react";
import { createHeadingIdGenerator } from "./content";
import { generateTableOfContents } from "./toc";

const heading = (text: string, level = 2): JSONContent => ({
  type: "heading",
  attrs: { level },
  content: [{ type: "text", text }],
});

describe("heading ids", () => {
  it("deduplicates repeated heading text", () => {
    const nextId = createHeadingIdGenerator();
    expect(nextId("Hello World")).toBe("hello-world");
    expect(nextId("Hello World")).toBe("hello-world-1");
    expect(nextId("Hello World")).toBe("hello-world-2");
  });

  it("uses unique ids in the table of contents", () => {
    const toc = generateTableOfContents({
      type: "doc",
      content: [heading("Intro"), heading("Intro"), heading("Outro", 3)],
    });

    expect(toc.map((item) => item.id)).toEqual([
      "intro",
      "intro-1",
      "outro",
    ]);
    expect(toc.map((item) => item.level)).toEqual([2, 2, 3]);
  });
});
