import { describe, expect, it } from "vitest";
import { NullableJsonContentSchema } from "./json-content.schema";

function deeplyNested(depth: number) {
  let node: Record<string, unknown> = { type: "paragraph" };
  for (let index = 0; index < depth; index += 1) {
    node = { type: "paragraph", content: [node] };
  }
  return node;
}

describe("content JSON limits", () => {
  it("accepts normal tiptap content", () => {
    const result = NullableJsonContentSchema.safeParse({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "hello" }],
        },
      ],
    });

    expect(result.success).toBe(true);
  });

  it("rejects content nested beyond the depth limit", () => {
    const result = NullableJsonContentSchema.safeParse(deeplyNested(80));
    expect(result.success).toBe(false);
  });
});
