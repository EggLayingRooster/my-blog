import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { WorkflowEntrypoint } from "cloudflare:workers";
import * as CacheService from "@/features/cache/cache.service";
import * as PostRepo from "@/features/posts/data/posts.data";
import type {
  ImportReport,
  TaskProgress,
} from "@/features/import-export/import-export.schema";
import { IMPORT_EXPORT_CACHE_KEYS } from "@/features/import-export/import-export.schema";
import { parseZip } from "@/features/import-export/utils/zip";
import {
  enumerateMarkdownPosts,
  enumerateNativePosts,
  importSinglePost,
} from "@/features/import-export/workflows/import-helpers";
import * as SearchService from "@/features/search/service/search.service";
import { TAGS_CACHE_KEYS } from "@/features/tags/tags.schema";
import { getDb } from "@/lib/db";
import { serverEnv } from "@/lib/env/server.env";
import { purgeSiteCDNCache } from "@/lib/invalidate";
import { m } from "@/paraglide/messages";

const MAX_IMPORT_POSTS = 500;
const IMPORT_RETRY_ATTEMPTS = 3;

async function withRetries<T>(
  operation: () => Promise<T>,
  attempts = IMPORT_RETRY_ATTEMPTS,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
      }
    }
  }
  throw lastError;
}

export class ImportWorkflow extends WorkflowEntrypoint<
  Env,
  ImportWorkflowParams
