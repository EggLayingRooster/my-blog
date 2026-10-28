import { z } from "zod";
import * as AiService from "@/features/ai/ai.service";
import * as CacheService from "@/features/cache/cache.service";
import { syncPostMedia } from "@/features/posts/data/post-media.data";
import * as PostRevisionRepo from "@/features/posts/data/post-revisions.data";
import * as PostRepo from "@/features/posts/data/posts.data";
import type {
  DeletePostInput,
  FindPostByIdInput,
  FindPostBySlugInput,
  FindRelatedPostsInput,
  GenerateSlugInput,
  GetPostsCountInput,
  GetPostsCursorInput,
  GetPostsInput,
  PreviewSummaryInput,
  StartPostProcessInput,
  UpdatePostInput,
} from "@/features/posts/schema/posts.schema";
import {
  normalizePostTagName,
  POSTS_CACHE_KEYS,
  PostItemSchema,
  PostListResponseSchema,
  PostWithTocSchema,
} from "@/features/posts/schema/posts.schema";
import { logPostAutoSnapshot } from "@/features/posts/services/post-auto-snapshot.logging";
import * as PostAutoSnapshotService from "@/features/posts/services/post-auto-snapshot.service";
import {
  convertToPlainText,
  highlightCodeBlocks,
  slugify,
} from "@/features/posts/utils/content";
import { calculatePostHash } from "@/features/posts/utils/sync";
import { generateTableOfContents } from "@/features/posts/utils/toc";
import * as SearchService from "@/features/search/service/search.service";
import { TAGS_CACHE_KEYS } from "@/features/tags/tags.schema";
import { CACHE_TTL, POSTS_PAGE_SIZE } from "@/lib/constants";
import { err, ok } from "@/lib/errors";
import { purgePostCDNCache } from "@/lib/invalidate";

function stripPublicContentJson<T extends { publicContentJson?: unknown }>(
  post: T,
): Omit<T, "publicContentJson"> {
  const { publicContentJson: _publicContentJson, ...rest } = post;
  return rest;
}

export async function getPinnedPosts(
  context: DbContext & { executionCtx: ExecutionContext },
) {
  return CacheService.getVersioned(
    context,
    "posts:list",
    POSTS_CACHE_KEYS.pinned,
    PostItemSchema.array(),
    () => PostRepo.findPinnedPosts(context.db),
    { ttl: CACHE_TTL.pinnedPosts },
  );
}

export async function getPostsCursor(
  context: DbContext & { executionCtx: ExecutionContext },
  data: GetPostsCursorInput,
) {
  const tagName = normalizePostTagName(data.tagName);
  // 缓存键与回源查询必须使用同一个 limit（否则默认值不一致会串缓存）
  const pageSize = data.limit ?? POSTS_PAGE_SIZE;
  const fetcher = async () =>
    await PostRepo.getPostsCursor(context.db, {
      cursor: data.cursor,
      limit: pageSize,
      publicOnly: true,
      tagName,
      excludePinned: data.excludePinned,
    });

  return await CacheService.getVersioned(
    context,
    "posts:list",
    (version) =>
      POSTS_CACHE_KEYS.list(
        version,
        pageSize,
        data.cursor ?? 0,
        tagName,
        !!data.excludePinned,
      ),
    PostListResponseSchema,
    fetcher,
    {
      ttl: CACHE_TTL.postsList,
    },
  );
}

export async function findPostBySlug(
  context: DbContext & { executionCtx: ExecutionContext },
  data: FindPostBySlugInput,
) {
  const fetcher = async () => {
    const post = await PostRepo.findPostBySlug(context.db, data.slug, {
      publicOnly: true,
    });
    if (!post) return null;

    let contentJson = post.publicContentJson ?? post.contentJson;
    // Backward-compatible fallback for posts that haven't been reprocessed yet.
    // New publishes should read pre-highlighted content from `publicContentJson`.
    if (!post.publicContentJson && contentJson) {
      contentJson = await highlightCodeBlocks(contentJson);
      context.executionCtx.waitUntil(
        PostRepo.updatePublicContentSnapshot(
          context.db,
          post.id,
          contentJson,
        ).then(() => undefined),
      );
    }

    return {
      ...stripPublicContentJson(post),
      contentJson,
      toc: generateTableOfContents(contentJson),
    };
  };

  return await CacheService.getVersioned(
    context,
    "posts:detail",
    (version) => POSTS_CACHE_KEYS.detail(version, data.slug),
    PostWithTocSchema,
    fetcher,
    { ttl: CACHE_TTL.postsDetail },
  );
}

