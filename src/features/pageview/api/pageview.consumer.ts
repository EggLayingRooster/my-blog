import * as CacheService from "@/features/cache/cache.service";
import { PAGEVIEW_CACHE_KEYS } from "@/features/pageview/pageview.schema";
import { getDb } from "@/lib/db";
import { PageViewsTable } from "@/lib/db/schema";
import type { PageviewMessage } from "@/lib/queue/queue.schema";

export async function handlePageviewMessages(
  context: { env: Env },
  batch: Array<{ data: PageviewMessage["data"]; messageId: string }>,
) {
  const db = getDb(context.env);
  let inserted = 0;

  // 逐条写入：单条 FK/约束失败（例如文章刚被删除）不会毒化整批，
  // 也不会让整批消息无限重试后丢失。
  for (const item of batch) {
    const messageId = item.messageId;
    const dedupeKey = `pageview:msg:${messageId}`;

    // Queue 至少一次投递：同一 message id 已处理过则跳过，避免重复计 PV
    try {
      const seen = await CacheService.getRaw({ env: context.env }, dedupeKey);
      if (seen) continue;
    } catch (error) {
      console.error(
        JSON.stringify({
          message: "pageview dedupe check failed",
          messageId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }

    try {
      await db.insert(PageViewsTable).values({
        postId: item.data.postId,
        visitorHash: item.data.visitorHash,
      });
      inserted += 1;

      try {
        await CacheService.set({ env: context.env }, dedupeKey, "1", {
          ttl: "1h",
        });
      } catch (error) {
        console.error(
          JSON.stringify({
            message: "pageview dedupe marker write failed",
            messageId,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    } catch (error) {
      console.error(
        JSON.stringify({
          message: "pageview insert failed",
          postId: item.data.postId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  // 有新数据时让 dashboard 流量缓存立即失效（TTL 3h 太长，会导致新 PV 不显示）
  if (inserted > 0) {
    // 合并短时间内的缓存失效，避免每批 PV 都删除 dashboard traffic 缓存
    const throttleKey = "pageview:traffic-invalidate-at";
    try {
      const lastInvalidated = await context.env.KV.get(throttleKey);
      if (!lastInvalidated) {
        await context.env.KV.put(throttleKey, "1", { expirationTtl: 60 });
        await CacheService.deleteKey(
          { env: context.env },
          PAGEVIEW_CACHE_KEYS.traffic,
        );
      }
    } catch (error) {
      console.error(
        JSON.stringify({
          message: "pageview traffic cache invalidation failed",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      await CacheService.deleteKey(
        { env: context.env },
        PAGEVIEW_CACHE_KEYS.traffic,
      );
    }
  }
}
