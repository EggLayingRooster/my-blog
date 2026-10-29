import { beforeEach, describe, expect, it } from "vitest";
import { blogConfig } from "@/blog.config";
import {
  DEFAULT_CONFIG,
  type SystemConfig,
} from "@/features/config/config.schema";
import * as ConfigRepo from "@/features/config/data/config.data";
import * as ConfigService from "@/features/config/service/config.service";
import { SystemConfigTable } from "@/lib/db/schema";
import { createAdminTestContext, seedUser } from "tests/test-utils";

describe("Config Integration", () => {
  let context: ReturnType<typeof createAdminTestContext>;

  beforeEach(async () => {
    context = createAdminTestContext();
    await seedUser(context.db, context.session.user);
  });

  it("preserves unrelated config fields on partial update", async () => {
    await ConfigRepo.upsertSystemConfig(context.db, {
      ...DEFAULT_CONFIG,
      email: {
        ...DEFAULT_CONFIG.email,
        host: "smtp.example.com",
        password: "super-secret",
      },
      site: {
        ...DEFAULT_CONFIG.site,
        title: "Old Title",
      },
    });

    await ConfigService.updateSystemConfig(context, {
      site: { title: "New Title" },
    });

    const config = await ConfigService.getSystemConfig(context);
    expect(config.site?.title).toBe("New Title");
    expect(config.email?.host).toBe("smtp.example.com");
    expect(config.email?.password).toBe("super-secret");
    expect(config.notification?.admin?.channels?.email).toBe(true);
  });

  it("bumps config cache version so reads see the new value", async () => {
    await ConfigRepo.upsertSystemConfig(context.db, {
      ...DEFAULT_CONFIG,
      site: { ...DEFAULT_CONFIG.site, title: "Before Cache" },
    });

    expect((await ConfigService.getSystemConfig(context)).site?.title).toBe(
      "Before Cache",
    );

    await ConfigService.updateSystemConfig(context, {
      site: { title: "After Cache" },
    });

    expect((await ConfigService.getSystemConfig(context)).site?.title).toBe(
      "After Cache",
    );
  });

  it("falls back to blogConfig when stored site config is invalid", () => {
    const invalid = {
      site: {
        social: [{ platform: "github", url: "javascript:alert(1)" }],
      },
    } as SystemConfig;

    const resolved = ConfigService.resolveSiteConfig(invalid);
    expect(resolved.title).toBe(blogConfig.title);
    expect(resolved.social.some((link) => link.url.startsWith("javascript:"))).toBe(
      false,
    );
  });

  it("removes duplicate config rows on save", async () => {
    await ConfigRepo.upsertSystemConfig(context.db, {
      ...DEFAULT_CONFIG,
      site: { ...DEFAULT_CONFIG.site, title: "First" },
    });
    await context.db.insert(SystemConfigTable).values({
      configJson: { ...DEFAULT_CONFIG, site: { ...DEFAULT_CONFIG.site, title: "Second" } },
    });

    await ConfigService.updateSystemConfig(context, {
      site: { title: "Third" },
    });

    const rows = await context.db.query.SystemConfigTable.findMany();
    expect(rows).toHaveLength(1);
    expect((await ConfigService.getSystemConfig(context)).site?.title).toBe(
      "Third",
    );
  });

  it("masks secrets for admin reads and restores them on save", async () => {
    await ConfigService.updateSystemConfig(context, {
      ...DEFAULT_CONFIG,
      email: {
        ...DEFAULT_CONFIG.email,
        password: "smtp-secret",
      },
      notification: {
        ...DEFAULT_CONFIG.notification,
        webhooks: [
          {
            id: "webhook-1",
            name: "test",
            url: "https://example.com/hook",
            enabled: true,
            secret: "webhook-secret-16",
            events: [],
          },
        ],
      },
    });

    const config = await ConfigService.getSystemConfig(context);
    const masked = ConfigService.maskSystemConfigSecrets(config);
    expect(masked.email?.password).toBe(ConfigService.SECRET_MASK);
    expect(masked.notification?.webhooks?.[0]?.secret).toBe(
      ConfigService.SECRET_MASK,
    );

    await ConfigService.updateSystemConfig(context, masked);
    const saved = await ConfigService.getSystemConfig(context);
    expect(saved.email?.password).toBe("smtp-secret");
    expect(saved.notification?.webhooks?.[0]?.secret).toBe("webhook-secret-16");
  });

  it("rejects stale config updates with optimistic locking", async () => {
    await ConfigService.updateSystemConfig(context, {
      ...DEFAULT_CONFIG,
      site: { ...DEFAULT_CONFIG.site, title: "Version 1" },
    });
    const first = await ConfigRepo.getSystemConfigWithMeta(context.db);
    expect(first).not.toBeNull();

    await ConfigService.updateSystemConfig(context, {
      site: { title: "Version 2" },
    });

    await expect(
      ConfigService.updateSystemConfig(
        context,
        { site: { title: "Stale" } },
        { expectedVersion: first!.version },
      ),
    ).rejects.toThrow("CONFIG_CONFLICT");

    expect((await ConfigService.getSystemConfig(context)).site?.title).toBe(
      "Version 2",
    );
  });
});