export async function getRelatedPosts(
  context: DbContext & { executionCtx: ExecutionContext },
  data: FindRelatedPostsInput,
) {
  const fetcher = async () => {
    const postIds = await PostRepo.getRelatedPostIds(context.db, data.slug, {
      limit: data.limit,
    });
    return postIds;
  };

  // 缓存 IDs。改用 posts:list 版本键：发布/下架/删除会 bump 版本，避免相关文章
  // 因非版本化键而最长 7 天不更新。
  const cachedIds = await CacheService.getVersioned(
    context,
    "posts:list",
    (version) => POSTS_CACHE_KEYS.related(version, data.slug, data.limit),
    z.array(z.number()),
    fetcher,
    {
      ttl: CACHE_TTL.relatedPosts,
    },
  );

  if (cachedIds.length === 0) {
    return [];
  }

  // Real-time hydration: fetch actual post data (automatically filters non-published)
  const posts = await PostRepo.getPublicPostsByIds(context.db, cachedIds);

  // Restore order because SQL 'IN' clause doesn't guarantee order
  const orderedPosts = cachedIds
    .map((id) => posts.find((p) => p.id === id))
    .filter((p): p is NonNullable<typeof p> => !!p);

  return orderedPosts;
}

export async function generateSummaryByPostId({
  context,
  postId,
}: {
  context: DbContext;
  postId: number;
}) {
  const post = await PostRepo.findPostById(context.db, postId);

  if (!post) {
    return err({ reason: "POST_NOT_FOUND" });
  }

  // 如果已经存在摘要，则直接返回
  if (post.summary && post.summary.trim().length > 0) return ok(post);

  const plainText = convertToPlainText(post.contentJson);
  if (plainText.length < 100) {
    return ok(post);
  }

  const { summary } = await AiService.summarizeText(context, plainText);

  const updatedPost = await PostRepo.updatePost(context.db, post.id, {
    summary,
  });

  if (!updatedPost) {
    return err({ reason: "POST_NOT_FOUND" });
  }

  return ok(stripPublicContentJson(updatedPost));
}

// ============ Admin Service Methods ============

export async function generateSlug(
  context: DbContext,
  data: GenerateSlugInput,
) {
  const baseSlug = slugify(data.title);
  // 1. 先查有没有完全一样的 (比如 'hello-world')
  const exactMatch = await PostRepo.slugExists(context.db, baseSlug, {
    excludeId: data.excludeId,
  });
  if (!exactMatch) {
    return { slug: baseSlug };
  }

  // 2. 既然 'hello-world' 被占了，那就查所有 'hello-world-%' 的
  const similarSlugs = await PostRepo.findSimilarSlugs(context.db, baseSlug, {
    excludeId: data.excludeId,
  });

  // 3. 在内存里找最大的数字后缀
  // 正则含义：匹配以 "-数字" 结尾的字符串，并捕获那个数字
  const regex = new RegExp(`^${baseSlug}-(\\d+)$`);

  let maxSuffix = 0;
  for (const slug of similarSlugs) {
    const match = slug.match(regex);
    if (match) {
      const number = parseInt(match[1], 10);
      if (number > maxSuffix) {
        maxSuffix = number;
      }
    }
  }

  // 4. 结果就是最大值 + 1
  return { slug: `${baseSlug}-${maxSuffix + 1}` };
}

export async function createEmptyPost(context: DbContext) {
  const { slug } = await generateSlug(context, { title: "" });

  const post = await PostRepo.insertPost(context.db, {
    title: "",
    slug,
    summary: "",
    status: "draft",
    readTimeInMinutes: 1,
    contentJson: null,
  });

  // No cache/index operations for drafts

  return { id: post.id };
}

export async function getPosts(context: DbContext, data: GetPostsInput) {
  return await PostRepo.getPosts(context.db, {
    offset: data.offset ?? 0,
    limit: data.limit ?? 10,
    status: data.status,
    publicOnly: data.publicOnly,
    search: data.search,
    sortDir: data.sortDir,
    sortBy: data.sortBy,
  });
}

