import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { WorkflowEntrypoint } from "cloudflare:workers";
import * as CacheService from "@/features/cache/cache.service";
import type {
  ExportManifest,
  PostFrontmatter,
  TaskProgress,
} from "@/features/import-export/import-export.schema";
import {
  EXPORT_MANIFEST_VERSION,
  IMPORT_EXPORT_CACHE_KEYS,
  IMPORT_EXPORT_R2_KEYS,
} from "@/features/import-export/import-export.schema";
import { stringifyFrontmatter } from "@/features/import-export/utils/frontmatter";
import {
  jsonContentToMarkdown,
  makeExportImageRewriter,
} from "@/features/import-export/utils/markdown-serializer";
import { buildZip } from "@/features/import-export/utils/zip";
import { getFromR2 } from "@/features/media/data/media.storage";
import * as PostRepo from "@/features/posts/data/posts.data";
import { extractAllImageKeys } from "@/features/posts/utils/content";
import { getDb } from "@/lib/db";
import { serverEnv } from "@/lib/env/server.env";
import { m } from "@/paraglide/messages";

const MAX_EXPORT_POSTS = 500;
const MAX_EXPORT_BYTES = 60 * 1024 * 1024;

export class ExportWorkflow extends WorkflowEntrypoint<
  Env,
  ExportWorkflowParams
