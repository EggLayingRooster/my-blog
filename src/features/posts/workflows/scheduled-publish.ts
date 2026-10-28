import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { WorkflowEntrypoint } from "cloudflare:workers";
import {
  fetchPost,
  invalidatePostCaches,
  upsertPostSearchIndex,
} from "@/features/posts/workflows/helpers";

interface Params {
  postId: number;
  publishedAt: string; // ISO 8601
}

export class ScheduledPublishWorkflow extends WorkflowEntrypoint<Env, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
    const { postId } = event.payload;

    await step.sleepUntil(
      "sleep until publish date",
      // publishedAt 存的是发布者本地当天 00:00 的精确时间戳，到点即发布
      new Date(event.payload.publishedAt),
    );

    const post = await step.do("verify post status", async () => {
      return await fetchPost(this.env, postId);
    });

    if (!post || post.status !== "published") return;

    // purge CDN 可能瞬时失败，重试几次，避免到点后前台仍命中旧缓存
    await step.do(
      "invalidate caches",
      {
        retries: { limit: 3, delay: "10 seconds", backoff: "exponential" },
      },
      async () => {
        await invalidatePostCaches(this.env, post.slug);
      },
    );

    await step.do("update search index", async () => {
      await upsertPostSearchIndex(this.env, post);
    });
  }
}