export async function getPostsCount(
  context: DbContext,
  data: GetPostsCountInput,
) {
  return await PostRepo.getPostsCount(context.db, {
    status: data.status,
    publicOnly: data.publicOnly,
    search: data.search,
  });
}

export async function findPostBySlugAdmin(
  context: DbContext,
  data: FindPostBySlugInput,
) {
  const post = await PostRepo.findPostBySlug(context.db, data.slug, {
    publicOnly: false,
  });
  if (!post) return null;
  return {
    ...stripPublicContentJson(post),
    toc: generateTableOfContents(post.contentJson),
  };
}

export async function findPostById(
  context: DbContext,
  data: FindPostByIdInput,
) {
  const post = await PostRepo.findPostById(context.db, data.id);
  if (!post) return null;

  const kvHash = await CacheService.getRaw(
    context,
    POSTS_CACHE_KEYS.syncHash(post.id),
  );
  const hasPublicCache = kvHash !== null;

  let isSynced: boolean;
  if (post.status === "draft") {
    // 草稿：同步 = KV 中没有旧缓存
    isSynced = !hasPublicCache;
  } else {
    // 已发布：同步 = 内容 hash 一致
    const dbHash = await calculatePostHash({
      title: post.title,
      contentJson: post.contentJson,
      summary: post.summary,
      tagIds: post.tags.map((t) => t.id),
      slug: post.slug,
      publishedAt: post.publishedAt,
      pinnedAt: post.pinnedAt,
      readTimeInMinutes: post.readTimeInMinutes,
    });
    isSynced = dbHash === kvHash;
  }

  return { ...stripPublicContentJson(post), isSynced, hasPublicCache };
}

export async function updatePost(
  context: DbContext & { executionCtx: ExecutionContext; env?: Env },
  data: UpdatePostInput,
) {
  const updatedPost = await PostRepo.updatePost(context.db, data.id, data.data);
  if (!updatedPost) {
    return err({ reason: "POST_NOT_FOUND" });
  }

  if (data.data.contentJson !== undefined) {
    context.executionCtx.waitUntil(
      syncPostMedia(context.db, updatedPost.id, data.data.contentJson),
    );
  }

  context.executionCtx.waitUntil(
    PostAutoSnapshotService.enqueuePostAutoSnapshot(context, {
      postId: updatedPost.id,
      source: "post_update",
    }),
  );

  return ok(updatedPost);
}

export async function deletePost(
  context: DbContext & { executionCtx: ExecutionContext },
  data: DeletePostInput,
) {
  const post = await PostRepo.findPostById(context.db, data.id);
  if (!post) {
    return err({ reason: "POST_NOT_FOUND" });
  }

  await PostRepo.deletePost(context.db, data.id);

  // Only clear cache/index for published posts
  if (post.status === "published") {
    const tasks = [];
    const version = await CacheService.getVersion(context, "posts:detail");
    tasks.push(
      CacheService.deleteKey(
        context,
        POSTS_CACHE_KEYS.detail(version, post.slug),
      ),
    );
    tasks.push(CacheService.bumpVersion(context, "posts:list"));
    // 与发布流程保持一致：标签公开列表也属于文章派生数据
    tasks.push(CacheService.deleteKey(context, TAGS_CACHE_KEYS.publicList));
    tasks.push(SearchService.deleteIndex(context, { id: data.id }));
    tasks.push(purgePostCDNCache(context.env, post.slug));
    tasks.push(
      CacheService.deleteKey(context, POSTS_CACHE_KEYS.syncHash(data.id)),
    );

    context.executionCtx.waitUntil(Promise.all(tasks));
  } else {
    // Even for drafts, clean up hash if exists
    context.executionCtx.waitUntil(
      CacheService.deleteKey(context, POSTS_CACHE_KEYS.syncHash(data.id)),
    );
  }

  return ok({ success: true });
}

export async function previewSummary(
  context: DbContext,
  data: PreviewSummaryInput,
) {
  const plainText = convertToPlainText(data.contentJson);
  const { summary } = await AiService.summarizeText(context, plainText);
  return { summary };
}

