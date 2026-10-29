import type { JSONContent } from "@tiptap/react";
import { z } from "zod";

export const JsonValueSchema: z.ZodType<
  string | number | boolean | null | Array<unknown> | Record<string, unknown>
> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

export const JsonAttrsSchema = z.record(z.string(), JsonValueSchema);

export const JsonMarkSchema = z
  .object({
    type: z.string(),
    attrs: JsonAttrsSchema.optional(),
  })
  .catchall(JsonValueSchema);

export const JsonContentSchema: z.ZodType<JSONContent> = z.lazy(() =>
  z
    .object({
      type: z.string().optional(),
      attrs: JsonAttrsSchema.optional(),
      content: z.array(JsonContentSchema).optional(),
      marks: z.array(JsonMarkSchema).optional(),
      text: z.string().optional(),
    })
    .catchall(JsonValueSchema)
    .superRefine((value, ctx) => {
      if (value.text !== undefined && value.content !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Text nodes cannot contain child content.",
          path: ["content"],
        });
      }
    }),
);

const MAX_CONTENT_DEPTH = 64;
const MAX_CONTENT_NODES = 20000;
const MAX_CONTENT_TEXT_LENGTH = 2_000_000;

/**
 * 迭代校验内容规模，避免递归渲染/纯文本转换因超深或超大 JSON 崩溃。
 * 在顶层 schema 执行一次，而不是每个嵌套节点重复校验。
 */
function validateContentLimits(
  root: unknown,
  ctx: z.RefinementCtx,
): void {
  if (!root || typeof root !== "object") return;

  const stack: Array<{ depth: number; node: unknown }> = [
    { depth: 1, node: root },
  ];
  let nodeCount = 0;
  let textLength = 0;

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;

    const node = current.node as {
      content?: Array<unknown>;
      text?: unknown;
    };
    nodeCount += 1;
    if (nodeCount > MAX_CONTENT_NODES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Content has too many nodes (max ${MAX_CONTENT_NODES}).`,
      });
      return;
    }

    if (typeof node.text === "string") {
      textLength += node.text.length;
      if (textLength > MAX_CONTENT_TEXT_LENGTH) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Content text is too large.",
        });
        return;
      }
    }

    if (current.depth > MAX_CONTENT_DEPTH) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Content nesting exceeds ${MAX_CONTENT_DEPTH} levels.`,
      });
      return;
    }

    if (Array.isArray(node.content)) {
      for (const child of node.content) {
        stack.push({ depth: current.depth + 1, node: child });
      }
    }
  }
}

export const NullableJsonContentSchema = JsonContentSchema.nullable().superRefine(
  (value, ctx) => {
    if (value) validateContentLimits(value, ctx);
  },
);
