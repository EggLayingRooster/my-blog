import type { JSONContent } from "@tiptap/react";
import type { PostEntry } from "@/features/import-export/import-export.schema";
import {
  normalizeFrontmatter,
  parseFrontmatter,
} from "@/features/import-export/utils/frontmatter";
import {
  extractMarkdownImages,
  rewriteImagePaths,
  rewriteMarkdownImagePaths,
} from "@/features/import-export/utils/image-rewriter";
import { markdownToJsonContent } from "@/features/import-export/utils/markdown-parser";
import {
  listDirectories,
  listFiles,
  readJsonFile,
  readTextFile,
} from "@/features/import-export/utils/zip";
import * as MediaRepo from "@/features/media/data/media.data";
import {
  detectImageMime,
  generateKey,
  getExtensionForMime,
} from "@/features/media/utils/media.utils";
import { syncPostMedia } from "@/features/posts/data/post-media.data";
import * as PostRepo from "@/features/posts/data/posts.data";
import { NullableJsonContentSchema } from "@/features/posts/schema/json-content.schema";
import * as PostService from "@/features/posts/services/posts.service";
import { highlightCodeBlocks, slugify } from "@/features/posts/utils/content";
import * as TagRepo from "@/features/tags/data/tags.data";
import { getDb } from "@/lib/db";
import { PostTagsTable } from "@/lib/db/schema";
import type { Locale } from "@/lib/i18n";
import { m } from "@/paraglide/messages";

// --- Enumerate posts (pure — no env dependency) ---

export function enumerateNativePosts(
  zipFiles: Record<string, Uint8Array>,
): Array<PostEntry> {
  const dirs = listDirectories(zipFiles, "posts/");
  return dirs
    .map((dir) => {
      const mdContent = readTextFile(zipFiles, `posts/${dir}/index.md`);
      const parsed = mdContent ? parseFrontmatter(mdContent) : null;
      const normalized = parsed ? normalizeFrontmatter(parsed.data) : null;

      if (!normalized) return null;

      const entry: PostEntry = {
        dir,
        title: normalized.title || dir,
        prefix: `posts/${dir}`,
      };
      return entry;
    })
    .filter((e): e is PostEntry => e !== null);
}

export function enumerateMarkdownPosts(
  zipFiles: Record<string, Uint8Array>,
): Array<PostEntry> {
  const mdFiles = Object.keys(zipFiles).filter(
    (p) => p.endsWith(".md") && !p.startsWith("__MACOSX"),
  );
  return mdFiles
    .map((path) => {
      const dir = path.replace(/\.md$/, "").split("/").pop() || path;
      const mdContent = readTextFile(zipFiles, path);
      const parsed = mdContent ? parseFrontmatter(mdContent) : null;
      const normalized = parsed ? normalizeFrontmatter(parsed.data) : null;

      if (!normalized) return null;

      const entry: PostEntry = {
        dir,
        title: normalized.title || dir,
        prefix: path.substring(0, path.lastIndexOf("/")),
        mdPath: path,
      };
      return entry;
    })
    .filter((e): e is PostEntry => e !== null);
}

// --- Import single post (needs env for DB / R2) ---

