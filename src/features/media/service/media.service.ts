import * as MediaRepo from "@/features/media/data/media.data";
import { recordAdminAudit } from "@/features/admin-audit/service/admin-audit.service";
import * as Storage from "@/features/media/data/media.storage";
import type {
  GetMediaListInput,
  UpdateMediaNameInput,
} from "@/features/media/media.schema";
import { getImageDimensions } from "@/features/media/utils/image-dimensions";
import {
  buildTransformOptions,
  detectImageMime,
  getContentTypeFromKey,
  getExtensionForMime,
  stripImageMetadata,
} from "@/features/media/utils/media.utils";
import * as PostMediaRepo from "@/features/posts/data/post-media.data";
import { getDb } from "@/lib/db";
import { CACHE_CONTROL } from "@/lib/constants";
import { purgeCDNCache } from "@/lib/invalidate";
import { err, ok } from "@/lib/errors";

export async function upload(
  context: DbContext & { executionCtx: ExecutionContext },
  input: { file: File },
) {
  const { file } = input;

  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  // 服务端按文件头识别真实图片类型，忽略客户端可控的 file.type
  const detectedMime = detectImageMime(bytes);
  if (!detectedMime) {
    return err({ reason: "MEDIA_INVALID_TYPE" });
  }
  const extension = getExtensionForMime(detectedMime);

  const dimensions = getImageDimensions(buffer);
  const width = dimensions?.width;
  const height = dimensions?.height;

  // 剥离 EXIF/GPS/XMP 等元数据，避免原图泄露隐私
  const sanitizedBytes = stripImageMetadata(bytes, detectedMime);

  const uploaded = await Storage.putToR2(context.env, file, {
    contentType: detectedMime,
    extension,
    bytes: sanitizedBytes,
  });

  try {
    const mediaRecord = await MediaRepo.insertMedia(context.db, {
      key: uploaded.key,
      url: uploaded.url,
      fileName: uploaded.fileName,
      mimeType: uploaded.mimeType,
      sizeInBytes: uploaded.sizeInBytes,
      width,
      height,
    });
    await recordAdminAudit(context, {
      action: "media.upload",
      resourceType: "media",
      resourceId: mediaRecord.key,
      metadata: { mimeType: mediaRecord.mimeType, size: mediaRecord.sizeInBytes },
    });
    return ok(mediaRecord);
  } catch (error) {
    console.error(
      JSON.stringify({
        message: "media db insert failed, rolling back r2 upload",
        key: uploaded.key,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    context.executionCtx.waitUntil(
      Storage.deleteFromR2(context.env, uploaded.key).catch((rollbackError) =>
        console.error(
          JSON.stringify({
            message: "r2 rollback delete failed",
            key: uploaded.key,
            error:
              rollbackError instanceof Error
                ? rollbackError.message
                : String(rollbackError),
          }),
        ),
      ),
    );
    return err({ reason: "MEDIA_RECORD_CREATE_FAILED" });
  }
}

export async function deleteImage(
  context: DbContext & { executionCtx: ExecutionContext },
  key: string,
) {
  // 后端兜底检查：防止删除正在被引用的媒体
  const inUse = await PostMediaRepo.isMediaInUse(context.db, key);
  if (inUse) {
    return err({ reason: "MEDIA_IN_USE" });
  }

  const deleted = await MediaRepo.deleteMediaIfUnused(context.db, key);
  if (!deleted) {
    // 检查后到删除前被文章引用：按幂等错误返回
    return err({ reason: "MEDIA_IN_USE" });
  }

  context.executionCtx.waitUntil(
    Promise.all([
      Storage.deleteFromR2(context.env, key).catch((deleteError) => {
        console.error(
          JSON.stringify({
            message: "r2 delete failed",
            key,
            error:
              deleteError instanceof Error
                ? deleteError.message
                : String(deleteError),
          }),
        );
      }),
      // 图片响应是 immutable 缓存，删除后必须清理 /images/${key} 前缀
      purgeCDNCache(context.env, {
        prefixes: [`/images/${key}`],
      }).catch((purgeError) => {
        console.error(
          JSON.stringify({
            message: "media cdn purge failed",
            key,
            error:
              purgeError instanceof Error
                ? purgeError.message
                : String(purgeError),
          }),
        );
      }),
    ]),
  );

  return ok({ success: true });
}

export async function getMediaList(
  context: DbContext,
  data: GetMediaListInput,
) {
  return await MediaRepo.getMediaList(context.db, data);
}

export async function isMediaInUse(context: DbContext, key: string) {
  return await PostMediaRepo.isMediaInUse(context.db, key);
}

export async function getLinkedPosts(context: DbContext, key: string) {
  return await PostMediaRepo.getPostsByMediaKey(context.db, key);
}

export async function getLinkedMediaKeys(
  context: DbContext,
  keys: Array<string>,
) {
  return await PostMediaRepo.getLinkedMediaKeys(context.db, keys);
}

export async function getTotalMediaSize(context: DbContext) {
  return await MediaRepo.getTotalMediaSize(context.db);
}

export async function updateMediaName(
  context: DbContext,
  data: UpdateMediaNameInput,
) {
  return await MediaRepo.updateMediaName(context.db, data.key, data.name);
}

export async function handleImageRequest(
  env: Env,
  key: string,
  request: Request,
) {
  const url = new URL(request.url);
  const searchParams = url.searchParams;

  const serveOriginal = async () => {
    const object = await env.R2.get(key);
    if (!object) {
      return new Response("Image not found", { status: 404 });
    }

    const contentType =
      object.httpMetadata?.contentType ||
      getContentTypeFromKey(key) ||
      "application/octet-stream";

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("Content-Type", contentType);
    headers.set("ETag", object.httpEtag);
    headers.set("Cache-Control", "public, max-age=300, must-revalidate");
    headers.set("X-Content-Type-Options", "nosniff");

    if (request.headers.get("if-none-match") === object.httpEtag) {
      return new Response(null, { status: 304, headers });
    }

    // SVG 作为同源资源返回时可能执行脚本（存储型 XSS），强制沙箱化并禁止脚本
    if (/image\/svg\+xml/i.test(contentType)) {
      headers.set("Content-Disposition", 'inline; filename="image.svg"');
      headers.set(
        "Content-Security-Policy",
        "sandbox; default-src 'none'; style-src 'unsafe-inline'",
      );
    }

    return new Response(object.body, { headers });
  };

  // 1. 防止循环调用 & 显式请求原图
  const viaHeader = request.headers.get("via");
  const isLoop = viaHeader && /image-resizing/.test(viaHeader);
  const wantsOriginal = searchParams.get("original") === "true";

  if (isLoop || wantsOriginal) {
    return await serveOriginal();
  }

  // 2. 构建 Cloudflare Image Resizing 参数
  const transformOptions = buildTransformOptions(
    searchParams,
    request.headers.get("Accept") || "",
  );

  // 3. 尝试进行图片处理
  try {
    const origin = url.origin;
    const sourceImageUrl = `${origin}/images/${key}?original=true`;

    const subRequestHeaders = new Headers();

    const headersToKeep = ["user-agent", "accept"];
    for (const [k, v] of request.headers.entries()) {
      if (headersToKeep.includes(k.toLowerCase())) {
        subRequestHeaders.set(k, v);
      }
    }

    const imageRequest = new Request(sourceImageUrl, {
      headers: subRequestHeaders,
    });

    // 调用 Cloudflare Images 变换
    const response = await fetch(imageRequest, {
      cf: { image: transformOptions },
    });

    // 如果变换失败 (如格式不支持)，降级回原图
    if (!response.ok) {
      console.error(
        JSON.stringify({
          message: "image transform failed",
          key,
          status: response.status,
          statusText: response.statusText,
        }),
      );
      return await serveOriginal();
    }

    // 4. 返回处理后的图片
    // 使用 new Response(response.body, response) 保持状态码和其它优化头信息
    const newResponse = new Response(response.body, response);

    // 覆盖/补充必要的缓存头
    newResponse.headers.set("Vary", "Accept");
    newResponse.headers.set("X-Content-Type-Options", "nosniff");
    Object.entries(CACHE_CONTROL.immutable).forEach(([k, v]) => {
      newResponse.headers.set(k, v);
    });

    return newResponse;
  } catch (e) {
    console.error(
      JSON.stringify({
        message: "image transform error",
        key,
        error: e instanceof Error ? e.message : String(e),
      }),
    );
    return await serveOriginal();
  }
}

const MEDIA_METADATA_CURSOR_KEY = "media:metadata-backfill:cursor";

/**
 * 历史媒体元数据回溯：分批读取 R2 原图，剥离 EXIF/GPS/XMP 后覆盖写回。
 * 由每日 scheduled 任务调用，逐步清理历史图片。
 */
export async function backfillMediaMetadata(
  env: Env,
  options: { limit?: number } = {},
): Promise<{ processed: number; changed: number }> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
  const cursorRaw = await env.KV.get(MEDIA_METADATA_CURSOR_KEY);
  const cursor = Number.parseInt(cursorRaw ?? "0", 10) || 0;
  const db = getDb(env);
  const rows = await MediaRepo.getMediaBatchForMetadataBackfill(db, {
    cursor,
    limit,
  });

  if (rows.length === 0) {
    return { changed: 0, processed: 0 };
  }

  let changed = 0;
  let processed = 0;
  let lastId = cursor;

  for (const row of rows) {
    processed += 1;
    lastId = row.id;
    try {
      const object = await Storage.getFromR2(env, row.key);
      if (!object) continue;
      const bytes = new Uint8Array(await object.arrayBuffer());
      const mime = detectImageMime(bytes) ?? row.mimeType;
      if (!mime.startsWith("image/")) continue;
      const stripped = stripImageMetadata(bytes, mime);
      if (stripped.length === bytes.length) continue;

      await env.R2.put(row.key, stripped, {
        httpMetadata: { contentType: mime },
        customMetadata: object.customMetadata,
      });
      await MediaRepo.updateMediaSize(db, row.key, stripped.length);
      changed += 1;
    } catch (error) {
      console.error(
        JSON.stringify({
          message: "media metadata backfill failed",
          key: row.key,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  await env.KV.put(MEDIA_METADATA_CURSOR_KEY, String(lastId));
  console.log(
    JSON.stringify({
      message: "media metadata backfill batch completed",
      processed,
      changed,
      cursor: lastId,
    }),
  );

  return { changed, processed };
}

/** 批量删除所有未被文章引用的媒体（后台维护手动触发） */
export async function cleanupUnusedMedia(
  context: DbContext & { executionCtx: ExecutionContext },
  options: { limit?: number } = {},
): Promise<{ deleted: number; scanned: number }> {
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
  let cursor: number | undefined;
  let deleted = 0;
  let scanned = 0;

  while (deleted < limit) {
    const page = await MediaRepo.getMediaList(context.db, {
      cursor,
      limit: Math.min(100, limit - deleted),
      unusedOnly: true,
    });
    if (page.items.length === 0) break;

    for (const item of page.items) {
      scanned += 1;
      const result = await deleteImage(context, item.key);
      if (!result.error) deleted += 1;
      if (deleted >= limit) break;
    }

    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }

  return { deleted, scanned };
}
