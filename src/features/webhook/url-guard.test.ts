import { afterEach, describe, expect, it, vi } from "vitest";
import { assertPublicWebhookTarget, isPrivateIp } from "./url-guard";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("webhook URL guard", () => {
  it("detects private IPv4/IPv6 addresses", () => {
    expect(isPrivateIp("127.0.0.1")).toBe(true);
    expect(isPrivateIp("10.1.2.3")).toBe(true);
    expect(isPrivateIp("192.168.1.1")).toBe(true);
    expect(isPrivateIp("172.20.0.1")).toBe(true);
    expect(isPrivateIp("169.254.169.254")).toBe(true);
    expect(isPrivateIp("::1")).toBe(true);
    expect(isPrivateIp("fd00::1")).toBe(true);
    expect(isPrivateIp("fe80::1")).toBe(true);
    expect(isPrivateIp("8.8.8.8")).toBe(false);
    expect(isPrivateIp("2606:4700:4700::1111")).toBe(false);
  });

  it("rejects private IP literals without DNS lookup", async () => {
    await expect(
      assertPublicWebhookTarget("https://127.0.0.1/hook"),
    ).rejects.toThrow("private IP");
  });

  it("rejects hostnames resolving to private addresses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        const isAaaa = input.includes("type=AAAA");
        return new Response(
          JSON.stringify({
            Answer: isAaaa
              ? []
              : [{ type: 1, data: "10.0.0.5" }],
          }),
        );
      }),
    );

    await expect(
      assertPublicWebhookTarget("https://internal.example.com/hook"),
    ).rejects.toThrow("private IP");
  });

  it("allows hostnames resolving only to public addresses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        const isAaaa = input.includes("type=AAAA");
        return new Response(
          JSON.stringify({
            Answer: isAaaa
              ? [{ type: 28, data: "2606:4700:4700::1111" }]
              : [{ type: 1, data: "93.184.216.34" }],
          }),
        );
      }),
    );

    await expect(
      assertPublicWebhookTarget("https://example.com/hook"),
    ).resolves.toBeUndefined();
  });
});
