import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { GetPostsCursorInputSchema } from "@/features/posts/schema/posts.schema";
import * as PostService from "@/features/posts/services/posts.service";
import { MAX_POSTS_PAGE_SIZE } from "@/lib/constants";
import { getServiceContext, setCacheHeaders } from "@/lib/hono/helper";
import { baseMiddleware } from "@/lib/hono/middlewares";

const app = new Hono<{ Bindings: Env }>();

app.use("*", baseMiddleware);

const route = app.get(
  "/",
  zValidator(
    "query",
    GetPostsCursorInputSchema.extend({
      cursor: z.coerce.number().int().min(0).optional(),
      limit: z.coerce.number().int().min(1).max(MAX_POSTS_PAGE_SIZE).optional(),
      // query string 里的 boolean 需要显式转换（z.boolean() 不 coerce）
      excludePinned: z
        .enum(["true", "false"])
        .transform((value) => value === "true")
        .optional(),
    }),
  ),
  async (c) => {
    const data = c.req.valid("query");
    const result = await PostService.getPostsCursor(getServiceContext(c), data);
    setCacheHeaders(c.res.headers, "public");
    return c.json(result);
  },
);

export default route;
