import { createServerFn } from "@tanstack/react-start";
import { getRequestHeader } from "@tanstack/react-start/server";
import { z } from "zod";
import * as PageviewService from "@/features/pageview/service/pageview.service";
import { sha256 } from "@/features/pageview/utils/hash";
import * as PostRepo from "@/features/posts/data/posts.data";
import { serverEnv } from "@/lib/env/server.env";
import { dbMiddleware } from "@/lib/middlewares";

export const recordPageViewFn = createServerFn({ method: "POST" })
  .middleware([dbMiddleware])
  .inputValidator(z.object({ postId: z.number().int().positive() }))
  .handler(async ({ data, context }) => {
    const ip = getRequestHeader("cf-connecting-ip") || "unknown";

    // 防刷：每个 IP 每分钟最多 60 次 PV 记录
    try {
      const limiter = context.env.RATE_LIMITER.get(
        context.env.RATE_LIMITER.idFromName(`pageview:${ip}`),
      );
      const limit = await limiter.checkLimit({ capacity: 60, interval: "1m" });
      if (!limit.allowed) return;
    } catch (error) {
      console.error(
        JSON.stringify({
          message: "pageview rate limit check failed",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }

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

    const ua = getRequestHeader("user-agent") || "";
    const env = serverEnv(context.env);
    // 未配置 PAGEVIEW_SALT 时退回 auth secret，避免盐为空
    const salt = env.PAGEVIEW_SALT || env.BETTER_AUTH_SECRET;

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

export const getViewCountsFn = createServerFn({ method: "GET" })
  .middleware([dbMiddleware])
  .inputValidator(
    z.object({
      slugs: z
        .array(z.string().min(1).max(200))
        .max(50)
        .transform((slugs) => [...new Set(slugs)]),
    }),
  )
  .handler(({ data, context }) =>
    PageviewService.getViewCounts(context, data.slugs),
  );
