import { createServerFn } from "@tanstack/react-start";
import { getRequestHeader } from "@tanstack/react-start/server";
import { z } from "zod";
import * as PageviewService from "@/features/pageview/service/pageview.service";
import { sha256 } from "@/features/pageview/utils/hash";
import * as PostRepo from "@/features/posts/data/posts.data";
import { serverEnv } from "@/lib/env/server.env";
import { dbMiddleware } from "@/lib/middlewares";

export const recordPageViewFn = createServerFn()
  .middleware([dbMiddleware])
  .inputValidator(z.object({ postId: z.number().int().positive() }))
  .handler(async ({ data, context }) => {
    // 只统计真实、已发布的文章；避免被脚本用任意 postId 刷记录
    const post = await PostRepo.findPostById(context.db, data.postId);
    if (
      !post ||
      post.status !== "published" ||
      !post.publishedAt ||
      post.publishedAt.getTime() > Date.now()
    ) {
      return;
    }

    const ip = getRequestHeader("cf-connecting-ip") || "";
    const ua = getRequestHeader("user-agent") || "";
    const salt = serverEnv(context.env).PAGEVIEW_SALT || "";

    const visitorHash = await sha256(`${ip}:${ua}:${salt}`);

    context.executionCtx.waitUntil(
      context.env.QUEUE.send({
        type: "PAGEVIEW",
        data: { postId: data.postId, visitorHash },
      }).catch((error) => {
        console.error(
          JSON.stringify({
            message: "pageview enqueue failed",
            postId: data.postId,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }),
    );
  });

export const getViewCountsFn = createServerFn()
  .middleware([dbMiddleware])
  .inputValidator(z.object({ slugs: z.array(z.string()).max(50) }))
  .handler(({ data, context }) =>
    PageviewService.getViewCounts(context, data.slugs),
  );