> {
  async run(event: WorkflowEvent<ExportWorkflowParams>, step: WorkflowStep) {
    const { taskId, postIds, status, locale: requestedLocale } = event.payload;
    const progressKey = IMPORT_EXPORT_CACHE_KEYS.exportProgress(taskId);
    const locale = requestedLocale ?? serverEnv(this.env).LOCALE;

    console.log(JSON.stringify({ message: "export workflow started", taskId }));

    try {
      // 1. Fetch posts
      const posts = await step.do("fetch posts", async () => {
        const db = getDb(this.env);

        return await PostRepo.findFullPosts(db, {
          ids: postIds && postIds.length > 0 ? postIds : undefined,
          status: status ?? undefined,
        });
      });

      console.log(
        JSON.stringify({
          message: "posts fetched",
          taskId,
          count: posts.length,
        }),
      );

      if (posts.length === 0) {
        await this.updateProgress(progressKey, {
          status: "completed",
          total: 0,
          completed: 0,
          current: "",
          errors: [],
          warnings: [m.import_export_export_warning_empty({}, { locale })],
        });
        return;
      }

      if (posts.length > MAX_EXPORT_POSTS) {
        await this.updateProgress(progressKey, {
          status: "failed",
          total: posts.length,
          completed: 0,
          current: "",
          errors: [
            {
              post: "export",
              reason: `Export contains too many posts (max ${MAX_EXPORT_POSTS})`,
            },
          ],
          warnings: [],
        });
        return;
      }

      // 2. Process all posts, build ZIP, upload
      // Consolidated into one step because zipFiles accumulates Uint8Array data
      // which cannot survive JSON serialization through step.do() boundaries.
      // A single atomic step guarantees all data is available for ZIP building,
      // and retries the entire process on transient failures.
      await step.do("build and upload export", async () => {
        const zipFiles: Record<string, Uint8Array | string> = {};
        const warnings: Array<string> = [];
        let totalBytes = 0;

        for (let i = 0; i < posts.length; i++) {
          const post = posts[i];
          const slug = post.slug;
          const prefix = `posts/${slug}`;

          // Generate frontmatter
          const frontmatter: PostFrontmatter = {
            title: post.title,
            slug: post.slug,
            summary: post.summary ?? undefined,
            status: post.status,
            publishedAt: post.publishedAt?.toISOString(),
            createdAt: post.createdAt.toISOString(),
            updatedAt: post.updatedAt.toISOString(),
            readTimeInMinutes: post.readTimeInMinutes,
            tags: post.tags.map((t) => t.name),
          };

          // Convert content to Markdown
          const rewriter = makeExportImageRewriter();
          const markdown = post.contentJson
            ? jsonContentToMarkdown(post.contentJson, {
                rewriteImageSrc: rewriter,
              })
            : "";

          // Write index.md with frontmatter
          zipFiles[`${prefix}/index.md`] = stringifyFrontmatter(
            frontmatter,
            markdown,
          );

          // Write content.json (lossless backup)
          if (post.contentJson) {
            const contentJson = JSON.stringify(post.contentJson, null, 2);
            zipFiles[`${prefix}/content.json`] = contentJson;
            totalBytes += contentJson.length;
          }

          totalBytes += markdown.length;
          if (totalBytes > MAX_EXPORT_BYTES) {
            throw new Error(
              `Export exceeds size limit (${MAX_EXPORT_BYTES} bytes)`,
            );
          }

          // Download images from R2
          if (post.contentJson) {
            const imageKeys = extractAllImageKeys(post.contentJson);
            for (const key of imageKeys) {
              try {
                const r2Object = await getFromR2(this.env, key);
                if (r2Object) {
                  const arrayBuffer = await r2Object.arrayBuffer();
                  const imageData = new Uint8Array(arrayBuffer);
                  zipFiles[`${prefix}/images/${key}`] = imageData;
                  totalBytes += imageData.byteLength;
                  if (totalBytes > MAX_EXPORT_BYTES) {
                    throw new Error(
                      `Export exceeds size limit (${MAX_EXPORT_BYTES} bytes)`,
                    );
                  }
                } else {
                  warnings.push(
                    m.import_export_export_warning_image_missing(
                      { key, title: post.title },
                      { locale },
                    ),
                  );
                }
              } catch (error) {
                warnings.push(
                  m.import_export_export_warning_image_download_failed(
                    {
                      key,
                      title: post.title,
                      error:
                        error instanceof Error ? error.message : String(error),
                    },
                    { locale },
                  ),
                );
              }
            }
          }

          // Update progress
          await this.updateProgress(progressKey, {
            status: "processing",
            total: posts.length,
            completed: i + 1,
            current: post.title,
            errors: [],
            warnings,
          });

          console.log(
            JSON.stringify({
              message: "post exported",
              taskId,
              step: i + 1,
              total: posts.length,
              slug: post.slug,
            }),
          );
        }

        // Add tags.json
        const uniqueTagsMap = new Map<string, (typeof posts)[0]["tags"][0]>();
        for (const post of posts) {
          for (const tag of post.tags) {
            uniqueTagsMap.set(tag.name, tag);
          }
        }

        zipFiles["tags.json"] = JSON.stringify(
          Array.from(uniqueTagsMap.values()).map((t) => ({
            name: t.name,
            createdAt: t.createdAt.toISOString(),
          })),
          null,
          2,
        );

        // Add manifest.json
        const manifest: ExportManifest = {
          version: EXPORT_MANIFEST_VERSION,
          exportedAt: new Date().toISOString(),
          postCount: posts.length,
          generator: "blog-cms",
        };
        zipFiles["manifest.json"] = JSON.stringify(manifest, null, 2);

        // Build ZIP
        const zipData = buildZip(zipFiles);

        // Upload ZIP to R2
        const r2Key = IMPORT_EXPORT_R2_KEYS.exportZip(taskId);
        try {
          await this.env.R2.put(r2Key, zipData, {
            httpMetadata: { contentType: "application/zip" },
            customMetadata: { taskId },
          });
        } catch (error) {
          await this.updateProgress(progressKey, {
            status: "failed",
            total: posts.length,
            completed: 0,
            current: "",
            errors: [
              {
                post: m.import_export_export_error_zip_upload_label(
                  {},
                  { locale },
                ),
                reason: error instanceof Error ? error.message : String(error),
              },
            ],
            warnings,
          });
          throw error;
        }

        // Mark completed
        await this.updateProgress(progressKey, {
          status: "completed",
          total: posts.length,
          completed: posts.length,
          current: "",
          errors: [],
          warnings,
          downloadKey: r2Key,
        });
      });

      console.log(
        JSON.stringify({
          message: "export workflow completed",
          taskId,
          postCount: posts.length,
        }),
      );

      // 3. Cleanup R2 after 24h
      const cleanupTime = new Date(Date.now() + 24 * 60 * 60 * 1000);
      await step.sleepUntil("cleanup delay", cleanupTime);

      await step.do("cleanup export zip", async () => {
        const r2Key = IMPORT_EXPORT_R2_KEYS.exportZip(taskId);
        try {
          await this.env.R2.delete(r2Key);
        } catch {
          // Ignore cleanup errors
        }
      });
    } catch (error) {
      console.error(
        JSON.stringify({
          message: "export workflow failed",
          taskId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      await this.updateProgress(progressKey, {
        status: "failed",
        total: 0,
        completed: 0,
        current: "",
        errors: [],
        warnings: [
          error instanceof Error
            ? error.message
            : m.import_export_common_unknown_error({}, { locale }),
        ],
      });

      // 失败时清理可能已上传的导出包
      try {
        await this.env.R2.delete(IMPORT_EXPORT_R2_KEYS.exportZip(taskId));
      } catch (cleanupError) {
        console.error(
          JSON.stringify({
            message: "export workflow failed to cleanup zip",
            taskId,
            error:
              cleanupError instanceof Error
                ? cleanupError.message
                : String(cleanupError),
          }),
        );
      }
    }
  }

  private async updateProgress(key: string, progress: TaskProgress) {
    const context: BaseContext = { env: this.env };
    await CacheService.set(context, key, JSON.stringify(progress), {
      ttl: "24h",
    });
  }
}
