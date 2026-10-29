import { describe, expect, it } from "vitest";
import { SITE_TIME_ZONE_OFFSET_SECONDS } from "@/lib/constants";
import { getSiteDayBucket, getSiteDayStartMs } from "./time";

describe("site-time pageview buckets", () => {
  it("aligns UTC midnight to Asia/Shanghai day start", () => {
    const utcMidnight = Date.UTC(2026, 0, 2, 0, 0, 0);
    expect(getSiteDayStartMs(utcMidnight)).toBe(
      Date.UTC(2026, 0, 1, 16, 0, 0),
    );
  });

  it("buckets unix seconds by Asia/Shanghai natural day", () => {
    const epochSeconds = Math.floor(Date.UTC(2026, 0, 2, 0, 0, 0) / 1000);
    const bucket = getSiteDayBucket(epochSeconds);
    expect(bucket).toBe(
      Math.floor(Date.UTC(2026, 0, 1, 16, 0, 0) / 1000),
    );
    expect(getSiteDayBucket(bucket + 86399)).toBe(bucket);
    expect(getSiteDayBucket(bucket + 86400)).toBe(
      bucket + 86400,
    );
    expect(SITE_TIME_ZONE_OFFSET_SECONDS).toBe(8 * 3600);
  });
});
