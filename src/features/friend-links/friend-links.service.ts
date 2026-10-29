import { recordAdminAudit } from "@/features/admin-audit/service/admin-audit.service";
import * as CacheService from "@/features/cache/cache.service";
import { publishNotificationEvent } from "@/features/notification/service/notification.publisher";
import { serverEnv } from "@/lib/env/server.env";
import { err, ok } from "@/lib/errors";
import { purgeCDNCache } from "@/lib/invalidate";
import * as FriendLinkRepo from "./data/friend-links.data";
import type {
  ApproveFriendLinkInput,
  CreateFriendLinkInput,
  DeleteFriendLinkInput,
  GetAllFriendLinksInput,
  RejectFriendLinkInput,
  SubmitFriendLinkInput,
  UpdateFriendLinkInput,
} from "./friend-links.schema";
import {
  ApprovedFriendLinksResponseSchema,
  FRIEND_LINKS_CACHE_KEYS,
} from "./friend-links.schema";

// ============ Authed User Methods ============

/** 归一化 siteUrl 用于重复判断：忽略协议大小写/尾斜杠/路径大小写差异 */
function normalizeSiteUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\/+$/, "");
    return `${parsed.origin}${path}`.toLowerCase();
  } catch {
    return url.trim().toLowerCase();
  }
}