export async function startPostProcessWorkflow(
  context: DbContext,
  data: StartPostProcessInput,
) {
  let publishedAtISO: string | undefined;
  let snapshotHash: string | undefined;

  const post = await PostRepo.findPostById(context.db, data.id);

  if (data.status === "published" && post) {
    snapshotHash = await calculatePostHash({
      title: post.title,
      contentJson: post.contentJson,
      summary: post.summary,
      tagIds: post.tags.map((tag) => tag.id),
      slug: post.slug,
      publishedAt: post.publishedAt,
      pinnedAt: post.pinnedAt,
      readTimeInMinutes: post.readTimeInMinutes,
    });

    // 幂等：同一内容重复点击发布会重复插入 publish revision，先比对最近一次
    const latestPublishRevision = await PostRevisionRepo.findLatestPostRevision(
      context.db,
      post.id,
      { reason: "publish" },
    );
    if (latestPublishRevision?.snapshotHash !== snapshotHash) {
      await PostRevisionRepo.insertPostRevision(context.db, {
        postId: post.id,
        reason: "publish",
        snapshotHash,
        snapshotJson: {
          title: post.title,
          summary: post.summary,
          slug: post.slug,
          status: post.status,
          publishedAt: post.publishedAt ? post.publishedAt.toISOString() : null,
          readTimeInMinutes: post.readTimeInMinutes,
          contentJson: post.contentJson,
          tagIds: [...new Set(post.tags.map((tag) => tag.id))].sort(
            (a, b) => a - b,
          ),
        },
      });

      logPostAutoSnapshot(context.env, "publish_revision_created", {
        postId: post.id,
        reason: "publish",
        snapshotHash,
      });
    }
  }

  // Check if we need to auto-set the published date
  if (data.status === "published") {
    if (post && !post.publishedAt) {
      const now = new Date();
      await PostRepo.updatePost(context.db, post.id, {
        publishedAt: now,
      });
      publishedAtISO = now.toISOString();
    } else if (post?.publishedAt) {
      publishedAtISO = post.publishedAt.toISOString();
    }
  }

  // publishedAt 是发布者本地当天 00:00 的精确时间戳，直接按时间判断是否未来
  const isFuture =
    !!publishedAtISO && new Date(publishedAtISO).getTime() > Date.now();

  // 先终止旧的定时发布实例，再创建新的 workflow，避免两个实例并发处理同一篇
  const scheduledId = `post-${data.id}-scheduled`;
  try {
    const oldInstance =
      await context.env.SCHEDULED_PUBLISH_WORKFLOW.get(scheduledId);
    await oldInstance.terminate();
  } catch {
    // Instance doesn't exist or already completed, ignore
  }

  const postProcessParams = {
    postId: data.id,
    isPublished: data.status === "published",
    publishedAt: publishedAtISO,
    isFuturePost: isFuture,
  };

  // 用内容 hash 作为实例 id：同一内容重复发布不会创建重复实例；若实例 id 冲突则回退到无 id 创建
  try {
    await context.env.POST_PROCESS_WORKFLOW.create({
      id: `post-${data.id}-process-${snapshotHash ?? "unpublish"}`,
      params: postProcessParams,
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        message: "post process workflow create with id failed, retrying",
        postId: data.id,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    await context.env.POST_PROCESS_WORKFLOW.create({
      params: postProcessParams,
    });
  }

  // If this is a future post, create a new scheduled publish workflow
  if (data.status === "published" && isFuture) {
    const scheduledParams = {
      postId: data.id,
      publishedAt: publishedAtISO!,
    };
    try {
      await context.env.SCHEDULED_PUBLISH_WORKFLOW.createBatch([
        { id: scheduledId, params: scheduledParams },
      ]);
    } catch (error) {
      console.error(
        JSON.stringify({
          message: "scheduled workflow create conflict, retrying after terminate",
          postId: data.id,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      try {
        const instance =
          await context.env.SCHEDULED_PUBLISH_WORKFLOW.get(scheduledId);
        await instance.terminate();
      } catch {
        // ignore
      }
      await context.env.SCHEDULED_PUBLISH_WORKFLOW.createBatch([
        { id: scheduledId, params: scheduledParams },
      ]);
    }
  }
}
