const PRIVATE_IPV4_PATTERNS = [
  /^0\./,
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
];

function normalizeHostname(hostname: string) {
  return hostname.toLowerCase().replace(/^\[|\]$/g, "");
}

export function isPrivateIp(value: string): boolean {
  const ip = normalizeHostname(value);
  if (PRIVATE_IPV4_PATTERNS.some((pattern) => pattern.test(ip))) return true;
  if (ip === "::1" || ip === "::") return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(ip)) return true; // IPv6 ULA fc00::/7
  if (/^fe[89ab][0-9a-f]:/i.test(ip)) return true; // IPv6 link-local fe80::/10
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return isPrivateIp(mapped[1]);
  return false;
}

type DohAnswer = { type?: number; data?: string };

async function resolveWithDoh(hostname: string, type: "A" | "AAAA") {
  const response = await fetch(
    `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=${type}`,
    {
      headers: { accept: "application/dns-json" },
      signal: AbortSignal.timeout(3000),
    },
  );
  if (!response.ok) {
    throw new Error(`DNS lookup failed with status ${response.status}`);
  }
  const body = (await response.json()) as { Answer?: Array<DohAnswer> };
  return (body.Answer ?? [])
    .filter((answer) => answer.type === (type === "A" ? 1 : 28))
    .map((answer) => answer.data)
    .filter((data): data is string => typeof data === "string");
}

/**
 * 发送前解析 Webhook 域名并拒绝私网 IP，降低 SSRF 风险。
 * 注意：DNS rebinding 仍无法由单次解析完全消除，Cloudflare 侧严格公网 fetch 仍是最终防线。
 */
export async function assertPublicWebhookTarget(url: string): Promise<void> {
  const parsed = new URL(url);
  const hostname = normalizeHostname(parsed.hostname);

  // IP 字面量直接检查，不再查询
  if (hostname.includes(":") || /^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
    if (isPrivateIp(hostname)) {
      throw new Error("Webhook URL resolves to a private IP");
    }
    return;
  }

  const ipv4 = await resolveWithDoh(hostname, "A");
  const ipv6 = await resolveWithDoh(hostname, "AAAA");
  const addresses = [...ipv4, ...ipv6];

  if (addresses.length === 0) {
    throw new Error("Webhook host could not be resolved");
  }
  if (addresses.some((address) => isPrivateIp(address))) {
    throw new Error("Webhook URL resolves to a private IP");
  }
}
