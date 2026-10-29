export function getContentTypeFromKey(key: string): string | undefined {
  const extension = key.split(".").pop()?.toLowerCase();
  const contentTypes: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    gif: "image/gif",
    svg: "image/svg+xml",
    avif: "image/avif",
  };
  return contentTypes[extension || ""];
}

export function generateKey(fileName: string, extensionOverride?: string): string {
  const uuid = crypto.randomUUID();
  const extension = (
    extensionOverride ||
    fileName.split(".").pop() ||
    "bin"
  ).toLowerCase();

  return `${uuid}.${extension}`;
}

/**
 * 从图片 URL 中提取 R2 key
 * 支持格式：
 * - /images/${key}
 * - /images/${key}?quality=80&format=webp
 * - https://domain.com/images/${key}?quality=80
 */
export function extractImageKey(src: string): string | undefined {
  if (!src) return undefined;

  const prefix = "/images/";
  let pathname = "";

  try {
    // 尝试解析为 URL
    const url = new URL(src, "http://dummy.com"); // 传入 base 确保相对路径也能被解析
    pathname = url.pathname;
  } catch {
    // 极少数情况解析失败，手动截断 query
    pathname = src.split("?")[0];
  }

  if (pathname.startsWith(prefix)) {
    return pathname.replace(prefix, "");
  }
  return undefined;
}

/**
 * 生成优化后的图片 URL
 * @param key - R2 key
 * @param width - 可选的宽度限制
 */
export function getOptimizedImageUrl(key: string, width?: number) {
  return `/images/${key}?quality=80${width ? `&width=${width}` : ""}`;
}

const MAX_TRANSFORM_DIMENSION = 4096;
const ALLOWED_TRANSFORM_FITS = new Set([
  "scale-down",
  "contain",
  "cover",
  "crop",
  "pad",
]);

const MEDIA_KEY_PATTERN =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]+|asset\/[a-z0-9/._-]+)$/i;

/** 媒体 key 只允许 UUID 文件名或 asset/ 前缀，防止越界操作其它 R2 对象 */
export function isValidMediaKey(key: string): boolean {
  return MEDIA_KEY_PATTERN.test(key) && !key.includes("..");
}

/** 基于文件头识别图片真实类型（忽略客户端可控的 file.type） */
export function detectImageMime(bytes: Uint8Array): string | null {
  if (bytes.length < 4) return null;
  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image/png";
  }
  // GIF: 47 49 46 38
  if (
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38
  ) {
    return "image/gif";
  }
  // WebP: RIFF....WEBP
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

export function getExtensionForMime(mime: string): string {
  switch (mime) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    default:
      return "bin";
  }
}

export function buildTransformOptions(
  searchParams: URLSearchParams,
  accept: string,
) {
  const transformOptions: Record<string, unknown> = { quality: 80 };

  const readDimension = (name: "width" | "height") => {
    if (!searchParams.has(name)) return undefined;
    const value = Number.parseInt(searchParams.get(name)!, 10);
    if (Number.isNaN(value) || value <= 0) return undefined;
    // 限制最大尺寸，避免构造超大变换图消耗 Image Resizing 配额
    return Math.min(value, MAX_TRANSFORM_DIMENSION);
  };

  const width = readDimension("width");
  if (width) transformOptions.width = width;
  const height = readDimension("height");
  if (height) transformOptions.height = height;

  if (searchParams.has("quality")) {
    const quality = Number.parseInt(searchParams.get("quality")!, 10);
    if (!Number.isNaN(quality) && quality > 0 && quality <= 100)
      transformOptions.quality = quality;
  }

  const fit = searchParams.get("fit");
  if (fit && ALLOWED_TRANSFORM_FITS.has(fit)) transformOptions.fit = fit;

  if (/image\/avif/.test(accept)) {
    transformOptions.format = "avif";
  } else if (/image\/webp/.test(accept)) {
    transformOptions.format = "webp";
  }

  return transformOptions;
}

const IMAGE_QUERY_KEYS = new Set([
  "original",
  "width",
  "height",
  "quality",
  "fit",
  "v",
]);

/**
 * 严格校验/规范化 /images 查询参数：
 * - 只允许已知参数（含站点资源缓存版本 v）
 * - 非法值直接拒绝，避免任意 query 生成无限 CDN 缓存与 Image Resizing 调用
 * - 返回固定顺序的规范化参数，等价 URL 会收敛到同一缓存键
 */
