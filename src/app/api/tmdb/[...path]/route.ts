import { NextRequest, NextResponse } from "next/server";
import { clientKeyFromHeaders, createRateLimiter } from "@/lib/mobile/rate-limit";

const TMDB_API_BASE = "https://api.themoviedb.org/3";
const TMDB_MIRROR_BASE = "https://db.wecollege.net/3";
const FETCH_TIMEOUT_MS = 10_000;
const MAX_PATH_LENGTH = 512;
const MAX_QUERY_LENGTH = 2048;
const MAX_QUERY_PARAMS = 32;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

const tmdbRateLimiter = createRateLimiter({
  limit: 120,
  windowMs: 60_000,
  maxKeys: 4096,
});

function getTmdbCredentials() {
  const bearer = (
    process.env.TMDB_ACCESS_TOKEN ||
    process.env.TMDB_API ||
    process.env.NEXT_PUBLIC_TMDB_ACCESS_TOKEN ||
    ""
  ).trim();
  const apiKey = (process.env.TMDB_API_KEY || "").trim();
  return { bearer, apiKey };
}

function isSafeTmdbPath(path: string): boolean {
  if (!path || path.length > MAX_PATH_LENGTH) return false;

  return path.split("/").every(
    (segment) =>
      segment.length > 0 &&
      segment !== "." &&
      segment !== ".." &&
      /^[A-Za-z0-9._~-]+$/.test(segment),
  );
}

function sanitizeSearchParams(input: URLSearchParams): URLSearchParams | null {
  const output = new URLSearchParams();
  let totalLength = 0;
  let count = 0;

  for (const [key, value] of input) {
    if (count >= MAX_QUERY_PARAMS) break;
    if (!/^[A-Za-z0-9_.]+$/.test(key)) continue;
    // Never let callers inject their own API key through the proxy.
    if (key === "api_key") continue;

    totalLength += key.length + value.length;
    if (totalLength > MAX_QUERY_LENGTH) return null;

    output.set(key, value);
    count++;
  }

  return output;
}

async function fetchFromBase(
  baseUrl: string,
  path: string,
  searchParams: URLSearchParams,
  creds: { bearer: string; apiKey: string },
) {
  const url = new URL(`${baseUrl.replace(/\/$/, "")}/${path.replace(/^\//, "")}`);
  searchParams.forEach((value, key) => {
    url.searchParams.set(key, value);
  });
  if (!creds.bearer && creds.apiKey && !url.searchParams.has("api_key")) {
    url.searchParams.set("api_key", creds.apiKey);
  }

  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (creds.bearer) {
    headers.Authorization = `Bearer ${creds.bearer}`;
  }

  return fetch(url.toString(), {
    method: "GET",
    headers,
    cache: "no-store",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
}

function proxyError(status: number, message: string, headers?: Record<string, string>) {
  return NextResponse.json(
    { error: message },
    {
      status,
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        ...headers,
      },
    },
  );
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> | { path: string[] } },
) {
  const rateLimit = tmdbRateLimiter.consume(clientKeyFromHeaders(request.headers));

  if (!rateLimit.allowed) {
    return proxyError(429, "Too many requests", {
      "Retry-After": String(rateLimit.retryAfterSeconds),
      "X-RateLimit-Limit": String(rateLimit.limit),
      "X-RateLimit-Remaining": String(rateLimit.remaining),
    });
  }

  try {
    const resolvedParams = await Promise.resolve(context.params);
    const pathSegments = resolvedParams?.path || [];
    const subPath = pathSegments.join("/");

    if (!subPath) {
      return proxyError(400, "Missing TMDB path");
    }

    if (!isSafeTmdbPath(subPath)) {
      return proxyError(400, "Invalid TMDB path");
    }

    const searchParams = sanitizeSearchParams(request.nextUrl.searchParams);

    if (!searchParams) {
      return proxyError(400, "Invalid TMDB query");
    }

    const creds = getTmdbCredentials();

    let response: Response | null = null;

    if (creds.bearer || creds.apiKey) {
      try {
        const primaryRes = await fetchFromBase(TMDB_API_BASE, subPath, searchParams, creds);
        if (primaryRes.ok) {
          response = primaryRes;
        } else if (
          primaryRes.status !== 401 &&
          primaryRes.status !== 403 &&
          primaryRes.status < 500
        ) {
          response = primaryRes;
        }
      } catch {
        // Fall through to mirror
      }
    }

    if (!response) {
      response = await fetchFromBase(TMDB_MIRROR_BASE, subPath, searchParams, creds);
    }

    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength > MAX_RESPONSE_BYTES) {
      return proxyError(502, "TMDB response too large");
    }

    const body = await response.text();
    if (body.length > MAX_RESPONSE_BYTES) {
      return proxyError(502, "TMDB response too large");
    }

    return new NextResponse(body, {
      status: response.status,
      headers: {
        "Content-Type": response.headers.get("content-type") || "application/json",
        "Cache-Control": response.ok
          ? "public, s-maxage=600, stale-while-revalidate=3600"
          : "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    console.error("[TMDB Proxy] Request failed:", error);
    return proxyError(502, "TMDB proxy request failed");
  }
}
