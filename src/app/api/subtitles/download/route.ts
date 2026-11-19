import { NextRequest, NextResponse } from 'next/server';
import zlib from 'zlib';
import { clientKeyFromHeaders, createRateLimiter } from '@/lib/mobile/rate-limit';

const MAX_URL_LENGTH = 4096;
const MAX_HEADERS_LENGTH = 8192;
const MAX_DOWNLOAD_BYTES = 4 * 1024 * 1024;
const MAX_DECOMPRESSED_BYTES = 6 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const FETCH_TIMEOUT_MS = 10_000;

// Only these request headers are forwarded. Arbitrary headers let callers abuse
// the route as a credentialed proxy for third-party services.
const ALLOWED_HEADERS = new Set([
  'accept',
  'accept-language',
  'cookie',
  'origin',
  'referer',
  'user-agent',
]);

const BLOCKED_HOST_SUFFIXES = ['.local', '.localhost', '.internal', '.lan', '.home', '.corp'];

// Public wildcard-DNS services that resolve arbitrary subdomains to loopback
// or private addresses (e.g. 127.0.0.1.nip.io).
const BLOCKED_REBIND_SUFFIXES = [
  '.nip.io',
  '.sslip.io',
  '.xip.io',
  '.localtest.me',
  '.lvh.me',
  '.vcap.me',
  '.traefik.me',
];

const downloadRateLimiter = createRateLimiter({
  limit: 40,
  windowMs: 60_000,
  maxKeys: 2048,
});

class ProxyError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split('.');
  if (parts.length !== 4) return false;
  if (!parts.every((part) => /^\d{1,3}$/.test(part))) return false;

  const octets = parts.map(Number);
  if (octets.some((octet) => octet > 255)) return false;

  const [a, b] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isBlockedHostname(rawHostname: string): boolean {
  const hostname = rawHostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');

  if (!hostname) return true;
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true;
  if (BLOCKED_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) return true;
  if (BLOCKED_REBIND_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) return true;

  if (hostname.includes(':')) {
    if (hostname === '::' || hostname === '::1') return true;
    if (hostname.startsWith('::ffff:')) return true;
    // fc00::/7 unique-local and fe80::/10 link-local ranges.
    if (/^f[cd]/.test(hostname) || /^fe[89ab]/.test(hostname)) return true;
    return false;
  }

  return isPrivateIpv4(hostname);
}

function parseTargetUrl(rawUrl: string): URL {
  if (!rawUrl || rawUrl.length > MAX_URL_LENGTH) {
    throw new ProxyError(400, 'Invalid subtitle url');
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new ProxyError(400, 'Invalid subtitle url');
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new ProxyError(400, 'Unsupported subtitle url protocol');
  }
  if (parsed.username || parsed.password) {
    throw new ProxyError(400, 'Invalid subtitle url');
  }
  if (parsed.port && parsed.port !== '80' && parsed.port !== '443') {
    throw new ProxyError(400, 'Unsupported subtitle url port');
  }
  if (isBlockedHostname(parsed.hostname)) {
    throw new ProxyError(400, 'Invalid subtitle url host');
  }

  return parsed;
}

function parseCustomHeaders(headersParam: string | null): Record<string, string> {
  if (!headersParam) return {};
  if (headersParam.length > MAX_HEADERS_LENGTH) {
    throw new ProxyError(400, 'Subtitle headers too large');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(headersParam);
  } catch {
    return {};
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed)) {
    const normalizedName = name.toLowerCase();
    if (!ALLOWED_HEADERS.has(normalizedName)) continue;
    if (typeof value !== 'string') continue;
    if (value.length > 1024 || /[\r\n\0]/.test(value)) continue;
    headers[normalizedName] = value;
  }

  return headers;
}

function buildFetchHeaders(target: URL, customHeaders: Record<string, string>) {
  const isOpenSubtitles =
    target.hostname === 'opensubtitles.org' || target.hostname.endsWith('.opensubtitles.org');

  const headers: Record<string, string> = { ...customHeaders };

  if (!headers['user-agent']) {
    headers['user-agent'] = isOpenSubtitles
      ? 'VLSub 0.10.2'
      : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
  }
  if (!headers.accept) {
    headers.accept = '*/*';
  }
  if (isOpenSubtitles && !headers['x-user-agent']) {
    headers['x-user-agent'] = 'VLSub 0.10.2';
  }

  return headers;
}

async function fetchWithSafeRedirects(target: URL, headers: Record<string, string>) {
  let currentUrl = target;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const validatedUrl = parseTargetUrl(currentUrl.toString());

    const response = await fetch(validatedUrl.toString(), {
      headers,
      redirect: 'manual',
      cache: 'no-store',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) {
        throw new ProxyError(502, 'Subtitle server returned an invalid redirect');
      }

      try {
        currentUrl = new URL(location, validatedUrl);
      } catch {
        throw new ProxyError(502, 'Subtitle server returned an invalid redirect');
      }
      continue;
    }

    return response;
  }

  throw new ProxyError(502, 'Too many subtitle redirects');
}

