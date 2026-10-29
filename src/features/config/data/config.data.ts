import { desc, eq, ne } from "drizzle-orm";
import type { SystemConfig } from "@/features/config/config.schema";
import { SystemConfigTable } from "@/lib/db/schema";

export async function getSystemConfigWithMeta(
  db: DB,
): Promise<{ config: SystemConfig; updatedAt: Date; version: number } | null> {
  const row = await db.query.SystemConfigTable.findFirst({
    orderBy: desc(SystemConfigTable.updatedAt),
  });
  if (!row?.configJson) return null;
  return { config: row.configJson, updatedAt: row.updatedAt, version: row.version };
}

export async function getSystemConfig(db: DB): Promise<SystemConfig | null> {
  const row = await getSystemConfigWithMeta(db);
  return row?.config ?? null;
}

async function deleteOtherRows(db: DB, keepId: number): Promise<void> {
  await db
    .delete(SystemConfigTable)
    .where(ne(SystemConfigTable.id, keepId));
}

export async function upsertSystemConfig(
  db: DB,
  data: SystemConfig,
): Promise<number> {
  const existing = await db.query.SystemConfigTable.findFirst({
    orderBy: desc(SystemConfigTable.updatedAt),
  });

  if (existing) {
    const nextVersion = existing.version + 1;
    await db
      .update(SystemConfigTable)
      .set({ configJson: data, version: nextVersion })
      .where(eq(SystemConfigTable.id, existing.id));
    // 清理历史遗留的多行配置，避免后续读取到任意一行
    await deleteOtherRows(db, existing.id);
    return nextVersion;
  }

  // 配置表只允许一行：并发首次写入时用固定 id=1，冲突后回退到 update
  try {
    await db.insert(SystemConfigTable).values({ id: 1, configJson: data, version: 1 });
    await deleteOtherRows(db, 1);
    return 1;
  } catch (error) {
    const row = await db.query.SystemConfigTable.findFirst({
      orderBy: desc(SystemConfigTable.updatedAt),
    });
    if (!row) throw error;
    const nextVersion = row.version + 1;
    await db
      .update(SystemConfigTable)
      .set({ configJson: data, version: nextVersion })
      .where(eq(SystemConfigTable.id, row.id));
    await deleteOtherRows(db, row.id);
    return nextVersion;
  }
}
