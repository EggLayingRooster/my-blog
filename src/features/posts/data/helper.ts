import type { SQL } from "drizzle-orm";
import { and, asc, desc, eq, like, sql } from "drizzle-orm";
import type { PostStatus } from "@/lib/db/schema";
import { PostsTable } from "@/lib/db/schema";

export type SortField = "publishedAt" | "updatedAt";
export type SortDirection = "ASC" | "DESC";

export function buildPostWhereClause(options: {
  status?: PostStatus;
  publicOnly?: boolean; // For public pages - checks publishedAt <= now
  search?: string;
}) {
  const whereClauses = [];

  if (options.status) {
    whereClauses.push(eq(PostsTable.status, options.status));
  }

  // For public pages, also filter by publishedAt
  if (options.publicOnly) {
    whereClauses.push(eq(PostsTable.status, "published"));
    // 按站点本地时区（UTC+8）比较“日期”：publishedAt 存为所选日期的 12:00 UTC
    // （= 北京时间 20:00）。如果直接用 UTC 日期比较，在北京时间 00:00–08:00
    // 之间“今天”发布的文章会被当成未来日期，最多晚 8 小时才出现在前台。
    whereClauses.push(
      sql`date(${PostsTable.publishedAt}, 'unixepoch', '+8 hours') <= date('now', '+8 hours')`,
    );
  }

  // Search by title
  if (options.search) {
    const searchTerm = options.search.trim();
    if (searchTerm) {
      whereClauses.push(like(PostsTable.title, `%${searchTerm}%`));
    }
  }

  return whereClauses.length > 0 ? and(...whereClauses) : undefined;
}

export function buildPostOrderByClause(
  sortDir?: SortDirection,
  sortBy?: SortField,
): SQL {
  const direction = sortDir ?? "DESC";
  const field = sortBy ?? "updatedAt";
  const orderFn = direction === "DESC" ? desc : asc;
  return orderFn(PostsTable[field]);
}
