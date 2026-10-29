import { describe, expect, it } from "vitest";
import { SystemConfigSchema } from "./config.schema";
import { SocialLinkSchema } from "./site-config.schema";

describe("config validation", () => {
  it("rejects javascript and data social links", () => {
    expect(() =>
      SocialLinkSchema.parse({
        platform: "github",
        url: "javascript:alert(1)",
      }),
    ).toThrow();
    expect(() =>
      SocialLinkSchema.parse({
        platform: "github",
        url: "data:text/html,<script>alert(1)</script>",
      }),
    ).toThrow();
  });

  it("allows https, mailto for email, and root-relative rss links", () => {
    expect(
      SocialLinkSchema.parse({
        platform: "github",
        url: "https://github.com/example",
      }).url,
    ).toBe("https://github.com/example");
    expect(
      SocialLinkSchema.parse({
        platform: "email",
        url: "mailto:example@example.com",
      }).platform,
    ).toBe("email");
    expect(
      SocialLinkSchema.parse({ platform: "rss", url: "/rss.xml" }).url,
    ).toBe("/rss.xml");
  });

  it("bounds email config lengths", () => {
    expect(() =>
      SystemConfigSchema.parse({
        email: { host: "h".repeat(254) },
      }),
    ).toThrow();
    expect(() =>
      SystemConfigSchema.parse({
        email: { port: 70000 },
      }),
    ).toThrow();
  });
});
