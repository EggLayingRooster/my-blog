import { z } from "zod";

export const TrafficOverviewSchema = z.object({
  pageViews: z.object({ value: z.number(), prev: z.number().optional() }),
  visitors: z.object({ value: z.number(), prev: z.number().optional() }),
});

export const TrafficRangeDataSchema = z.object({
  traffic: z.array(z.object({ date: z.number(), views: z.number() })),
  overview: TrafficOverviewSchema.optional(),
  topPages: z
    .array(z.object({ slug: z.string(), title: z.string(), views: z.number() }))
    .optional(),
  lastUpdated: z.number(),
});

export const CachedAllRangesSchema = z.record(
  z.enum(["24h", "7d", "30d", "90d"]),
  TrafficRangeDataSchema,
);

export type TrafficRangeData = z.infer<typeof TrafficRangeDataSchema>;

export const ViewCountsSchema = z.record(z.string(), z.number());

/**
 * 把 slug 列表压成短 hash 作为缓存键，避免 slug 过多/过长时超过 KV key 512B 限制。
 * 仅用于缓存键，不参与业务数据。
 */
function hashSlugList(slugs: string[]): string {
  let hash = 2166136261;
  for (const slug of [...slugs].sort()) {
    for (let i = 0; i < slug.length; i += 1) {
      hash ^= slug.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    hash ^= 0x7c;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export const PAGEVIEW_CACHE_KEYS = {
  traffic: ["dashboard", "traffic"] as const,
  popular: ["homepage", "popular"] as const,
  viewCounts: (slugs: string[]) =>
    ["pageview", "counts", hashSlugList(slugs)] as const,
} as const;
