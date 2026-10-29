import { blogConfig } from "@/blog.config";
import * as CacheService from "@/features/cache/cache.service";
import { CACHE_NAMESPACES } from "@/features/cache/types";
import type { SiteConfig, SystemConfig } from "@/features/config/config.schema";
import {
  CONFIG_CACHE_KEYS,
  DEFAULT_CONFIG,
  SystemConfigSchema,
} from "@/features/config/config.schema";
import { recordAdminAudit } from "@/features/admin-audit/service/admin-audit.service";
import * as ConfigRepo from "@/features/config/data/config.data";
import {
  isIcoAsset,
  isSafeSvgAsset,
} from "@/features/config/config.asset.schema";
import { FullSiteConfigSchema, SocialLinkSchema } from "@/features/config/site-config.schema";
import type { SocialLink } from "@/features/config/utils/social-platforms";
import * as Storage from "@/features/media/data/media.storage";
import { purgeSiteCDNCache } from "@/lib/invalidate";

export const SECRET_MASK = "****************";

export function maskSystemConfigSecrets(config: SystemConfig): SystemConfig {
  const masked = structuredClone(config);
  if (masked.email) {
    if (masked.email.password) masked.email.password = SECRET_MASK;
    if (masked.email.apiKey) masked.email.apiKey = SECRET_MASK;
  }
  if (masked.notification?.webhooks) {
    masked.notification.webhooks = masked.notification.webhooks.map(
      (webhook) => ({
        ...webhook,
        secret: webhook.secret ? SECRET_MASK : webhook.secret,
      }),
    );
  }
  return masked;
}

export function restoreMaskedSecrets(
  patch: SystemConfig,
  current: SystemConfig | null | undefined,
): SystemConfig {
  const restored = structuredClone(patch);
  if (restored.email) {
    if (restored.email.password === SECRET_MASK) {
      restored.email.password = current?.email?.password ?? "";
    }
    if (restored.email.apiKey === SECRET_MASK) {
      restored.email.apiKey = current?.email?.apiKey ?? "";
    }
  }
  if (restored.notification?.webhooks) {
    const currentById = new Map(
      (current?.notification?.webhooks ?? []).map((webhook) => [
        webhook.id,
        webhook,
      ]),
    );
    restored.notification.webhooks = restored.notification.webhooks.map(
      (webhook) =>
        webhook.secret === SECRET_MASK
          ? {
              ...webhook,
              secret: currentById.get(webhook.id)?.secret ?? webhook.secret,
            }
          : webhook,
    );
  }
  return restored;
}

const DEFAULT_SMTP_PORT = 465;
const RESEND_SMTP_HOST = "smtp.resend.com";
const RESEND_SMTP_USERNAME = "resend";

function resolveEmailConfig(config: SystemConfig | null | undefined) {
  const email = config?.email;
  const legacyApiKey = email?.apiKey?.trim() || "";
  const password = email?.password?.trim() || legacyApiKey;
  const host = email?.host?.trim() || (legacyApiKey ? RESEND_SMTP_HOST : "");
  const username =
    email?.username?.trim() || (legacyApiKey ? RESEND_SMTP_USERNAME : "");

  return {
    host,
    port: email?.port ?? DEFAULT_SMTP_PORT,
    username,
    password,
    senderName: email?.senderName ?? "",
    senderAddress: email?.senderAddress ?? "",
  };
}

export function resolveSystemConfig(
  config: SystemConfig | null | undefined,
): SystemConfig {
  return {
    ...DEFAULT_CONFIG,
    ...config,
    email: resolveEmailConfig(config),
    notification: {
      ...DEFAULT_CONFIG.notification,
      ...config?.notification,
      admin: {
        ...DEFAULT_CONFIG.notification?.admin,
        ...config?.notification?.admin,
        channels: {
          ...DEFAULT_CONFIG.notification?.admin?.channels,
          ...config?.notification?.admin?.channels,
        },
      },
      user: {
        ...DEFAULT_CONFIG.notification?.user,
        ...config?.notification?.user,
      },
      webhooks:
        config?.notification?.webhooks ?? DEFAULT_CONFIG.notification?.webhooks,
    },
    site: resolveSiteConfig(config),
  };
}

/**
 * 深合并配置：数组整体替换，对象逐层合并。
 * 用于把 API 的 partial patch 合并到当前 DB 配置，避免缺失字段回退 DEFAULT_CONFIG。
 */
function deepMergeConfig<T>(base: T | undefined, patch: T | undefined): T | undefined {
  if (patch === undefined) return base;
  if (base === undefined) return patch;
  if (
    Array.isArray(base) ||
    Array.isArray(patch) ||
    typeof base !== "object" ||
    typeof patch !== "object" ||
    base === null ||
    patch === null
  ) {
    return patch;
  }

  const result: Record<string, unknown> = {
    ...(base as Record<string, unknown>),
  };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    result[key] = deepMergeConfig(
      (base as Record<string, unknown>)[key],
      value,
    );
  }
  return result as T;
}