function getVpsFallbackUrl(target: URL): string | null {
  const hostname = target.hostname.toLowerCase();

  if (hostname === 'vidrift.net' || hostname.endsWith('.vidrift.net')) {
    return `https://vidrift.snapflix.indevs.in/api/proxy/stream?v=2&url=${encodeURIComponent(target.toString())}`;
  }

  if (hostname.includes('vidly')) {
    return `https://vidly.snapflix.indevs.in/api/proxy/stream?v=2&url=${encodeURIComponent(target.toString())}`;
  }

  return null;
}

async function readBodyWithLimit(response: Response, maxBytes: number): Promise<Buffer> {
  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength > maxBytes) {
    throw new ProxyError(413, 'Subtitle file is too large');
  }

  if (!response.body) return Buffer.alloc(0);

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      throw new ProxyError(413, 'Subtitle file is too large');
    }

    chunks.push(Buffer.from(value));
  }

  return Buffer.concat(chunks);
}

function decodeSubtitleBuffer(buffer: Buffer): string {
  let text = '';

  if (buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
    try {
      text = zlib
        .gunzipSync(buffer, { maxOutputLength: MAX_DECOMPRESSED_BYTES })
        .toString('utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ERR_BUFFER_TOO_LARGE') {
        throw new ProxyError(413, 'Subtitle file is too large');
      }
      text = buffer.toString('utf-8');
    }
  } else {
    text = buffer.toString('utf-8');
  }

  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }

  text = text.trim();

  if (!text.startsWith('WEBVTT')) {
    text =
      'WEBVTT\n\n' +
      text.replace(/\r\n|\r/g, '\n').replace(/(\d{1,2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  }

  // Remove embedded cue positioning so the player controls subtitle layout.
  return text.replace(
    /((?:\d{1,2}:)?\d{2}:\d{2}\.\d{3}\s+-->\s+(?:\d{1,2}:)?\d{2}:\d{2}\.\d{3})([^\r\n]*)/g,
    (_match, timing, settings) => {
      const cleanSettings = (settings || '')
        .replace(/\bline:\S+/g, '')
        .replace(/\bposition:\S+/g, '')
        .replace(/\balign:\S+/g, '')
        .replace(/\bsize:\S+/g, '')
        .trim();
      return `${timing}${cleanSettings ? ' ' + cleanSettings : ''}`.trim();
    },
  );
}

function errorResponse(status: number, message: string, headers?: Record<string, string>) {
  return NextResponse.json(
    { error: message },
    {
      status,
      headers: {
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        ...headers,
      },
    },
  );
}

export async function GET(request: NextRequest) {
  const rateLimit = downloadRateLimiter.consume(clientKeyFromHeaders(request.headers));

  if (!rateLimit.allowed) {
    return errorResponse(429, 'Too many subtitle downloads. Please try again shortly.', {
      'Retry-After': String(rateLimit.retryAfterSeconds),
      'X-RateLimit-Limit': String(rateLimit.limit),
      'X-RateLimit-Remaining': String(rateLimit.remaining),
    });
  }

  const { searchParams } = new URL(request.url);
  const rawUrl = searchParams.get('url');

  if (!rawUrl) {
    return errorResponse(400, 'Missing url parameter');
  }

  try {
    const targetUrl = parseTargetUrl(rawUrl);
    const customHeaders = parseCustomHeaders(searchParams.get('headers'));
    const fetchHeaders = buildFetchHeaders(targetUrl, customHeaders);

    let response: Response | null = null;

    try {
      response = await fetchWithSafeRedirects(targetUrl, fetchHeaders);
    } catch (error) {
      if (error instanceof ProxyError) throw error;
      console.warn('[Subtitle Download] Direct fetch error:', error);
    }

    if (!response || !response.ok) {
      // Some stream CDNs block Cloudflare egress; retry through our own VPS
      // proxy, but only for the stream hosts that proxy exists for.
      const fallbackUrl = getVpsFallbackUrl(targetUrl);

      if (fallbackUrl) {
        try {
          const fallbackResponse = await fetch(fallbackUrl, {
            headers: {
              'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
              Accept: '*/*',
            },
            cache: 'no-store',
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          });

          if (fallbackResponse.ok) {
            response = fallbackResponse;
          }
        } catch (fallbackError) {
          console.warn('[Subtitle Download] VPS proxy fallback error:', fallbackError);
        }
      }
    }

    if (!response) {
      return errorResponse(502, 'Subtitle download failed');
    }

    if (!response.ok) {
      return errorResponse(502, `Subtitle download failed (upstream ${response.status})`);
    }

    const buffer = await readBodyWithLimit(response, MAX_DOWNLOAD_BYTES);
    const text = decodeSubtitleBuffer(buffer);

    return new NextResponse(text, {
      status: 200,
      headers: {
        'Content-Type': 'text/vtt; charset=utf-8',
        // Keep arbitrary proxied content out of the shared edge cache.
        'Cache-Control': 'private, max-age=3600',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    if (error instanceof ProxyError) {
      return errorResponse(error.status, error.message);
    }

    console.error('[Subtitle Download] Error:', error);
    return errorResponse(502, 'Subtitle download failed');
  }
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
    },
  });
}
