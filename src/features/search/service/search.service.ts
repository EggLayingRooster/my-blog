import { insert, search as oramaSearch, remove } from "@orama/orama";
import { and, eq, inArray, lte } from "drizzle-orm";
import { convertToPlainText } from "@/features/posts/utils/content";
import { createMyDb } from "@/features/search/model/schema";
import {
  getOramaDb,
  getOramaMeta,
  mutateOramaIndex,
  replaceOramaIndex,
} from "@/features/search/model/store";
import {
  CONTENT_SLICE,
  SNIPPET_SLICE,
} from "@/features/search/search.constants";
import type {
  DeleteSearchDocInput,
  SearchQueryInput,
  UpsertSearchDocInput,
} from "@/features/search/search.schema";
import {
  buildSnippet,
  getMatchedTerms,
} from "@/features/search/utils/search.utils";
import { PostsTable } from "@/lib/db/schema";

export async function search(context: DbContext, data: SearchQueryInput) {
  const db = await getOramaDb(context.env);
  const result = await oramaSearch(db, {
    term: data.q,
    limit: Math.min(Math.max(data.limit, 1), 25),
  });

  // 索引可能滞后：返回前再用 DB 校验公开状态，避免草稿/未来/已删除文章从搜索泄露
  const hitIds = result.hits
    .map((hit) => Number(hit.document.id))
    .filter((id) => Number.isInteger(id) && id > 0);
  const allowedIds = new Set<number>();
  if (hitIds.length > 0) {
    const rows = await context.db
      .select({ id: PostsTable.id })
      .from(PostsTable)
      .where(
        and(
          inArray(PostsTable.id, hitIds),
          eq(PostsTable.status, "published"),
          lte(PostsTable.publishedAt, new Date()),
        ),
      );
    for (const row of rows) allowedIds.add(row.id);
  }

  return result.hits
    .filter((hit) => allowedIds.has(Number(hit.document.id)))
    .map((hit) => {
    const { document, score } = hit;
    const titleHighlight = buildSnippet({
      text: document.title,
      terms: getMatchedTerms(hit, "title"),
      fallbackTerm: data.q,
    });
    const summaryHighlight = buildSnippet({
      text: document.summary,
      terms: getMatchedTerms(hit, "summary"),
      fallbackTerm: data.q,
    });
    const contentHighlight = buildSnippet({
      text: document.content,
      terms: getMatchedTerms(hit, "content"),
      fallbackTerm: data.q,
    });

    return {
      post: {
        id: document.id,
        slug: document.slug,
        title: document.title,
        summary: document.summary,
        tags: document.tags,
      },
      score,
      matches: {
        title: titleHighlight,
        summary: summaryHighlight,
        contentSnippet: contentHighlight,
      },
    };
  });
}

export async function upsert(
  context: { env: Env },
  data: UpsertSearchDocInput,
) {
  const plain = convertToPlainText(data.contentJson ?? null);
  const content =
    plain.length > CONTENT_SLICE ? plain.slice(0, CONTENT_SLICE) : plain;
  const summary =
    data.summary && data.summary.trim().length > 0
      ? data.summary
      : content.slice(0, SNIPPET_SLICE);

  await mutateOramaIndex(context.env, async (db) => {
    try {
      await remove(db, data.id.toString());
    } catch {
      // remove 不存在的文档会抛错，忽略即可
    }

    await insert(db, {
      id: data.id.toString(),
      slug: data.slug,
      title: data.title,
      summary,
      content,
      tags: data.tags ?? [],
    });
  });

  return { id: data.id };
}

export async function deleteIndex(
  context: { env: Env },
  data: DeleteSearchDocInput,
) {
  await mutateOramaIndex(context.env, async (db) => {
    try {
      await remove(db, data.id.toString());
    } catch {
      // 文档不存在时视为删除成功
    }
  });

  return { id: data.id };
}

export async function rebuildIndex(context: DbContext) {
  const { env, db } = context;
  const start = Date.now();
  console.log("[search] Start backfilling index...");

  const posts = await db.query.PostsTable.findMany({
    where: and(
      eq(PostsTable.status, "published"),
      lte(PostsTable.publishedAt, new Date()),
    ),
    with: {
      postTags: {
        with: {
          tag: true,
        },
      },
    },
  });

  await replaceOramaIndex(env, async () => {
    const searchDb = await createMyDb();

    for (const post of posts) {
      if (!post.title || !post.slug) continue;
      const plain = convertToPlainText(post.contentJson);
      const content =
        plain.length > CONTENT_SLICE ? plain.slice(0, CONTENT_SLICE) : plain;
      const summary =
        post.summary && post.summary.trim().length > 0
          ? post.summary
          : content.slice(0, SNIPPET_SLICE);

      const tags = post.postTags.map((pt) => pt.tag.name);

      await insert(searchDb, {
        id: post.id.toString(),
        title: post.title,
        slug: post.slug,
        tags,
        summary,
        content,
      });
    }

    return searchDb;
  });

  const duration = Date.now() - start;
  console.log(`[search] Indexed ${posts.length} posts in ${duration}ms`);

  return { indexed: posts.length, duration };
}

export async function getIndexVersion(context: DbContext) {
  return await getOramaMeta(context.env);
}