function migrateSocial(social: unknown): SocialLink[] {
  // New format — already an array
  if (Array.isArray(social)) return social;

  // Old format — { github?: string, email?: string }
  if (social && typeof social === "object") {
    const old = social as { github?: string; email?: string };
    const migrated: SocialLink[] = [];
    if (old.github) migrated.push({ platform: "github", url: old.github });
    if (old.email)
      migrated.push({ platform: "email", url: `mailto:${old.email}` });
    return migrated;
  }

  // Fallback to blogConfig defaults
  return [...blogConfig.social];
}

/** 读取时丢弃不安全/非法 social 链接，单条坏数据不影响整份站点配置 */
function sanitizeSocialLinks(links: SocialLink[]): SocialLink[] {
  return links.flatMap((link) => {
    const normalized =
      link.platform === "email" &&
      !link.url.includes(":") &&
      link.url.includes("@")
        ? { ...link, url: `mailto:${link.url}` }
        : link;
    const result = SocialLinkSchema.safeParse(normalized);
    if (!result.success) {
      console.error(
        JSON.stringify({
          message: "dropped invalid social link",
          platform: link.platform,
        }),
      );
      return [];
    }
    return [result.data];
  });
}

export function resolveSiteConfig(
  config: SystemConfig | null | undefined,
): SiteConfig {
  const configDefaultBackground = config?.site?.theme?.default?.background;

  const parsed = {
    title: config?.site?.title ?? blogConfig.title,
    author: config?.site?.author ?? blogConfig.author,
    description: config?.site?.description ?? blogConfig.description,
    social: sanitizeSocialLinks(migrateSocial(config?.site?.social)),
    icons: {
      faviconSvg:
        config?.site?.icons?.faviconSvg || blogConfig.icons.faviconSvg,
      faviconIco:
        config?.site?.icons?.faviconIco || blogConfig.icons.faviconIco,
      favicon96: config?.site?.icons?.favicon96 || blogConfig.icons.favicon96,
      appleTouchIcon:
        config?.site?.icons?.appleTouchIcon || blogConfig.icons.appleTouchIcon,
      webApp192: config?.site?.icons?.webApp192 || blogConfig.icons.webApp192,
      webApp512: config?.site?.icons?.webApp512 || blogConfig.icons.webApp512,
    },
    theme: {
      default: {
        navBarName:
          config?.site?.theme?.default?.navBarName ??
          blogConfig.theme.default.navBarName,
        background: configDefaultBackground
          ? {
              homeImage: configDefaultBackground.homeImage ?? "",
              globalImage: configDefaultBackground.globalImage ?? "",
              light: {
                opacity: configDefaultBackground.light?.opacity ?? 0.15,
              },
              dark: {
                opacity: configDefaultBackground.dark?.opacity ?? 0.1,
              },
              backdropBlur: configDefaultBackground.backdropBlur ?? 8,
              transitionDuration:
                configDefaultBackground.transitionDuration ?? 600,
            }
          : undefined,
      },
      fuwari: {
        homeBg:
          config?.site?.theme?.fuwari?.homeBg ?? blogConfig.theme.fuwari.homeBg,
        avatar:
          config?.site?.theme?.fuwari?.avatar ?? blogConfig.theme.fuwari.avatar,
        primaryHue:
          config?.site?.theme?.fuwari?.primaryHue ??
          blogConfig.theme.fuwari.primaryHue,
      },
    },
  };

  try {
    return FullSiteConfigSchema.parse(parsed);
  } catch (error) {
    // 损坏/旧格式配置不能让公共页面 500：降级到 blogConfig 并记录
    console.error(
      JSON.stringify({
        message: "invalid site config, falling back to blogConfig",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return FullSiteConfigSchema.parse(blogConfig);
  }
}

function hasSiteConfigChanged(
  currentConfig: SystemConfig | null | undefined,
  nextConfig: SystemConfig | null | undefined,
) {
  return (
    JSON.stringify(resolveSiteConfig(currentConfig)) !==
    JSON.stringify(resolveSiteConfig(nextConfig))
  );
}

export async function getSystemConfig(
  context: DbContext & { executionCtx: ExecutionContext },
) {
  // 版本化缓存：update 时 bump version，旧并发请求的 waitUntil 写入不会复活旧配置
  let version: string | null = null;
  try {
    version = await CacheService.getVersion(context, CACHE_NAMESPACES.CONFIG);
  } catch {
    version = null;
  }

  const config = await CacheService.getVersioned(
    context,
    CACHE_NAMESPACES.CONFIG,
    (cacheVersion) => ["system", cacheVersion],
    SystemConfigSchema,
    async () =>
      resolveSystemConfig(await ConfigRepo.getSystemConfig(context.db)),
  );

  const normalizedConfig = resolveSystemConfig(config);

  if (
    version &&
    JSON.stringify(config) !== JSON.stringify(normalizedConfig)
  ) {
    context.executionCtx.waitUntil(
      CacheService.set(
        context,
        ["system", version],
        JSON.stringify(normalizedConfig),
        { ttl: "1h" },
      ),
    );
  }

  return normalizedConfig;
}

export async function getSiteConfig(
  context: DbContext & { executionCtx: ExecutionContext },
) {
  const config = await getSystemConfig(context);
  return resolveSiteConfig(config);
}

export async function getSystemConfigAdmin(
  context: DbContext & { executionCtx: ExecutionContext },
) {
  const config = await getSystemConfig(context);
  const row = await ConfigRepo.getSystemConfigWithMeta(context.db);
  return {
    config: maskSystemConfigSecrets(config),
    updatedAt: row?.updatedAt.toISOString() ?? null,
    version: row?.version ?? 0,
  };
}

export async function updateSystemConfig(
  context: DbContext & { executionCtx: ExecutionContext },
  data: SystemConfig,
  options: { expectedUpdatedAt?: string; expectedVersion?: number } = {},
) {
  const currentRow = await ConfigRepo.getSystemConfigWithMeta(context.db);
  const currentConfig = currentRow?.config ?? null;
  if (
    options.expectedVersion !== undefined &&
    currentRow &&
    currentRow.version !== options.expectedVersion
  ) {
    throw new Error("CONFIG_CONFLICT");
  }
  // 掩码字段未修改时沿用当前密钥，避免把 **************** 写进数据库
  const restoredData = restoreMaskedSecrets(data, currentConfig);
  // 深合并：允许只提交部分字段，缺失字段沿用当前配置而不是 DEFAULT_CONFIG
  const mergedConfig =
    deepMergeConfig(currentConfig ?? {}, restoredData) ?? restoredData;
  const nextConfig = resolveSystemConfig(mergedConfig);

  await ConfigRepo.upsertSystemConfig(context.db, nextConfig);
  await CacheService.bumpVersion(context, CACHE_NAMESPACES.CONFIG);
  // 清理旧版静态 key（升级兼容）
  await CacheService.deleteKey(context, CONFIG_CACHE_KEYS.system);

  if (hasSiteConfigChanged(currentConfig, nextConfig)) {
    await purgeSiteCDNCache(context.env);
  }

  const changedKeys = Object.keys(data).filter(
    (key) => data[key as keyof SystemConfig] !== undefined,
  );
  console.log(
    JSON.stringify({
      message: "system config updated",
      changedKeys,
    }),
  );
  await recordAdminAudit(context, {
    action: "config.update",
    resourceType: "system_config",
    metadata: { changedKeys },
  });

  return { success: true };
}

export async function uploadSiteAsset(
  context: { env: Env },
  input: { file: File; assetPath: string },
): Promise<{ url: string }> {
  const mime = input.file.type.toLowerCase();
  const isSvg = mime.includes("svg") || /\.svg$/i.test(input.file.name);
  const isIco = mime.includes("icon") || /\.ico$/i.test(input.file.name);

  const bytes = new Uint8Array(await input.file.arrayBuffer());

  let contentType = mime;
  let storedBytes: Uint8Array = bytes;

  if (isSvg) {
    if (!isSafeSvgAsset(bytes)) {
      throw new Error("Invalid SVG file");
    }
    contentType = "image/svg+xml";
  } else if (isIco) {
    if (!isIcoAsset(bytes)) {
      throw new Error("Invalid ICO file");
    }
    contentType = "image/x-icon";
  } else {
    const { detectImageMime, stripImageMetadata } = await import(
      "@/features/media/utils/media.utils"
    );
    const detectedMime = detectImageMime(bytes);
    if (!detectedMime) {
      throw new Error("Invalid image file");
    }
    contentType = detectedMime;
    storedBytes = stripImageMetadata(bytes, detectedMime);
  }

  const { url } = await Storage.putSiteAsset(
    context.env,
    input.file,
    input.assetPath,
    { contentType, bytes: storedBytes },
  );

  const timestamp = Math.floor(Date.now() / 1000);
  const isFavicon = input.assetPath.startsWith("favicon/");
  const finalUrl = isFavicon
    ? `${url}?original=true&v=${timestamp}`
    : `${url}?v=${timestamp}`;

  return { url: finalUrl };
}
