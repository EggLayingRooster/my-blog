import { SITE_TIME_ZONE_OFFSET_SECONDS } from "@/lib/constants";

/** 返回给定时刻所在"站点时区自然日"的 UTC 毫秒时间戳 */
export function getSiteDayStartMs(ms: number): number {
  const offset = SITE_TIME_ZONE_OFFSET_SECONDS;
  const seconds = Math.floor(ms / 1000) + offset;
  return (Math.floor(seconds / 86400) * 86400 - offset) * 1000;
}

/** 把 UTC unix 秒按站点时区归入自然日桶，返回该桶的 UTC unix 秒 */
export function getSiteDayBucket(epochSeconds: number): number {
  const offset = SITE_TIME_ZONE_OFFSET_SECONDS;
  const shifted = epochSeconds + offset;
  return shifted - (shifted % 86400) - offset;
}
