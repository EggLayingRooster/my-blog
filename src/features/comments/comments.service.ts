import type {
  CreateCommentInput,
  DeleteCommentInput,
  GetAllCommentsInput,
  GetCommentsByPostIdInput,
  GetMyCommentsInput,
  ModerateCommentInput,
  StartCommentModerationInput,
} from "@/features/comments/comments.schema";
import * as CommentRepo from "@/features/comments/data/comments.data";
import { recordAdminAudit } from "@/features/admin-audit/service/admin-audit.service";
import { sendReplyNotification } from "@/features/comments/workflows/helpers";
import { publishNotificationEvent } from "@/features/notification/service/notification.publisher";
import * as PostService from "@/features/posts/services/posts.service";
import { convertToPlainText } from "@/features/posts/utils/content";
import { serverEnv } from "@/lib/env/server.env";
import { err, ok } from "@/lib/errors";

// ============ Public Service Methods ============

export async function getRootCommentsByPostId(
  context: DbContext,
  data: GetCommentsByPostIdInput & { viewerId?: string },
) {
  const [items, total] = await Promise.all([
    CommentRepo.getRootCommentsByPostId(context.db, data.postId, {
      offset: data.offset,
      limit: data.limit,
      viewerId: data.viewerId,
      status: data.viewerId ? undefined : ["published"],
    }),
    CommentRepo.getRootCommentsByPostIdCount(context.db, data.postId, {
      viewerId: data.viewerId,
      status: data.viewerId ? undefined : ["published"],
    }),
  ]);

  // 批量查询每个根评论的回复数，避免 N+1
  const replyCounts = await CommentRepo.getReplyCountsByRootIds(
    context.db,
    data.postId,
    items.map((item) => item.id),
    {
      viewerId: data.viewerId,
      status: data.viewerId ? undefined : ["published"],
    },
  );
  const itemsWithReplyCount = items.map((item) => ({
    ...item,
    replyCount: replyCounts.get(item.id) ?? 0,
  }));

  return { items: itemsWithReplyCount, total };
}

export async function getRepliesByRootId(
  context: DbContext,
  data: { postId: number; rootId: number; offset?: number; limit?: number } & {
    viewerId?: string;
  },
) {
  const [items, total] = await Promise.all([
    CommentRepo.getRepliesByRootId(context.db, data.postId, data.rootId, {
      offset: data.offset,
      limit: data.limit,
      viewerId: data.viewerId,
      status: data.viewerId ? undefined : ["published"],
    }),
    CommentRepo.getRepliesByRootIdCount(context.db, data.postId, data.rootId, {
      viewerId: data.viewerId,
      status: data.viewerId ? undefined : ["published"],
    }),
  ]);

  return { items, total };
}

// ============ Authed User Service Methods ============

const MAX_COMMENT_CONTENT_BYTES = 20_000;