export function normalizeImageQuery(
  searchParams: URLSearchParams,
  options: { isAsset?: boolean } = {},
): { ok: boolean; query: URLSearchParams } {
  const query = new URLSearchParams();
  const seen = new Set<string>();

  for (const key of searchParams.keys()) {
    if (!IMAGE_QUERY_KEYS.has(key)) return { ok: false, query };
    if (seen.has(key)) return { ok: false, query };
    seen.add(key);
    if (key === "v" && !options.isAsset) return { ok: false, query };
  }

  const original = searchParams.get("original");
  if (original !== null && original !== "true") return { ok: false, query };
  // 原图请求忽略 transform 参数（zoomable 会在已有 quality/width 的 URL 上追加 original=true）

  const readInteger = (name: string, min: number, max: number) => {
    const raw = searchParams.get(name);
    if (raw === null) return undefined;
    if (!/^\d+$/.test(raw)) return null;
    const value = Number.parseInt(raw, 10);
    if (value < min || value > max) return null;
    return value;
  };

  const width = readInteger("width", 1, MAX_TRANSFORM_DIMENSION);
  if (width === null) return { ok: false, query };
  const height = readInteger("height", 1, MAX_TRANSFORM_DIMENSION);
  if (height === null) return { ok: false, query };
  const quality = readInteger("quality", 1, 100);
  if (quality === null) return { ok: false, query };

  const fit = searchParams.get("fit");
  if (fit !== null && !ALLOWED_TRANSFORM_FITS.has(fit)) {
    return { ok: false, query };
  }

  const version = searchParams.get("v");
  if (version !== null && !/^[a-zA-Z0-9._-]{1,64}$/.test(version)) {
    return { ok: false, query };
  }

  if (original === "true") {
    query.set("original", "true");
  } else {
    if (width !== undefined) query.set("width", String(width));
    if (height !== undefined) query.set("height", String(height));
    if (quality !== undefined) query.set("quality", String(quality));
    if (fit !== null) query.set("fit", fit);
  }
  if (version !== null) query.set("v", version);

  return { ok: true, query };
}

function concatBytes(parts: Array<Uint8Array>): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function stripJpegMetadata(bytes: Uint8Array): Uint8Array {
  // 移除 APP1(EXIF/XMP)、APP13、COM，保留其余段与压缩数据
  const parts: Array<Uint8Array> = [bytes.slice(0, 2)];
  let offset = 2;

  while (offset + 4 <= bytes.length) {
    const segmentStart = offset;
    let markerOffset = offset;
    while (markerOffset < bytes.length && bytes[markerOffset] === 0xff) {
      markerOffset += 1;
    }
    if (markerOffset >= bytes.length) return bytes;
    const marker = bytes[markerOffset];

    // SOS：复制剩余所有压缩数据
    if (marker === 0xda) {
      parts.push(bytes.slice(segmentStart));
      return concatBytes(parts);
    }

    // 无长度字段的标记
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      parts.push(bytes.slice(segmentStart, markerOffset + 1));
      offset = markerOffset + 1;
      continue;
    }

    if (marker === 0xd9) {
      parts.push(bytes.slice(segmentStart, markerOffset + 1));
      return concatBytes(parts);
    }

    const lengthOffset = markerOffset + 1;
    if (lengthOffset + 2 > bytes.length) return bytes;
    const segmentLength =
      (bytes[lengthOffset] << 8) | bytes[lengthOffset + 1];
    if (segmentLength < 2 || lengthOffset + segmentLength > bytes.length) {
      return bytes;
    }

    const drop =
      marker === 0xe1 || marker === 0xed || marker === 0xfe;
    if (!drop) {
      parts.push(bytes.slice(segmentStart, lengthOffset + segmentLength));
    }
    offset = lengthOffset + segmentLength;
  }

  return bytes;
}

function stripPngMetadata(bytes: Uint8Array): Uint8Array {
  const parts: Array<Uint8Array> = [bytes.slice(0, 8)];
  let offset = 8;
  let sawIend = false;
  while (offset + 12 <= bytes.length) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset);
    const length = view.getUint32(0);
    const type = String.fromCharCode(
      bytes[offset + 4],
      bytes[offset + 5],
      bytes[offset + 6],
      bytes[offset + 7],
    );
    const end = offset + 12 + length;
    if (end > bytes.length) return bytes;
    const drop = ["tEXt", "zTXt", "iTXt", "eXIf"].includes(type);
    if (!drop) parts.push(bytes.slice(offset, end));
    offset = end;
    if (type === "IEND") {
      sawIend = true;
      break;
    }
  }
  // 结构不完整时不做修改，避免破坏异常/截断图片
  return sawIend ? concatBytes(parts) : bytes;
}

function stripWebpMetadata(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 20) return bytes;
  const parts: Array<Uint8Array> = [];
  const kept: Array<Uint8Array> = [];
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset);
    const type = String.fromCharCode(
      bytes[offset],
      bytes[offset + 1],
      bytes[offset + 2],
      bytes[offset + 3],
    );
    const length = view.getUint32(4, true);
    const end = offset + 8 + length + (length % 2);
    if (end > bytes.length) return bytes;
    if (type !== "EXIF" && type !== "XMP ") {
      kept.push(bytes.slice(offset, end));
    }
    offset = end;
    if (offset >= bytes.length) break;
  }
  if (offset < bytes.length) kept.push(bytes.slice(offset));
  const body = concatBytes(kept);
  const header = bytes.slice(0, 12).slice();
  const size = body.byteLength + 4;
  header[4] = size & 0xff;
  header[5] = (size >> 8) & 0xff;
  header[6] = (size >> 16) & 0xff;
  header[7] = (size >> 24) & 0xff;
  parts.push(header, body);
  return concatBytes(parts);
}

/** 上传前剥离 EXIF/GPS/XMP/注释等元数据，避免原图泄露拍摄位置等信息 */
export function stripImageMetadata(
  bytes: Uint8Array,
  mimeType: string,
): Uint8Array {
  try {
    if (mimeType === "image/jpeg") return stripJpegMetadata(bytes);
    if (mimeType === "image/png") return stripPngMetadata(bytes);
    if (mimeType === "image/webp") return stripWebpMetadata(bytes);
    return bytes;
  } catch {
    return bytes;
  }
}
