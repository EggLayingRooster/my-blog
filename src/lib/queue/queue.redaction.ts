function maskEmail(value: string): string {
  const [local, domain] = value.split("@");
  if (!domain) return "***";
  const visible = local.slice(0, 1);
  return `${visible}***@${domain}`;
}

/**
 * 死信只用于排障，不应保留邮件正文/Webhook secret/访客哈希等敏感数据。
 * 保留 type/关键 id/错误上下文，正文与凭据做脱敏。
 */
export function redactQueueBodyForDeadLetter(body: unknown): unknown {
  if (!body || typeof body !== "object") return body;

  const copy = JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
  const data =
    copy.data && typeof copy.data === "object"
      ? (copy.data as Record<string, unknown>)
      : null;

  switch (copy.type) {
    case "EMAIL":
      if (data) {
        if (typeof data.to === "string") data.to = maskEmail(data.to);
        if (typeof data.html === "string") {
          data.html = `[redacted ${data.html.length} chars]`;
        }
        delete data.unsubscribe;
      }
      break;
    case "WEBHOOK":
      if (data) {
        data.secret = "[redacted]";
      }
      break;
    case "PAGEVIEW":
      if (data) {
        data.visitorHash = "[redacted]";
      }
      break;
    default:
      break;
  }

  return copy;
}
