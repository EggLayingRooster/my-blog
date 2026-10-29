import type { ThemeName } from "@/features/theme/registry";
import { themeNames } from "@/features/theme/registry";
import type { Messages } from "@/lib/i18n";

export const SITE_ASSET_MAX_FILE_SIZE = 8 * 1024 * 1024; // 8MB

export const SITE_ASSET_ACCEPTED_TYPES = [
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/svg+xml",
  "image/x-icon",
  "image/vnd.microsoft.icon",
] as const;

type ThemePrefix = `themes/${ThemeName}/`;
const themePrefixes = themeNames.map(
  (name) => `themes/${name}/` satisfies ThemePrefix,
);
const ALLOWED_ASSET_PREFIXES = [
  "favicon/",
  "social/",
  ...themePrefixes,
] as const;

function isAllowedAssetPath(path: string): boolean {
  const normalized = path.replace(/^\/+/, "").replace(/\\/g, "/");
  // 禁止路径穿越/特殊字符，只允许常规资源路径字符
  if (normalized.includes("..") || !/^[a-z0-9/._-]+$/i.test(normalized)) {
    return false;
  }
  return ALLOWED_ASSET_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export function parseSiteAssetUploadInput(
  formData: FormData,
  messages: Messages,
): { file: File; assetPath: string } {
  const file = formData.get("file");
  if (!(file instanceof File)) {
    throw new Error(messages.settings_asset_validation_file_required());
  }

  const assetPath = formData.get("assetPath");
  if (typeof assetPath !== "string" || !assetPath.trim()) {
    throw new Error(messages.settings_asset_validation_path_required());
  }

  const trimmedPath = assetPath.trim().replace(/^\/+/, "").replace(/\\/g, "/");
  if (!isAllowedAssetPath(trimmedPath)) {
    throw new Error(messages.settings_asset_validation_path_invalid());
  }

  if (file.size > SITE_ASSET_MAX_FILE_SIZE) {
    throw new Error(messages.settings_asset_validation_file_too_large());
  }

  const mime = file.type.toLowerCase();
  const ext = file.name.split(".").pop()?.toLowerCase();
  const allowedMimes = new Set<string>(SITE_ASSET_ACCEPTED_TYPES);
  const allowedExts = new Set([
    "jpeg",
    "jpg",
    "png",
    "webp",
    "gif",
    "svg",
    "ico",
  ]);

  if (!allowedMimes.has(mime) && !allowedExts.has(ext ?? "")) {
    throw new Error(messages.settings_asset_validation_file_invalid_type());
  }

  return { file, assetPath: trimmedPath };
}

/** 基础 SVG 安全检查：拒绝脚本、事件处理器、foreignObject 与 javascript: 链接 */
export function isSafeSvgAsset(bytes: Uint8Array): boolean {
  const sample = new TextDecoder("utf-8", { fatal: false })
    .decode(bytes.slice(0, 64 * 1024))
    .trimStart()
    .toLowerCase();

  if (!sample.startsWith("<?xml") && !sample.startsWith("<svg")) return false;
  if (!sample.includes("<svg")) return false;
  if (sample.includes("<script")) return false;
  if (sample.includes("<foreignobject")) return false;
  if (sample.includes("javascript:")) return false;
  if (/\son[a-z]+\s*=/.test(sample)) return false;

  return true;
}

export function isIcoAsset(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x00 &&
    bytes[1] === 0x00 &&
    bytes[2] === 0x01 &&
    bytes[3] === 0x00
  );
}
