import { describe, expect, it } from "vitest";
import {
  normalizeImageQuery,
  stripImageMetadata,
} from "./media.utils";

function chunk(type: string, data: Array<number>): Array<number> {
  const length = data.length;
  return [
    (length >>> 24) & 0xff,
    (length >>> 16) & 0xff,
    (length >>> 8) & 0xff,
    length & 0xff,
    ...Array.from(type, (char) => char.charCodeAt(0)),
    ...data,
    0,
    0,
    0,
    0, // crc 占位（本测试不校验）
  ];
}

describe("normalizeImageQuery", () => {
  it("canonicalizes allowed params in fixed order", () => {
    const result = normalizeImageQuery(
      new URLSearchParams("fit=cover&width=100&quality=80"),
    );
    expect(result.ok).toBe(true);
    expect(result.query.toString()).toBe("width=100&quality=80&fit=cover");
  });

  it("rejects unknown or duplicate params", () => {
    expect(normalizeImageQuery(new URLSearchParams("foo=1")).ok).toBe(false);
    expect(
      normalizeImageQuery(new URLSearchParams("width=1&width=2")).ok,
    ).toBe(false);
  });

  it("rejects invalid values and original with transform params", () => {
    expect(normalizeImageQuery(new URLSearchParams("width=0")).ok).toBe(false);
    expect(normalizeImageQuery(new URLSearchParams("width=abc")).ok).toBe(
      false,
    );
    expect(normalizeImageQuery(new URLSearchParams("quality=101")).ok).toBe(
      false,
    );
    const originalWithTransform = normalizeImageQuery(
      new URLSearchParams("original=true&width=100&quality=80"),
    );
    expect(originalWithTransform.ok).toBe(true);
    expect(originalWithTransform.query.toString()).toBe("original=true");
  });

  it("allows cache-busting v only for site assets", () => {
    expect(
      normalizeImageQuery(new URLSearchParams("v=123"), { isAsset: false }).ok,
    ).toBe(false);
    const asset = normalizeImageQuery(new URLSearchParams("v=123"), {
      isAsset: true,
    });
    expect(asset.ok).toBe(true);
    expect(asset.query.toString()).toBe("v=123");
  });
});

describe("stripImageMetadata", () => {
  it("removes JPEG APP1 and COM segments", () => {
    const jpeg = new Uint8Array([
      0xff, 0xd8,
      0xff, 0xe1, 0x00, 0x08, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00,
      0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,
      0xff, 0xfe, 0x00, 0x04, 0x41, 0x41,
      0xff, 0xda, 0x00, 0x02, 0x12, 0x34,
    ]);

    const stripped = stripImageMetadata(jpeg, "image/jpeg");
    const hex = Array.from(stripped)
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");

    expect(hex.startsWith("ffd8ffe0")).toBe(true);
    expect(hex).not.toContain("fffe");
    expect(hex).not.toContain("45786966");
    expect(hex.endsWith("ffda00021234")).toBe(true);
  });

  it("removes PNG textual metadata chunks", () => {
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ...chunk("IHDR", [0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]),
      ...chunk("tEXt", Array.from("Author\0secret", (c) => c.charCodeAt(0))),
      ...chunk("IEND", []),
    ]);

    const stripped = stripImageMetadata(png, "image/png");
    const text = new TextDecoder().decode(stripped);
    expect(text).toContain("IHDR");
    expect(text).toContain("IEND");
    expect(text).not.toContain("Author");
  });

  it("leaves non-image metadata formats untouched", () => {
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
    expect(stripImageMetadata(gif, "image/gif")).toBe(gif);
  });
});
