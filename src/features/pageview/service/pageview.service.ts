import * as CacheService from "@/features/cache/cache.service";
import * as PageviewRepo from "@/features/pageview/data/pageview.data";
import {
  PAGEVIEW_CACHE_KEYS,
  ViewCountsSchema,
} from "@/features/pageview/pageview.schema";
import * as PostRepo from "@/features/posts/data/posts.data";
import { PostItemSchema } from "@/features/posts/schema/posts.schema";
import { CACHE_TTL, PAGEVIEW_RETENTION_DAYS } from "@/lib/constants";
import { getDb } from "@/lib/db";

export async function getPopularPosts(
  context: DbContext & { executionCtx: ExecutionContext },
  limit = 5,
) {
  const now = new Date();
  const thirtyDaysAgo = new Date(now);
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  return CacheService.getVersioned(
    context,
    "posts:list",
    (version) => [version, ...PAGEVIEW_CACHE_KEYS.popular, limit],
    PostItemSchema.array(),
    async () => {
      const topPages = await PageviewRepo.getTopPages(
        context.db,
        thirtyDaysAgo,
        now,
        limit,
      );
      if (topPages.length === 0) return [];

      const slugs = topPages.map((p) => p.slug);
      const posts = await PostRepo.findPostsBySlugs(context.db, slugs);

      // Preserve popularity order
      const bySlug = new Map(posts.map((p) => [p.slug, p]));
      return slugs.flatMap((slug) => {
        const post = bySlug.get(slug);
        return post ? [post] : [];
      });
    },
    { ttl: CACHE_TTL.popularPosts },
  );
}

export async function getViewCounts(
  context: DbContext & { executionCtx: ExecutionContext },
  slugs: string[],
) {
  if (slugs.length === 0) return {};

  return CacheService.get(
    context,
    PAGEVIEW_CACHE_KEYS.viewCounts(slugs),
    ViewCountsSchema,
    () => PageviewRepo.getViewCountsBySlugs(context.db, slugs),
    { ttl: CACHE_TTL.viewCounts },
  );
}

/** scheduled 任务：清理超过保留期的 page_views，避免表无界增长 */
export async function cleanupOldPageviews(env: Env): Promise<void> {
  const db = getDb(env);
  const cutoff = new Date(
    Date.now() - PAGEVIEW_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  );
  await PageviewRepo.deletePageviewsBefore(db, cutoff);
  console.log(
    JSON.stringify({
      message: "pageview cleanup completed",
      cutoff: cutoff.toISOString(),
    }),
  );
}
