import { describe, expect, it } from "vitest";
import { redactQueueBodyForDeadLetter } from "./queue.redaction";

describe("queue dead-letter redaction", () => {
  it("redacts email recipients, html and unsubscribe tokens", () => {
    const redacted = redactQueueBodyForDeadLetter({
      type: "EMAIL",
      data: {
        to: "alice@example.com",
        subject: "Hi",
        html: "<p>secret content</p>",
        unsubscribe: { userId: "u1", type: "reply_notification" },
      },
    }) as {
      data: { to: string; html: string; unsubscribe?: unknown };
    };

    expect(redacted.data.to).toBe("a***@example.com");
    expect(redacted.data.html).toMatch(/^\[redacted \d+ chars\]$/);
    expect(redacted.data.unsubscribe).toBeUndefined();
  });

  it("redacts webhook secrets and pageview hashes", () => {
    const webhook = redactQueueBodyForDeadLetter({
      type: "WEBHOOK",
      data: { secret: "super-secret", url: "https://example.com" },
    }) as { data: { secret: string } };
    expect(webhook.data.secret).toBe("[redacted]");

    const pageview = redactQueueBodyForDeadLetter({
      type: "PAGEVIEW",
      data: { postId: 1, visitorHash: "visitor-hash" },
    }) as { data: { visitorHash: string } };
    expect(pageview.data.visitorHash).toBe("[redacted]");
  });
});