export async function submitFriendLink(
  context: AuthContext & { executionCtx: ExecutionContext },
  data: SubmitFriendLinkInput,
) {
  const existing = await FriendLinkRepo.getFriendLinksByUserId(
    context.db,
    context.session.user.id,
  );
  const normalizedUrl = normalizeSiteUrl(data.siteUrl);
  const hasDuplicateUrl = existing.some(
    (link) =>
      link.status !== "rejected" &&
      normalizeSiteUrl(link.siteUrl) === normalizedUrl,
  );
  if (hasDuplicateUrl) {
    return err({ reason: "DUPLICATE_URL" });
  }

  const friendLink = await FriendLinkRepo.insertFriendLink(context.db, {
    siteName: data.siteName,
    siteUrl: data.siteUrl,
    description: data.description,
    logoUrl: data.logoUrl,
    contactEmail: data.contactEmail,
    userId: context.session.user.id,
    status: "pending",
  });

  // Notify admin via email. 通知失败不应把已成功写入的提交变成错误响应。
  try {
    const { ADMIN_EMAIL, DOMAIN } = serverEnv(context.env);
    await publishNotificationEvent(context, {
      type: "friend_link.submitted",
      data: {
        to: ADMIN_EMAIL,
        siteName: data.siteName,
        siteUrl: data.siteUrl,
        description: data.description || "",
        submitterName: context.session.user.name,
        reviewUrl: `https://${DOMAIN}/admin/friend-links`,
      },
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        message: "friend link admin notification failed",
        friendLinkId: friendLink.id,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }

  return ok(friendLink);
}

export async function getMyFriendLinks(context: AuthContext) {
  return await FriendLinkRepo.getFriendLinksByUserId(
    context.db,
    context.session.user.id,
  );
}

// ============ Public Methods ============

export async function getApprovedFriendLinks(
  context: DbContext & { executionCtx: ExecutionContext },
) {
  const fetcher = async () =>
    await FriendLinkRepo.getApprovedFriendLinks(context.db);

  return await CacheService.getVersioned(
    context,
    "friend-links:list",
    FRIEND_LINKS_CACHE_KEYS.approvedList,
    ApprovedFriendLinksResponseSchema,
    fetcher,
    { ttl: "7d" },
  );
}

// ============ Admin Methods ============

function invalidateCache(
  context: DbContext & { executionCtx: ExecutionContext },
) {
  context.executionCtx.waitUntil(
    Promise.all([
      CacheService.bumpVersion(context, "friend-links:list"),
      purgeCDNCache(context.env, {
        urls: ["/friend-links"],
      }),
    ]),
  );
}

export async function createFriendLink(
  context: DbContext & { executionCtx: ExecutionContext },
  data: CreateFriendLinkInput,
) {
  const friendLink = await FriendLinkRepo.insertFriendLink(context.db, {
    siteName: data.siteName,
    siteUrl: data.siteUrl,
    description: data.description,
    logoUrl: data.logoUrl,
    contactEmail: data.contactEmail,
    userId: null,
    status: "approved",
  });

  invalidateCache(context);

  return friendLink;
}

export async function getAllFriendLinks(
  context: DbContext,
  data: GetAllFriendLinksInput,
) {
  const [items, total] = await Promise.all([
    FriendLinkRepo.getAllFriendLinks(context.db, {
      offset: data.offset,
      limit: data.limit,
      status: data.status,
    }),
    FriendLinkRepo.getAllFriendLinksCount(context.db, {
      status: data.status,
    }),
  ]);

  return { items, total };
}

export async function approveFriendLink(
  context: DbContext & { executionCtx: ExecutionContext },
  data: ApproveFriendLinkInput,
) {
  const friendLink = await FriendLinkRepo.findFriendLinkById(
    context.db,
    data.id,
  );
  if (!friendLink) {
    return err({ reason: "NOT_FOUND" });
  }

  const wasApproved = friendLink.status === "approved";

  const updated = await FriendLinkRepo.updateFriendLink(context.db, data.id, {
    status: "approved",
    rejectionReason: null,
  });

  // 只有状态发生变化时才需要失效缓存/重复发送通知
  if (!wasApproved) {
    invalidateCache(context);

    if (friendLink.contactEmail) {
      try {
        const { DOMAIN } = serverEnv(context.env);
        await publishNotificationEvent(context, {
          type: "friend_link.approved",
          data: {
            to: friendLink.contactEmail,
            siteName: friendLink.siteName,
            blogUrl: `https://${DOMAIN}`,
          },
        });
      } catch (error) {
        console.error(
          JSON.stringify({
            message: "friend link approve notification failed",
            friendLinkId: friendLink.id,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }
  }

  await recordAdminAudit(context, {
    action: "friend_link.approve",
    resourceType: "friend_link",
    resourceId: friendLink.id,
    metadata: { siteName: friendLink.siteName },
  });

  return ok(updated);
}

export async function rejectFriendLink(
  context: DbContext & { executionCtx: ExecutionContext },
  data: RejectFriendLinkInput,
) {
  const friendLink = await FriendLinkRepo.findFriendLinkById(
    context.db,
    data.id,
  );
  if (!friendLink) {
    return err({ reason: "NOT_FOUND" });
  }

  const alreadyRejected = friendLink.status === "rejected";

  const updated = await FriendLinkRepo.updateFriendLink(context.db, data.id, {
    status: "rejected",
    rejectionReason: data.rejectionReason,
  });

  if (friendLink.status === "approved") {
    invalidateCache(context);
  }

  // 只在状态真正变化时通知，避免重复点击导致重复邮件
  if (!alreadyRejected && friendLink.contactEmail) {
    try {
      await publishNotificationEvent(context, {
        type: "friend_link.rejected",
        data: {
          to: friendLink.contactEmail,
          siteName: friendLink.siteName,
          rejectionReason: data.rejectionReason,
        },
      });
    } catch (error) {
      console.error(
        JSON.stringify({
          message: "friend link reject notification failed",
          friendLinkId: friendLink.id,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  await recordAdminAudit(context, {
    action: "friend_link.reject",
    resourceType: "friend_link",
    resourceId: friendLink.id,
    metadata: { siteName: friendLink.siteName },
  });

  return ok(updated);
}

export async function updateFriendLink(
  context: DbContext & { executionCtx: ExecutionContext },
  data: UpdateFriendLinkInput,
) {
  const friendLink = await FriendLinkRepo.findFriendLinkById(
    context.db,
    data.id,
  );
  if (!friendLink) {
    return err({ reason: "NOT_FOUND" });
  }

  const { id, ...updateData } = data;

  const updated = await FriendLinkRepo.updateFriendLink(
    context.db,
    id,
    updateData,
  );

  if (friendLink.status === "approved") {
    invalidateCache(context);
  }

  await recordAdminAudit(context, {
    action: "friend_link.update",
    resourceType: "friend_link",
    resourceId: friendLink.id,
    metadata: { siteName: friendLink.siteName },
  });

  return ok(updated);
}

export async function deleteFriendLink(
  context: DbContext & { executionCtx: ExecutionContext },
  data: DeleteFriendLinkInput,
) {
  const friendLink = await FriendLinkRepo.findFriendLinkById(
    context.db,
    data.id,
  );
  if (!friendLink) {
    return err({ reason: "NOT_FOUND" });
  }

  await FriendLinkRepo.deleteFriendLink(context.db, data.id);

  if (friendLink.status === "approved") {
    invalidateCache(context);
  }

  await recordAdminAudit(context, {
    action: "friend_link.delete",
    resourceType: "friend_link",
    resourceId: friendLink.id,
    metadata: { siteName: friendLink.siteName },
  });

  return ok({ success: true });
}
