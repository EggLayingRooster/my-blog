import { and, eq, isNotNull, lt } from "drizzle-orm";
import { account, session, user, verification } from "@/lib/db/schema";

export async function userHasPassword(db: DB, userId: string) {
  const userAccount = await db.query.account.findFirst({
    where: and(eq(account.userId, userId), isNotNull(account.password)),
  });

  return !!userAccount;
}

export async function updateUser(
  db: DB,
  userId: string,
  data: Partial<Omit<typeof user.$inferInsert, "id" | "createdAt">>,
) {
  const [updatedUser] = await db
    .update(user)
    .set(data)
    .where(eq(user.id, userId))
    .returning();
  return updatedUser;
}

/** 清理过期 session / verification 记录（由 scheduled 任务调用） */
export async function deleteExpiredSessions(db: DB): Promise<void> {
  await db.delete(session).where(lt(session.expiresAt, new Date()));
}

export async function deleteExpiredVerifications(db: DB): Promise<void> {
  await db.delete(verification).where(lt(verification.expiresAt, new Date()));
}
