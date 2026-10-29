import type { RawData } from "@orama/orama";
import { load, save } from "@orama/orama";
import type { MyOramaDB } from "@/features/search/model/schema";
import { createMyDb } from "@/features/search/model/schema";

/**
 * 搜索索引存储从 KV 迁移到 R2：
 * - KV 单值 25MB + 最终一致性，不适合作为可并发写入的索引
 * - R2 支持 ETag 条件写（onlyIf），用乐观并发控制避免多个 Workflow/请求互相覆盖
 */
const R2_KEY = "search/index.v3.json.gz";
const LEGACY_KV_KEY = "search:index:v3";
const KV_META_KEY = "search:index:meta:v3";
const MAX_WRITE_ATTEMPTS = 5;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

async function compressRaw(raw: RawData): Promise<Uint8Array> {
  const json = JSON.stringify(raw);
  const encoded = textEncoder.encode(json);

  if (typeof CompressionStream === "undefined") {
    return encoded;
  }

  const stream = new CompressionStream("gzip");
  const writer = stream.writable.getWriter();
  await writer.write(encoded);
  await writer.close();
  const compressed = await new Response(stream.readable).arrayBuffer();
  return new Uint8Array(compressed);
}

async function decompressToRaw(buffer: ArrayBuffer): Promise<RawData> {
  const tryGzip = async () => {
    if (typeof DecompressionStream === "undefined") {
      throw new TypeError("DecompressionStream unavailable");
    }

    const stream = new DecompressionStream("gzip");
    const writer = stream.writable.getWriter();
    await writer.write(new Uint8Array(buffer));
    await writer.close();
    const decompressed = await new Response(stream.readable).arrayBuffer();
    const json = textDecoder.decode(decompressed);
    return JSON.parse(json) as RawData;
  };

  try {
    return await tryGzip();
  } catch {
    const json = textDecoder.decode(new Uint8Array(buffer));
    return JSON.parse(json) as RawData;
  }
}

let cachedDb: MyOramaDB | null = null;
let cachedVersion: string | null = null;
let inflight: Promise<MyOramaDB> | null = null;

type LoadedIndex = {
  db: MyOramaDB;
  etag: string | null;
};

async function loadLegacyFromKv(env: Env): Promise<MyOramaDB | null> {
  const buffer = await env.KV.get(LEGACY_KV_KEY, "arrayBuffer");
  if (!buffer) return null;

  try {
    const raw = await decompressToRaw(buffer);
    const db = await createMyDb();
    await load(db, raw);
    return db;
  } catch (error) {
    console.error(
      JSON.stringify({
        message: "legacy orama index load failed",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return null;
  }
}

async function loadFromR2(env: Env): Promise<LoadedIndex | null> {
  const object = await env.R2.get(R2_KEY);
  if (!object) {
    // 首次从旧 KV 存储迁移索引，避免部署后搜索变空
    const legacy = await loadLegacyFromKv(env);
    if (!legacy) return null;

    try {
      const compressed = await compressRaw(save(legacy));
      const head = await env.R2.head(R2_KEY);
      await putIndex(env, compressed, head?.etag ?? null);
    } catch (error) {
      console.error(
        JSON.stringify({
          message: "legacy search index migration failed",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }

    return { db: legacy, etag: null };
  }

  try {
    const raw = await decompressToRaw(await object.arrayBuffer());
    const db = await createMyDb();
    await load(db, raw);
    return { db, etag: object.etag ?? null };
  } catch (error) {
    console.error(
      JSON.stringify({
        message: "orama index load failed",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return null;
  }
}

async function writeMeta(env: Env, sizeInBytes: number): Promise<string> {
  // 时间戳 + 随机后缀：避免同一毫秒内多次写入产生相同版本号
  const version = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  await env.KV.put(
    KV_META_KEY,
    JSON.stringify({
      version,
      updatedAt: new Date().toISOString(),
      sizeInBytes,
    }),
  );
  return version;
}

async function putIndex(
  env: Env,
  compressed: Uint8Array,
  etag: string | null,
): Promise<boolean> {
  const object = await env.R2.put(R2_KEY, compressed, {
    httpMetadata: { contentType: "application/octet-stream" },
    onlyIf: etag ? { etagMatches: etag } : { etagDoesNotMatch: "*" },
  });
  return object !== null;
}

export async function getOramaDb(env: Env): Promise<MyOramaDB> {
  const meta = await getOramaMeta(env);
  const latestVersion = meta?.version || "init";

  if (cachedDb && cachedVersion === latestVersion) return cachedDb;
  if (inflight) return inflight;

  inflight = (async () => {
    const fromR2 = await loadFromR2(env);
    if (fromR2) return fromR2.db;
    return await createMyDb();
  })().finally(() => {
    inflight = null;
  });

  cachedDb = await inflight;
  cachedVersion = latestVersion;
  return cachedDb;
}

/**
 * 以乐观并发方式修改索引：加载最新索引 -> 应用变更 -> ETag 条件写。
 * 写入冲突时重新加载并重试，避免并发 upsert/delete 互相覆盖。
 * `mutate` 必须可重复执行（幂等）。
 */
export async function mutateOramaIndex<T>(
  env: Env,
  mutate: (db: MyOramaDB) => T | Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
    const loaded = await loadFromR2(env);
    const db = loaded?.db ?? (await createMyDb());
    const result = await mutate(db);

    const compressed = await compressRaw(save(db));
    const written = await putIndex(env, compressed, loaded?.etag ?? null);
    if (!written) continue;

    const version = await writeMeta(env, compressed.byteLength);
    setOramaDb(db, version);
    return result;
  }

  throw new Error("Search index write conflict: retries exhausted");
}

/** 用新索引整体替换旧索引（重建） */
export async function replaceOramaIndex(
  env: Env,
  build: () => MyOramaDB | Promise<MyOramaDB>,
): Promise<string> {
  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
    const head = await env.R2.head(R2_KEY);
    const db = await build();
    const compressed = await compressRaw(save(db));
    const written = await putIndex(env, compressed, head?.etag ?? null);
    if (!written) continue;

    const version = await writeMeta(env, compressed.byteLength);
    setOramaDb(db, version);
    return version;
  }

  throw new Error("Search index replace conflict: retries exhausted");
}

/**
 * 兼容旧调用的直接持久化；并发场景请使用 mutateOramaIndex。
 */
export async function persistOramaDb(env: Env, db: MyOramaDB) {
  const head = await env.R2.head(R2_KEY);
  const compressed = await compressRaw(save(db));
  const written = await putIndex(env, compressed, head?.etag ?? null);
  if (!written) {
    throw new Error("Search index write conflict");
  }
  const version = await writeMeta(env, compressed.byteLength);
  setOramaDb(db, version);
  return version;
}

export async function getOramaMeta(
  env: Env,
): Promise<{ version: string } | null> {
  return await env.KV.get(KV_META_KEY, "json");
}

export function setOramaDb(db: MyOramaDB, version: string) {
  cachedDb = db;
  cachedVersion = version;
}
