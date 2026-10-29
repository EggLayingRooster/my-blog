import { cleanupExpiredAuthRecords } from "@/features/auth/service/auth.service";
import { cleanupStaleVerifyingComments } from "@/features/comments/comments.service";
import { backfillMediaMetadata } from "@/features/media/service/media.service";
import { cleanupOldPageviews } from "@/features/pageview/service/pageview.service";
import { getDb } from "@/lib/db";
import { handleQueueBatch } from "@/lib/queue/queue.handler";

export { CommentModerationWorkflow } from "@/features/comments/workflows/comment-moderation";
export { ExportWorkflow } from "@/features/import-export/workflows/export.workflow";
export { ImportWorkflow } from "@/features/import-export/workflows/import.workflow";
export { PostAutoSnapshotWorkflow } from "@/features/posts/workflows/post-auto-snapshot";
export { PostProcessWorkflow } from "@/features/posts/workflows/post-process";
export { ScheduledPublishWorkflow } from "@/features/posts/workflows/scheduled-publish";
export { PasswordHasher } from "@/lib/do/password-hasher";
export { RateLimiter } from "@/lib/do/rate-limiter";

declare module "@tanstack/react-start" {
  interface Register {
    server: {
      requestContext: {
        env: Env;
        executionCtx: ExecutionContext<unknown>;
      };
    };
  }
}

export default {
  async fetch(request, env, ctx) {
    const { handleRootRequest } = await import("@/lib/worker/root-handler");
    return handleRootRequest(request, env, ctx);
  },
  async queue(batch, env, ctx) {
    await handleQueueBatch(batch, env, ctx);
  },
  async scheduled(_controller, env, ctx) {
    const jobs = [
      ["pageview cleanup", () => cleanupOldPageviews(env)],
      ["auth cleanup", () => cleanupExpiredAuthRecords(env)],
      [
        "stale comment reconciliation",
        () => cleanupStaleVerifyingComments({ db: getDb(env), env }),
      ],
      [
        "media metadata backfill",
        () => backfillMediaMetadata(env, { limit: 50 }),
      ],
    ] as const;

    ctx.waitUntil(
      Promise.allSettled(jobs.map(([, run]) => run())).then((results) => {
        results.forEach((result, index) => {
          if (result.status === "rejected") {
            console.error(
              JSON.stringify({
                message: "scheduled task failed",
                task: jobs[index][0],
                error:
                  result.reason instanceof Error
                    ? result.reason.message
                    : String(result.reason),
              }),
            );
          }
        });
      }),
    );
  },
} satisfies ExportedHandler<Env>;