export async function createComment(
  context: AuthContext & { executionCtx: ExecutionContext },
  data: CreateCommentInput,
) {
  const isAdmin = context.session.user.role === "admin";

  // 校验文章存在且已发布（管理员可对草稿评论，其余用户只允许已到发布时间的文章）
  const post = await PostService.findPostById(context, {
    id: data.postId,
  });
  if (!post) {
    return err({ reason: "POST_NOT_FOUND" });
  }
  const postReachedPublishTime =
    post.status === "published" &&
    (!post.publishedAt || post.publishedAt.getTime() <= Date.now());
  if (!isAdmin && !postReachedPublishTime) {
    return err({ reason: "POST_NOT_PUBLISHED" });
  }

  // 限制评论体积，避免超大 JSON 占满存储/渲染
  if (JSON.stringify(data.content).length > MAX_COMMENT_CONTENT_BYTES) {
    return err({ reason: "COMMENT_TOO_LARGE" });
  }

  // 只有已发布评论、自己的评论（未删除）或管理员可见；避免回复他人不可见评论
  const canSeeComment = (comment: {
    status: string;
    userId: string | null;
  }) =>
    isAdmin ||
    comment.status === "published" ||
    (comment.status !== "deleted" &&
      comment.userId === context.session.user.id);

  // Validation: ensure 2-level structure
  let rootId: number | null = null;
  let replyToCommentId: number | null = null;

  if (data.rootId) {
    // Creating a reply - validate rootId exists and is a root comment
    const rootComment = await CommentRepo.findCommentById(
      context.db,
      data.rootId,
    );
    if (!rootComment || !canSeeComment(rootComment)) {
      return err({ reason: "ROOT_COMMENT_NOT_FOUND" });
    }
    if (rootComment.rootId !== null) {
      return err({ reason: "INVALID_ROOT_ID" });
    }
    if (rootComment.postId !== data.postId) {
      return err({ reason: "ROOT_COMMENT_POST_MISMATCH" });
    }
    rootId = data.rootId;

    // If replyToCommentId is provided, validate it belongs to the same root
    if (data.replyToCommentId) {
      const replyToComment = await CommentRepo.findCommentById(
        context.db,
        data.replyToCommentId,
      );
      if (!replyToComment || !canSeeComment(replyToComment)) {
        return err({ reason: "REPLY_TO_COMMENT_NOT_FOUND" });
      }
      // replyToComment must be either the root or a reply under the same root
      const actualRootId = replyToComment.rootId ?? replyToComment.id;
      if (actualRootId !== rootId) {
        return err({ reason: "REPLY_TO_COMMENT_ROOT_MISMATCH" });
      }
      replyToCommentId = data.replyToCommentId;
    } else {
      // If no replyToCommentId, default to replying to the root
      replyToCommentId = rootId;
    }
  } else {
    // Creating a root comment - ensure no replyToCommentId
    if (data.replyToCommentId) {
      return err({ reason: "ROOT_COMMENT_CANNOT_HAVE_REPLY_TO" });
    }
  }

  const comment = await CommentRepo.insertComment(context.db, {
    postId: data.postId,
    content: data.content,
    rootId,
    replyToCommentId,
    userId: context.session.user.id,
    // Admin comments are published immediately, others go through moderation
    status: isAdmin ? "published" : "verifying",
  });

  // Trigger AI moderation workflow only for non-admin users
  if (!isAdmin) {
    await startCommentModerationWorkflow(context, { commentId: comment.id });
  }

  // Send reply notification for admin replies (non-admin replies get notified via moderation workflow)
  if (isAdmin && replyToCommentId) {
    const post = await PostService.findPostById(context, {
      id: data.postId,
    });
    if (post) {
      await sendReplyNotification(context, {
        comment: {
          id: comment.id,
          rootId: comment.rootId,
          replyToCommentId: comment.replyToCommentId,
          userId: comment.userId,
          content: data.content,
        },
        post: { slug: post.slug, title: post.title },
      });
    }
  }

  // Notify admin about new root comments from non-admin users only
  // - Skip if admin is commenting (no need to notify yourself)
  // - Skip if it's a reply (only root comments trigger admin notification)
  const isRootComment = rootId === null;
  if (!isAdmin && isRootComment) {
    const post = await PostService.findPostById(context, { id: data.postId });
    if (post) {
      const { ADMIN_EMAIL, DOMAIN } = serverEnv(context.env);
      const commentPreview = convertToPlainText(data.content).slice(0, 100);
      const commenterName = context.session.user.name;
      try {
        await publishNotificationEvent(context, {
          type: "comment.admin_root_created",
          data: {
            to: ADMIN_EMAIL,
            postTitle: post.title,
            commenterName,
            commentPreview: `${commentPreview}${commentPreview.length >= 100 ? "..." : ""}`,
            commentUrl: `https://${DOMAIN}/post/${post.slug}?highlightCommentId=${comment.id}&rootId=${comment.id}#comment-${comment.id}`,
          },
        });
      } catch (error) {
        console.error(
          JSON.stringify({
            message: "comment admin notification failed",
            commentId: comment.id,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }
  }

  return ok(comment);
}

export async function deleteComment(
  context: AuthContext,
  data: DeleteCommentInput,
) {
  const comment = await CommentRepo.findCommentById(context.db, data.id);

  if (!comment) {
    return err({ reason: "COMMENT_NOT_FOUND" });
  }

  // Only allow deleting own comments (unless admin)
  const userRole = context.session.user.role;
  if (comment.userId !== context.session.user.id && userRole !== "admin") {
    return err({ reason: "PERMISSION_DENIED" });
  }

  // Soft delete by setting status to deleted
  await CommentRepo.updateComment(context.db, data.id, {
    status: "deleted",
  });

  return ok({ success: true });
}

export async function getMyComments(
  context: AuthContext,
  data: GetMyCommentsInput,
) {
  return await CommentRepo.getCommentsByUserId(
    context.db,
    context.session.user.id,
    {
      offset: data.offset,
      limit: data.limit,
      status: data.status,
    },
  );
}

// ============ Admin Service Methods ============

export async function getAllComments(
  context: DbContext,
  data: GetAllCommentsInput,
) {
  const [items, total] = await Promise.all([
    CommentRepo.getAllComments(context.db, {
      offset: data.offset,
      limit: data.limit,
      status: data.status,
      postId: data.postId,
      userId: data.userId,
      userName: data.userName,
    }),
    CommentRepo.getAllCommentsCount(context.db, {
      status: data.status,
      postId: data.postId,
      userId: data.userId,
      userName: data.userName,
    }),
  ]);

  return { items, total };
}

export async function moderateComment(
  context: DbContext & { executionCtx: ExecutionContext },
  data: ModerateCommentInput,
  moderatorUserId?: string,
) {
  const comment = await CommentRepo.findCommentById(context.db, data.id);

  if (!comment) {
    return err({ reason: "COMMENT_NOT_FOUND" });
  }

  const updatedComment = await CommentRepo.updateComment(context.db, data.id, {
    status: data.status,
  });

  // Send reply notification when manually approving a reply comment
  // Guard: only on first approval (comment.status !== "published") to prevent duplicates
  if (
    data.status === "published" &&
    comment.status !== "published" &&
    comment.replyToCommentId
  ) {
    const post = await PostService.findPostById(context, {
      id: comment.postId,
    });
    if (post) {
      await sendReplyNotification(context, {
        comment: {
          id: comment.id,
          rootId: comment.rootId,
          replyToCommentId: comment.replyToCommentId,
          userId: comment.userId,
          content: comment.content,
        },
        post: { slug: post.slug, title: post.title },
        skipNotifyUserId: moderatorUserId,
      });
    }
  }

  await recordAdminAudit(context, {
    action: "comment.moderate",
    resourceType: "comment",
    resourceId: comment.id,
    metadata: { status: data.status },
  });

  return ok(updatedComment);
}

export async function adminDeleteComment(
  context: DbContext,
  data: DeleteCommentInput,
) {
  const comment = await CommentRepo.findCommentById(context.db, data.id);

  if (!comment) {
    return err({ reason: "COMMENT_NOT_FOUND" });
  }

  // Hard delete for admin
  await CommentRepo.deleteComment(context.db, data.id);

  await recordAdminAudit(context, {
    action: "comment.delete",
    resourceType: "comment",
    resourceId: comment.id,
    metadata: { status: comment.status, postId: comment.postId },
  });

  return ok({ success: true });
}

// ============ Workflow Methods ============

export async function startCommentModerationWorkflow(
  context: DbContext,
  data: StartCommentModerationInput,
) {
  // 使用稳定实例 id：同一条评论不会因为重复调用/重试产生并行审核
  try {
    await context.env.COMMENT_MODERATION_WORKFLOW.create({
      id: `comment-moderation-${data.commentId}`,
      params: {
        commentId: data.commentId,
      },
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        message: "comment moderation workflow create failed, retry without id",
        commentId: data.commentId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    await context.env.COMMENT_MODERATION_WORKFLOW.create({
      params: {
        commentId: data.commentId,
      },
    });
  }
}

export async function findCommentById(context: DbContext, commentId: number) {
  return await CommentRepo.findCommentById(context.db, commentId);
}

export async function updateCommentStatus(
  context: DbContext,
  commentId: number,
  status: "published" | "pending" | "deleted",
  aiReason?: string,
) {
  return await CommentRepo.updateComment(context.db, commentId, {
    status,
    aiReason,
  });
}

/**
 * 审核专用：仅当评论仍为 verifying 时更新，返回 null 表示已被其他流程处理。
 * 用于避免重复审核通知/回复通知。
 */
export async function updateCommentStatusIfVerifying(
  context: DbContext,
  commentId: number,
  status: "published" | "pending" | "deleted",
  aiReason?: string,
) {
  return await CommentRepo.updateCommentStatusIfVerifying(
    context.db,
    commentId,
    status,
    aiReason,
  );
}

export async function getUserCommentStats(context: DbContext, userId: string) {
  return await CommentRepo.getUserCommentStats(context.db, userId);
}

/** scheduled 任务：清理审核 Workflow 超时后仍停留在 verifying 的评论 */
export async function cleanupStaleVerifyingComments(
  context: DbContext,
  olderThanMinutes = 15,
): Promise<number> {
  const count = await CommentRepo.markStaleVerifyingCommentsPending(
    context.db,
    new Date(Date.now() - olderThanMinutes * 60 * 1000),
  );
  if (count > 0) {
    console.error(
      JSON.stringify({
        message: "stale verifying comments moved to pending",
        count,
      }),
    );
  }
  return count;
}
