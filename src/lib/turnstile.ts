const TURNSTILE_VERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const TURNSTILE_VERIFY_TIMEOUT_MS = 5000;

export interface TurnstileResult {
  success: boolean;
  "error-codes"?: Array<string>;
  challenge_ts?: string;
  hostname?: string;
  action?: string;
}

export async function verifyTurnstileToken({
  secretKey,
  token,
  expectedAction,
  expectedHostname,
}: {
  secretKey: string;
  token: string;
  /** 期望的 widget action（例如登录页用 "login"），不传则不校验 */
  expectedAction?: string;
  /** 期望的 widget hostname（例如站点域名），不传则不校验 */
  expectedHostname?: string;
}): Promise<TurnstileResult> {
  try {
    const res = await fetch(TURNSTILE_VERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        secret: secretKey,
        response: token,
      }),
      signal: AbortSignal.timeout(TURNSTILE_VERIFY_TIMEOUT_MS),
    });

    const result = (await res.json()) as TurnstileResult;

    if (!result.success) {
      console.error(
        JSON.stringify({
          message: "turnstile verification failed",
          errorCodes: result["error-codes"],
          action: result.action,
        }),
      );
      return result;
    }

    if (
      expectedHostname &&
      result.hostname?.toLowerCase() !== expectedHostname.toLowerCase()
    ) {
      console.error(
        JSON.stringify({
          message: "turnstile hostname mismatch",
          expectedHostname,
          actualHostname: result.hostname,
        }),
      );
      return { ...result, success: false, "error-codes": ["hostname-mismatch"] };
    }

    if (expectedAction && result.action !== expectedAction) {
      console.error(
        JSON.stringify({
          message: "turnstile action mismatch",
          expectedAction,
          actualAction: result.action,
        }),
      );
      return { ...result, success: false, "error-codes": ["action-mismatch"] };
    }

    return result;
  } catch (error) {
    console.error(
      JSON.stringify({
        message: "turnstile verification request failed",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return { success: false, "error-codes": ["verification-request-failed"] };
  }
}
