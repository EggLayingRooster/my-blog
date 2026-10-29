import { handleEmailMessage } from "@/features/email/api/email.consumer";
import { handlePageviewMessages } from "@/features/pageview/api/pageview.consumer";
import { handlePostAutoSnapshotMessage } from "@/features/posts/api/post-auto-snapshot.consumer";
import { handleWebhookMessage } from "@/features/webhook/api/webhook.consumer";
import * as SearchService from "@/features/search/service/search.service";
import { getDb } from "@/lib/db";
import { queueMessageSchema } from "@/lib/queue/queue.schema";
import { redactQueueBodyForDeadLetter } from "@/lib/queue/queue.redaction";

const MAX_QUEUE_ATTEMPTS = 3;
const DEAD_LETTER_TTL_SECONDS = 7 * 24 * 60 * 60;

async function persistDeadLetter(
  env: Env,
  message: Message,
  eventType: string,
  error: unknown,
) {
  const key = `queue:dead-letter:${message.id}`;
  await env.KV.put(
    key,
    JSON.stringify({
      messageId: message.id,
      type: eventType,
      attempts: message.attempts,
      error: error instanceof Error ? error.message : String(error),
      body: redactQueueBodyForDeadLetter(message.body),
      failedAt: new Date().toISOString(),
    }),
    { expirationTtl: DEAD_LETTER_TTL_SECONDS },
  );
}

export async function handleQueueBatch(
  batch: MessageBatch,
  env: Env,
  ctx: ExecutionContext,
) {
  const pageviewBatch: {
    data: { postId: number; visitorHash: string };
    messageId: string;
    message: Message;
  }[] = [];

  for (const message of batch.messages) {
    const parsed = queueMessageSchema.safeParse(message.body);
    if (!parsed.success) {
      console.error(
        JSON.stringify({
          message: "queue invalid message",
          messageId: message.id,
          error: parsed.error.message,
          bodyKeys:
            message.body && typeof message.body === "object"
              ? Object.keys(message.body)
              : [],
        }),
      );
      message.ack();
      continue;
    }

    let eventType = "unknown";
    try {
      const event = parsed.data;
      eventType = event.type;
      switch (event.type) {
        case "EMAIL":
          await handleEmailMessage(
            {
              env,
              executionCtx: ctx,
            },
            {
              ...event.data,
              idempotencyKey: event.data.idempotencyKey ?? message.id,
            },
          );
          break;
        case "WEBHOOK":
          await handleWebhookMessage(
            { env },
            event.data,
            event.data.eventId ?? message.id,
          );
          break;
        case "POST_AUTO_SNAPSHOT":
          await handlePostAutoSnapshotMessage({ env }, event.data);
          break;
        case "SEARCH_REBUILD":
          await SearchService.rebuildIndex({
            db: getDb(env),
            env,
          });
          break;
        case "PAGEVIEW":
          pageviewBatch.push({ data: event.data, messageId: message.id, message });
          continue;
        default:
          event satisfies never;
          throw new Error("Unknown queue message type");
      }
      message.ack();
    } catch (error) {
      console.error(
        JSON.stringify({
          message: "queue processing failed",
          type: eventType,
          messageId: message.id,
          attempt: message.attempts,
          error: error instanceof Error ? error.message : "unknown error",
        }),
      );
      if (message.attempts >= MAX_QUEUE_ATTEMPTS) {
        // 没有配置 DLQ：把最后一次失败持久化到 KV，避免消息静默丢失
        try {
          await persistDeadLetter(env, message, eventType, error);
          console.error(
            JSON.stringify({
              message: "queue message moved to dead letter",
              type: eventType,
              messageId: message.id,
              attempt: message.attempts,
            }),
          );
          message.ack();
        } catch (deadLetterError) {
          console.error(
            JSON.stringify({
              message: "queue dead letter persist failed",
              type: eventType,
              messageId: message.id,
              error:
                deadLetterError instanceof Error
                  ? deadLetterError.message
                  : String(deadLetterError),
            }),
          );
          message.retry();
        }
      } else {
        message.retry();
      }
    }
  }

  if (pageviewBatch.length > 0) {
    try {
      await handlePageviewMessages(
        { env },
        pageviewBatch.map((item) => ({
          data: item.data,
          messageId: item.messageId,
        })),
      );
      for (const item of pageviewBatch) item.message.ack();
    } catch (error) {
      console.error(
        JSON.stringify({
          message: "pageview batch processing failed",
          count: pageviewBatch.length,
          error: error instanceof Error ? error.message : "unknown error",
        }),
      );
      for (const item of pageviewBatch) item.message.retry();
    }
  }
}
