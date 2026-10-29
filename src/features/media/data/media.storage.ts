import { generateKey } from "@/features/media/utils/media.utils";

export async function putToR2(
  env: Env,
  image: File,
  options?: { contentType?: string; extension?: string; bytes?: Uint8Array },
) {
  // 服务端已按文件头识别真实类型，不再信任客户端 file.type / 扩展名
  const contentType = options?.contentType ?? image.type;
  const key = generateKey(image.name, options?.extension);
  const url = `/images/${key}`;

  await env.R2.put(key, options?.bytes ?? image.stream(), {
    httpMetadata: {
      contentType,
    },
    customMetadata: {
      originalName: image.name,
    },
  });

  return {
    key,
    url,
    fileName: image.name,
    mimeType: contentType,
    sizeInBytes: options?.bytes?.byteLength ?? image.size,
  };
}

export async function deleteFromR2(env: Env, key: string) {
  await env.R2.delete(key);
}

export async function getFromR2(env: Env, key: string) {
  return await env.R2.get(key);
}

/**
 * Upload a site asset (favicon, theme images) to R2 with a fixed key.
 * No DB record; overwrites in place on re-upload.
 */
export async function putSiteAsset(
  env: Env,
  file: File,
  assetPath: string,
  options?: { contentType?: string; bytes?: Uint8Array },
): Promise<{ key: string; url: string }> {
  const key = `asset/${assetPath}`;
  await env.R2.put(key, options?.bytes ?? file.stream(), {
    httpMetadata: {
      contentType: options?.contentType ?? file.type,
    },
  });
  return { key, url: `/images/${key}` };
}
