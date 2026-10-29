import { describe, expect, it } from "vitest";
import {
  CreateTagInputSchema,
  normalizeTagName,
  SetPostTagsInputSchema,
} from "./tags.schema";

describe("tag input normalization", () => {
  it("trims and collapses tag names", () => {
    expect(normalizeTagName("  React   Native  ")).toBe("React Native");
    expect(normalizeTagName("\t中文   标签\n")).toBe("中文 标签");
  });

  it("trims create input before validation", () => {
    const parsed = CreateTagInputSchema.parse({ name: "  TypeScript  " });
    expect(parsed.name).toBe("TypeScript");
    expect(() => CreateTagInputSchema.parse({ name: "   " })).toThrow();
  });

  it("deduplicates and limits post tag ids", () => {
    const parsed = SetPostTagsInputSchema.parse({
      postId: 1,
      tagIds: [3, 1, 3, 2],
    });
    expect(parsed.tagIds).toEqual([3, 1, 2]);
    expect(() =>
      SetPostTagsInputSchema.parse({
        postId: 1,
        tagIds: Array.from({ length: 51 }, (_, index) => index + 1),
      }),
    ).toThrow();
  });
});
