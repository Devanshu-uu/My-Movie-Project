const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const VERIFY_TIMEOUT_MS = 5_000;

export type CaptchaVerification = {
  enforced: boolean;
  ok: boolean;
  message?: string;
};

function getTurnstileSecret(): string {
  return (process.env.TURNSTILE_SECRET_KEY || process.env.CAPTCHA_SECRET_KEY || "").trim();
}

/**
 * Verifies a Cloudflare Turnstile token server-side. The token must never be
 * trusted as proof on its own; it can be forged by any client.
 */
export async function verifyTurnstileToken(
  token: string | undefined,
  remoteIp?: string,
): Promise<CaptchaVerification> {
  const secret = getTurnstileSecret();

  if (!secret) {
    const siteKey = (process.env.NEXT_PUBLIC_CAPTCHA_SITE_KEY || "").trim();

    if (siteKey && siteKey !== "dummy-captcha-key") {
      console.error(
        "[Captcha] NEXT_PUBLIC_CAPTCHA_SITE_KEY is configured but TURNSTILE_SECRET_KEY is missing. Sign-up captcha is NOT enforced.",
      );
    }

    return { enforced: false, ok: true };
  }

  if (!token || token.length < 10 || token.length > 4096) {
    return {
      enforced: true,
      ok: false,
      message: "Captcha verification is required. Please complete the challenge and try again.",
    };
  }

  try {
    const body = new URLSearchParams({ secret, response: token });
    if (remoteIp && remoteIp !== "unknown") {
      body.set("remoteip", remoteIp);
    }

    const response = await fetch(TURNSTILE_VERIFY_URL, {
      method: "POST",
      body,
      cache: "no-store",
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });

    if (!response.ok) {
      return {
        enforced: true,
        ok: false,
        message: "Captcha verification failed. Please try again.",
      };
    }

    const result = (await response.json()) as { success?: boolean };

    if (result.success === true) {
      return { enforced: true, ok: true };
    }

    return {
      enforced: true,
      ok: false,
      message: "Captcha verification failed. Please try again.",
    };
  } catch (error) {
    console.error("[Captcha] Turnstile verification error:", error);
    return {
      enforced: true,
      ok: false,
      message: "Captcha verification is unavailable. Please try again in a moment.",
    };
  }
}