> {
  async run(event: WorkflowEvent<ImportWorkflowParams>, step: WorkflowStep) {
    const { taskId, r2Key, mode, locale: requestedLocale } = event.payload;
    const progressKey = IMPORT_EXPORT_CACHE_KEYS.importProgress(taskId);
    const locale = requestedLocale ?? serverEnv(this.env).LOCALE;

    console.log(
      JSON.stringify({ message: "import workflow started", taskId, mode }),
    );

    try {
      // 1. Enumerate posts from ZIP
      // NOTE: step.do() serializes return values as JSON for durability.
      // Uint8Array does NOT survive JSON round-tripping, so we must NOT
      // return binary data from steps. Instead, each step re-fetches the
      // ZIP from R2 when it needs the binary content.
      // 整个 run 只读取/解压一次 ZIP，避免每篇文章重复 R2 下载和 parseZip
      const zipFilesForImport = await withRetries(() =>
        this.fetchZipFiles(r2Key, locale),
      );

      const postEntries = await step.do("enumerate posts", async () => {
        if (mode === "native") {
          return enumerateNativePosts(zipFilesForImport);
        }
        return enumerateMarkdownPosts(zipFilesForImport);
      });

      if (postEntries.length > MAX_IMPORT_POSTS) {
        throw new Error(
          `Import contains too many posts (max ${MAX_IMPORT_POSTS})`,
        );
      }

      console.log(
        JSON.stringify({
          message: "posts enumerated",
          taskId,
          count: postEntries.length,
        }),
      );

      if (postEntries.length === 0) {
        await this.updateProgress(progressKey, {
          status: "completed",
          total: 0,
          completed: 0,
          current: "",
          errors: [],
          warnings: [m.import_export_import_warning_empty({}, { locale })],
          report: { succeeded: [], failed: [], warnings: [] },
        });
        return;
      }

      // 2. Process each post
      // Each step returns a delta (serializable). Accumulation happens outside
      // steps so it re-executes correctly on workflow restart/replay.
      const report: ImportReport = {
        succeeded: [],
        failed: [],
        warnings: [],
      };

      for (let i = 0; i < postEntries.length; i++) {
        const entry = postEntries[i];

        const delta = await step.do(
          `import post ${i + 1}/${postEntries.length}: ${entry.title || entry.dir}`,
          async () => {
            const stepReport: ImportReport = {
              succeeded: [],
              failed: [],
              warnings: [],
            };

            try {
              const result = await withRetries(() =>
                importSinglePost(
                  this.env,
                  zipFilesForImport,
                  entry,
                  mode,
                  locale,
                ),
              );
              if (result.skipped) {
                stepReport.warnings.push(
                  m.import_export_import_warning_slug_skipped(
                    { title: result.title },
                    { locale },
                  ),
                );
              } else {
                stepReport.succeeded.push({
                  title: result.title,
                  slug: result.slug,
                });
              }
              for (const w of result.warnings) {
                stepReport.warnings.push(
                  m.import_export_import_warning_scoped(
                    { title: result.title, warning: w },
                    { locale },
                  ),
                );
              }
            } catch (error) {
              const reason =
                error instanceof Error ? error.message : String(error);
              stepReport.failed.push({
                title: entry.title || entry.dir,
                reason,
              });
            }

            return stepReport;
          },
        );

        // Accumulate outside step — on replay, cached return values flow here
        report.succeeded.push(...delta.succeeded);
        report.failed.push(...delta.failed);
        report.warnings.push(...delta.warnings);

        console.log(
          JSON.stringify({
            message: "post import step completed",
            taskId,
            step: i + 1,
            total: postEntries.length,
            title: entry.title || entry.dir,
            succeeded: delta.succeeded.length,
            failed: delta.failed.length,
          }),
        );

        // Progress update outside step — idempotent KV write, safe on replay
        await this.updateProgress(progressKey, {
          status: "processing",
          total: postEntries.length,
          completed: i + 1,
          current: entry.title || entry.dir,
          errors: report.failed.map((f) => ({
            post: f.title,
            reason: f.reason,
          })),
          warnings: report.warnings,
        });
      }

      // 3. Refresh public caches + search index（导入直接写库，不会经过发布 Workflow）
      if (report.succeeded.length > 0) {
        await step.do(
          "invalidate caches and rebuild search index",
          {
            retries: { limit: 3, delay: "10 seconds", backoff: "exponential" },
          },
          async () => {
            await Promise.all([
              CacheService.bumpVersion({ env: this.env }, "posts:list"),
              CacheService.bumpVersion({ env: this.env }, "posts:detail"),
              CacheService.deleteKey(
                { env: this.env },
                TAGS_CACHE_KEYS.publicList,
              ),
            ]);

            try {
              await purgeSiteCDNCache(this.env);
            } catch (error) {
              console.error(
                JSON.stringify({
                  message: "import CDN purge failed",
                  taskId,
                  error: error instanceof Error ? error.message : String(error),
                }),
              );
            }

            await SearchService.rebuildIndex({
              db: getDb(this.env),
              env: this.env,
            });
          },
        );
      }

      // 4. Cleanup and finalize

      // 4. 导入的未来文章不会经过发布 Workflow，必须补建定时发布任务
      if (report.succeeded.length > 0) {
        const scheduled = await step.do(
          "schedule imported future posts",
          async () => {
            const db = getDb(this.env);
            let scheduledCount = 0;
            const failures: Array<string> = [];

            for (const item of report.succeeded) {
              const post = await PostRepo.findPostBySlug(db, item.slug);
              if (
                !post ||
                post.status !== "published" ||
                !post.publishedAt ||
                post.publishedAt.getTime() <= Date.now()
              ) {
                continue;
              }

              const instanceId = `post-${post.id}-scheduled`;
              try {
                const old = await this.env.SCHEDULED_PUBLISH_WORKFLOW.get(
                  instanceId,
                );
                await old.terminate();
              } catch {
                // no previous instance
              }

              try {
                await this.env.SCHEDULED_PUBLISH_WORKFLOW.createBatch([
                  {
                    id: instanceId,
                    params: {
                      postId: post.id,
                      publishedAt: post.publishedAt.toISOString(),
                    },
                  },
                ]);
                scheduledCount += 1;
              } catch (error) {
                failures.push(
                  `Failed to schedule ${post.slug}: ${
                    error instanceof Error ? error.message : String(error)
                  }`,
                );
              }
            }

            return { failures, scheduledCount };
          },
        );

        report.warnings.push(...scheduled.failures);
        console.log(
          JSON.stringify({
            message: "imported future posts scheduled",
            taskId,
            scheduled: scheduled.scheduledCount,
            failed: scheduled.failures.length,
          }),
        );
      }

      await step.do("finalize", async () => {
        try {
          await this.env.R2.delete(r2Key);
        } catch {
          // Ignore cleanup errors
        }

        await this.updateProgress(progressKey, {
          status: "completed",
          total: postEntries.length,
          completed: postEntries.length,
          current: "",
          errors: report.failed.map((f) => ({
            post: f.title,
            reason: f.reason,
          })),
          warnings: report.warnings,
          report,
        });
      });

      console.log(
        JSON.stringify({
          message: "import workflow completed",
          taskId,
          succeeded: report.succeeded.length,
          failed: report.failed.length,
          warnings: report.warnings.length,
        }),
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          message: "import workflow failed",
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

      // 失败时也清理上传的导入包，避免长期占用 R2
      try {
        await this.env.R2.delete(r2Key);
      } catch (cleanupError) {
        console.error(
          JSON.stringify({
            message: "import workflow failed to cleanup zip",
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

  private async fetchZipFiles(
    r2Key: string,
    locale: "zh" | "en",
  ): Promise<Record<string, Uint8Array>> {
    const r2Object = await this.env.R2.get(r2Key);
    if (!r2Object) {
      throw new Error(m.import_export_import_error_zip_missing({}, { locale }));
    }
    const arrayBuffer = await r2Object.arrayBuffer();
    return parseZip(new Uint8Array(arrayBuffer));
  }

  private async updateProgress(key: string, progress: TaskProgress) {
    const context: BaseContext = { env: this.env };
    await CacheService.set(context, key, JSON.stringify(progress), {
      ttl: "24h",
    });
  }
}
