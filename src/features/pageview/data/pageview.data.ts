import {
  and,
  count,
  countDistinct,
  eq,
  gte,
  inArray,
  lt,
  sql,
} from "drizzle-orm";
import type { DB } from "@/lib/db";
import { PageViewsTable, PostsTable } from "@/lib/db/schema";

/**
 * 获取时间范围内的 PV 和 UV
 */
export async function getStats(
  db: DB,
  startAt: Date,
  endAt: Date,
): Promise<{ pv: number; uv: number }> {
  const result = await db
    .select({
      pv: count(),
      uv: countDistinct(PageViewsTable.visitorHash),
    })
    .from(PageViewsTable)
    .where(
      and(
        gte(PageViewsTable.createdAt, startAt),
        lt(PageViewsTable.createdAt, endAt),
      ),
    );

  return { pv: result[0]?.pv ?? 0, uv: result[0]?.uv ?? 0 };
}

/**
 * 获取流量趋势数据（按小时或按天聚合）
 */
export async function getTrafficTrend(
  db: DB,
  startAt: Date,
  endAt: Date,
  unit: "hour" | "day",
): Promise<Array<{ date: number; views: number }>> {
  const truncExpr =
    unit === "hour"
      ? sql<number>`(${PageViewsTable.createdAt} - ${PageViewsTable.createdAt} % 3600)`
      : sql<number>`(${PageViewsTable.createdAt} - ${PageViewsTable.createdAt} % 86400)`;

  const rows = await db
    .select({
      bucket: truncExpr.as("bucket"),
      views: count().as("views"),
    })
    .from(PageViewsTable)
    .where(
      and(
        gte(PageViewsTable.createdAt, startAt),
        lt(PageViewsTable.createdAt, endAt),
      ),
    )
    .groupBy(sql`bucket`)
    .orderBy(sql`bucket`);

  const stepSeconds = unit === "hour" ? 3600 : 86400;

  const byBucket = new Map<number, number>();
  for (const row of rows) {
    byBucket.set(Number(row.bucket), row.views);
  }

  // 补齐没有数据的时间桶：只有一个数据点时前端折线/面积图画不出来
  const startBucket =
    Math.floor(startAt.getTime() / 1000 / stepSeconds) * stepSeconds;
  const endBucket =
    Math.floor(endAt.getTime() / 1000 / stepSeconds) * stepSeconds;

  const trend: Array<{ date: number; views: number }> = [];
  for (
    let bucket = startBucket;
    bucket <= endBucket;
    bucket += stepSeconds
  ) {
    trend.push({
      date: bucket * 1000, // unix seconds → ms
      views: byBucket.get(bucket) ?? 0,
    });
  }

  return trend;
}

/**
 * 获取热门文章（按 PV 排序，返回 slug + views）
 */
export async function getTopPages(
  db: DB,
  startAt: Date,
  endAt: Date,
  limit = 5,
): Promise<Array<{ slug: string; title: string; views: number }>> {
  return db
    .select({
      slug: PostsTable.slug,
      title: PostsTable.title,
      views: count().as("views"),
    })
    .from(PageViewsTable)
    .innerJoin(PostsTable, eq(PageViewsTable.postId, PostsTable.id))
    .where(
      and(
        gte(PageViewsTable.createdAt, startAt),
        lt(PageViewsTable.createdAt, endAt),
      ),
    )
    .groupBy(PostsTable.slug)
    .orderBy(sql`views DESC`)
    .limit(limit);
}

/**
 * 批量获取文章的总浏览量
 */
export async function getViewCountsBySlugs(
  db: DB,
  slugs: string[],
): Promise<Record<string, number>> {
  if (slugs.length === 0) return {};

  const rows = await db
    .select({
      slug: PostsTable.slug,
      views: count().as("views"),
    })
    .from(PageViewsTable)
    .innerJoin(PostsTable, eq(PageViewsTable.postId, PostsTable.id))
    .where(inArray(PostsTable.slug, slugs))
    .groupBy(PostsTable.slug);

  return Object.fromEntries(rows.map((r) => [r.slug, r.views]));
}