export async function importSinglePost(
  env: Env,
  zipFiles: Record<string, Uint8Array>,
  entry: PostEntry,
  mode: "native" | "markdown",
  locale: Locale = "zh",
): Promise<{
  title: string;
  slug: string;
  skipped?: boolean;
  warnings: Array<string>;
}> {
  const db = getDb(env);
  const context: DbContext = { db, env };
  const warnings: Array<string> = [];

  // 1. Parse content
  let contentJson: JSONContent | null = null;
  let metadata: Record<string, unknown> = {};
  const uploadedMediaKeys: Array<string> = [];

  if (mode === "native") {
    const rawJson = readJsonFile<JSONContent>(
      zipFiles,
      `${entry.prefix}/content.json`,
    );
    if (rawJson) {
      const parsed = NullableJsonContentSchema.safeParse(rawJson);
      if (parsed.success) {
        contentJson = parsed.data;
      } else {
        warnings.push(
          m.import_export_import_warning_content_json_invalid({}, { locale }),
        );
      }
    }

    const mdContent = readTextFile(zipFiles, `${entry.prefix}/index.md`);
    if (mdContent) {
      const { data, content } = parseFrontmatter(mdContent);
      metadata = data;

      if (!contentJson && content.trim()) {
        try {
          contentJson = await markdownToJsonContent(content);
        } catch (error) {
          warnings.push(
            m.import_export_import_warning_markdown_convert_failed(
              {
                error: error instanceof Error ? error.message : String(error),
              },
              { locale },
            ),
          );
        }
      }
    }
  } else {
    const mdPath = entry.mdPath || `${entry.prefix}/${entry.dir}.md`;
    const mdContent = readTextFile(zipFiles, mdPath);
    if (mdContent) {
      const { data, content } = parseFrontmatter(mdContent);
      metadata = data;

      if (content.trim()) {
        // Upload relative images and rewrite markdown paths before conversion
        const mdDir = mdPath.substring(0, mdPath.lastIndexOf("/"));
        const imageResult = await uploadMarkdownImages(
          env,
          zipFiles,
          content,
          mdDir,
          locale,
        );
        warnings.push(...imageResult.warnings);
        uploadedMediaKeys.push(...imageResult.uploadedKeys);

        try {
          contentJson = await markdownToJsonContent(
            imageResult.rewrittenMarkdown,
          );
        } catch (error) {
          warnings.push(
            m.import_export_import_warning_markdown_convert_failed(
              {
                error: error instanceof Error ? error.message : String(error),
              },
              { locale },
            ),
          );
        }
      }
    }
  }

  const normalized = normalizeFrontmatter(metadata);
  if (!normalized) {
    throw new Error(
      m.import_export_import_error_invalid_metadata({}, { locale }),
    );
  }
  const title = normalized.title || entry.dir || "Untitled";

  const candidateSlug = normalized.slug || title;
  const slugAlreadyExists = await PostRepo.slugExists(
    db,
    slugify(candidateSlug),
  );
  if (slugAlreadyExists) {
    return { title, slug: candidateSlug, skipped: true, warnings };
  }

  // 3. Upload images and rewrite paths (native mode only — markdown mode handles images pre-conversion)
  if (contentJson && mode === "native") {
    const imageResult = await uploadImages(env, zipFiles, entry, locale);
    warnings.push(...imageResult.warnings);
    uploadedMediaKeys.push(...imageResult.rewriteMap.values());
    if (imageResult.rewriteMap.size > 0) {
      contentJson = rewriteImagePaths(contentJson, imageResult.rewriteMap);
    }
  }

  // 4. Highlight code blocks
  if (contentJson) {
    try {
      contentJson = await highlightCodeBlocks(contentJson);
    } catch {
      // Non-critical, continue without highlighting
    }
  }

  // 5. Generate unique slug
  const { slug } = await PostService.generateSlug(context, {
    title: normalized.slug || title,
  });

  // 6. Resolve tags
  const tagIds: Array<number> = [];
  const uniqueTags = [...new Set(normalized.tags)];
  if (uniqueTags.length > 0) {
    for (const tagName of uniqueTags) {
      let tag = await TagRepo.findTagByName(db, tagName);
      if (!tag) {
        tag = await TagRepo.insertTag(db, { name: tagName });
      }
      tagIds.push(tag.id);
    }
  }

  // 7. Insert post + 8. tags + 9. media relationships：失败时回滚，避免留下"半成品文章"或孤儿媒体
  let createdPost: Awaited<ReturnType<typeof PostRepo.insertPost>> | null = null;
  try {
    createdPost = await PostRepo.insertPost(db, {
      title,
      slug,
      summary: normalized.summary ?? null,
      contentJson,
      status: normalized.status === "draft" ? "draft" : "published",
      readTimeInMinutes: normalized.readTimeInMinutes,
      publishedAt: normalized.publishedAt
        ? new Date(normalized.publishedAt)
        : normalized.status !== "draft"
          ? new Date()
          : null,
    });

    // 8. Link tags
    if (tagIds.length > 0) {
      await db
        .insert(PostTagsTable)
        .values(tagIds.map((tagId) => ({ postId: createdPost!.id, tagId })));
    }

    // 9. Sync post-media relationships
    if (contentJson) {
      await syncPostMedia(db, createdPost.id, contentJson);
    }

    return { title: createdPost.title, slug: createdPost.slug, warnings };
  } catch (error) {
    console.error(
      JSON.stringify({
        message: "import post failed, rolling back partial writes",
        title,
        slug,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    if (createdPost) {
      await PostRepo.deletePost(db, createdPost.id).catch(() => undefined);
    }
    await cleanupImportedMedia(env, db, uploadedMediaKeys);
    throw error;
  }
}

/** 导入失败时清理已上传的媒体（R2 + DB 记录），避免孤儿资源 */
async function cleanupImportedMedia(
  env: Env,
  db: DB,
  keys: Array<string>,
): Promise<void> {
  for (const key of keys) {
    try {
      await MediaRepo.deleteMedia(db, key);
    } catch (error) {
      console.error(
        JSON.stringify({
          message: "import rollback media record delete failed",
          key,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
    try {
      await env.R2.delete(key);
    } catch (error) {
      console.error(
        JSON.stringify({
          message: "import rollback r2 delete failed",
          key,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
}

// --- Image upload (needs env for R2) ---

export async function uploadImages(
  env: Env,
  zipFiles: Record<string, Uint8Array>,
  entry: PostEntry,
  locale: Locale,
): Promise<{ rewriteMap: Map<string, string>; warnings: Array<string> }> {
  const rewriteMap = new Map<string, string>();
  const warnings: Array<string> = [];
  const imagePrefix = `${entry.prefix}/images/`;
  const imageFiles = listFiles(zipFiles, imagePrefix);

  for (const imagePath of imageFiles) {
    if (!(imagePath in zipFiles)) continue;
    const imageData = zipFiles[imagePath];
    if (imageData.length === 0) continue;

    const oldKey = imagePath.slice(imagePrefix.length);
    // 按文件头识别真实图片类型，避免导入伪装文件（与媒体上传保持一致）
    const detectedMime = detectImageMime(imageData);
    if (!detectedMime) {
      warnings.push(
        m.import_export_import_warning_image_upload_failed(
          { name: oldKey },
          { locale },
        ),
      );
      continue;
    }
    const newKey = generateKey(oldKey, getExtensionForMime(detectedMime));

    const mimeType = detectedMime;

    try {
      await env.R2.put(newKey, imageData, {
        httpMetadata: { contentType: mimeType },
        customMetadata: { originalName: oldKey },
      });

      await MediaRepo.insertMedia(getDb(env), {
        key: newKey,
        url: `/images/${newKey}`,
        fileName: oldKey,
        mimeType,
        sizeInBytes: imageData.length,
      });

      rewriteMap.set(oldKey, newKey);
    } catch (error) {
      console.error(
        JSON.stringify({
          message: "image upload failed during import",
          imagePath,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      warnings.push(
        m.import_export_import_warning_image_upload_failed(
          { name: oldKey },
          { locale },
        ),
      );
    }
  }

  return { rewriteMap, warnings };
}

// --- Markdown image upload (resolves relative paths from .md location) ---

/**
 * 解析相对路径：以 markdown 文件所在目录为基准
 * resolveRelativePath("posts", "./images/a.jpg") → "posts/images/a.jpg"
 * resolveRelativePath("", "images/a.jpg") → "images/a.jpg"
 * resolveRelativePath("posts/sub", "../assets/a.jpg") → "posts/assets/a.jpg"
 */
export function resolveRelativePath(base: string, relative: string): string {
  const cleaned = relative.replace(/^\.\//, "");
  if (!base) return cleaned;

  const parts = base.split("/");
  for (const segment of cleaned.split("/")) {
    if (segment === "..") {
      parts.pop();
    } else if (segment !== ".") {
      parts.push(segment);
    }
  }
  return parts.join("/");
}

/**
 * 扫描 Markdown 中的相对图片引用，上传到 R2，重写路径
 */
async function uploadMarkdownImages(
  env: Env,
  zipFiles: Record<string, Uint8Array>,
  markdown: string,
  mdDir: string,
  locale: Locale,
): Promise<{
  rewrittenMarkdown: string;
  warnings: Array<string>;
  uploadedKeys: Array<string>;
}> {
  const warnings: Array<string> = [];
  const uploadedKeys: Array<string> = [];

  const images = extractMarkdownImages(markdown);
  const relativeImages = images.filter((img) => img.type === "relative");

  if (relativeImages.length === 0) {
    return { rewrittenMarkdown: markdown, warnings, uploadedKeys };
  }

  const rewriteMap = new Map<string, string>();

  for (const img of relativeImages) {
    const resolvedPath = resolveRelativePath(mdDir, img.original);

    if (!(resolvedPath in zipFiles)) {
      warnings.push(
        m.import_export_import_warning_image_missing(
          { name: img.original },
          { locale },
        ),
      );
      continue;
    }

    const imageData = zipFiles[resolvedPath];
    if (imageData.length === 0) continue;

    const fileName = resolvedPath.split("/").pop() || resolvedPath;
    const detectedMime = detectImageMime(imageData);
    if (!detectedMime) {
      warnings.push(
        m.import_export_import_warning_image_upload_failed(
          { name: img.original },
          { locale },
        ),
      );
      continue;
    }
    const newKey = generateKey(fileName, getExtensionForMime(detectedMime));
    const mimeType = detectedMime;

    try {
      await env.R2.put(newKey, imageData, {
        httpMetadata: { contentType: mimeType },
        customMetadata: { originalName: fileName },
      });

      await MediaRepo.insertMedia(getDb(env), {
        key: newKey,
        url: `/images/${newKey}`,
        fileName,
        mimeType,
        sizeInBytes: imageData.length,
      });

      rewriteMap.set(img.original, `/images/${newKey}?quality=80`);
      uploadedKeys.push(newKey);
    } catch (error) {
      console.error(
        JSON.stringify({
          message: "markdown image upload failed during import",
          resolvedPath,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      warnings.push(
        m.import_export_import_warning_image_upload_failed(
          { name: img.original },
          { locale },
        ),
      );
    }
  }

  const rewrittenMarkdown =
    rewriteMap.size > 0
      ? rewriteMarkdownImagePaths(markdown, rewriteMap)
      : markdown;

  return { rewrittenMarkdown, warnings, uploadedKeys };
}
