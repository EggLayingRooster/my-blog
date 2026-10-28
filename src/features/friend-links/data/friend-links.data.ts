import { and, count, desc, eq } from "drizzle-orm";
import type { FriendLinkStatus } from "@/lib/db/schema";
import { FriendLinksTable, user } from "@/lib/db/schema";

const DEFAULT_PAGE_SIZE = 20;

export async function insertFriendLink(
  db: DB,
  data: typeof FriendLinksTable.$inferInsert,
) {
  const [friendLink] = await db
    .insert(FriendLinksTable)
    .values(data)
    .returning();
  return friendLink;
}

export async function findFriendLinkById(db: DB, id: number) {
  return await db.query.FriendLinksTable.findFirst({
    where: eq(FriendLinksTable.id, id),
  });
}

export async function getAllFriendLinks(
  db: DB,
  options: {
    offset?: number;
    limit?: number | null;
    status?: FriendLinkStatus;
  } = {},
) {
  const { offset = 0, limit = DEFAULT_PAGE_SIZE, status } = options;
  const conditions = [];
  if (status) conditions.push(eq(FriendLinksTable.status, status));

  const query = db
    .select({
      id: FriendLinksTable.id,
      siteName: FriendLinksTable.siteName,
      siteUrl: FriendLinksTable.siteUrl,
      description: FriendLinksTable.description,
      logoUrl: FriendLinksTable.logoUrl,
      contactEmail: FriendLinksTable.contactEmail,
      status: FriendLinksTable.status,
      rejectionReason: FriendLinksTable.rejectionReason,
      userId: FriendLinksTable.userId,
      createdAt: FriendLinksTable.createdAt,
      updatedAt: FriendLinksTable.updatedAt,
      user: {
        id: user.id,
        name: user.name,
        image: user.image,
      },
    })
    .from(FriendLinksTable)
    .leftJoin(user, eq(FriendLinksTable.userId, user.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(FriendLinksTable.createdAt));

  const items =
    limit == null
      ? await query.offset(offset)
      : await query.limit(Math.min(limit, 100)).offset(offset);

  return items;
}

/**
 * 公开友链：只返回展示所需字段，避免把 contactEmail/rejectionReason 等
 * 提交者隐私信息暴露给所有访客。
 */
export async function getApprovedFriendLinks(db: DB) {
  return await db
    .select({
      id: FriendLinksTable.id,
      siteName: FriendLinksTable.siteName,
      siteUrl: FriendLinksTable.siteUrl,
      description: FriendLinksTable.description,
      logoUrl: FriendLinksTable.logoUrl,
      user: {
        id: user.id,
        name: user.name,
        image: user.image,
      },
    })
    .from(FriendLinksTable)
    .leftJoin(user, eq(FriendLinksTable.userId, user.id))
    .where(eq(FriendLinksTable.status, "approved"))
    .orderBy(desc(FriendLinksTable.createdAt));
}

export async function getAllFriendLinksCount(
  db: DB,
  options: { status?: FriendLinkStatus } = {},
) {
  const conditions = [];
  if (options.status)
    conditions.push(eq(FriendLinksTable.status, options.status));

  const result = await db
    .select({ count: count() })
    .from(FriendLinksTable)
    .where(conditions.length > 0 ? and(...conditions) : undefined);

  return result[0].count;
}

export async function getFriendLinksByUserId(db: DB, userId: string) {
  return await db
    .select()
    .from(FriendLinksTable)
    .where(eq(FriendLinksTable.userId, userId))
    .orderBy(desc(FriendLinksTable.createdAt));
}

export async function updateFriendLink(
  db: DB,
  id: number,
  data: Partial<Omit<typeof FriendLinksTable.$inferInsert, "id" | "createdAt">>,
) {
  const [friendLink] = await db
    .update(FriendLinksTable)
    .set(data)
    .where(eq(FriendLinksTable.id, id))
    .returning();
  return friendLink;
}

export async function deleteFriendLink(db: DB, id: number) {
  await db.delete(FriendLinksTable).where(eq(FriendLinksTable.id, id));
}
