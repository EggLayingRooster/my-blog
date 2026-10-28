import * as CacheService from "@/features/cache/cache.service";
import { PAGEVIEW_CACHE_KEYS } from "@/features/pageview/pageview.schema";
import { getDb } from "@/lib/db";
import { PageViewsTable } from "@/lib/db/schema";
import type { PageviewMessage } from "@/lib/queue/queue.schema";

export async function handlePageviewMessages(
  context: { env: Env },
  batch: Array<PageviewMessage["data"]>,
) {
  const db = getDb(context.env);
  let inserted = 0;

  // 逐条写入：单条 FK/约束失败（例如文章刚被删除）不会毒化整批，
  // 也不会让整批消息无限重试后丢失。
  for (const item of batch) {
    try {
      await db.insert(PageViewsTable).values({
        postId: item.postId,
        visitorHash: item.visitorHash,
      });
      inserted += 1;
    } catch (error) {
      console.error(
        JSON.stringify({
          message: "pageview insert failed",
          postId: item.postId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  // 有新数据时让 dashboard 流量缓存立即失效（TTL 3h 太长，会导致新 PV 不显示）
  if (inserted > 0) {
    await CacheService.deleteKey(
      { env: context.env },
      PAGEVIEW_CACHE_KEYS.traffic,
    );
  }
}
