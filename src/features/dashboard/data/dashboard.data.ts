import { count, desc, eq } from "drizzle-orm";
import { CommentsTable, PostsTable, user as UserTable } from "@/lib/db/schema";

export async function getPendingCommentsCount(db: DB) {
  const [result] = await db
    .select({ count: count() })
    .from(CommentsTable)
    .where(eq(CommentsTable.status, "pending"));
  return result.count;
}

export async function getPublishedPostsCount(db: DB) {
  const [result] = await db
    .select({ count: count() })
    .from(PostsTable)
    .where(eq(PostsTable.status, "published"));
  return result.count;
}

export async function getDraftsCount(db: DB) {
  const [result] = await db
    .select({ count: count() })
    .from(PostsTable)
    .where(eq(PostsTable.status, "draft"));
  return result.count;
}

export async function getRecentComments(db: DB, limit = 5) {
  return db
    .select()
    .from(CommentsTable)
    .orderBy(desc(CommentsTable.createdAt))
    .limit(limit)
    .leftJoin(UserTable, eq(CommentsTable.userId, UserTable.id))
    .leftJoin(PostsTable, eq(CommentsTable.postId, PostsTable.id));
}

export async function getRecentPosts(db: DB, limit = 5) {
  return db
    .select()
    .from(PostsTable)
    .where(eq(PostsTable.status, "published"))
    .orderBy(desc(PostsTable.publishedAt))
    .limit(limit);
}

export async function getRecentUsers(db: DB, limit = 5) {
  // 只显示已完成邮箱验证的用户，避免机器人注册（未验证）刷屏系统日志
  return db
    .select()
    .from(UserTable)
    .where(eq(UserTable.emailVerified, true))
    .orderBy(desc(UserTable.createdAt))
    .limit(limit);
}
