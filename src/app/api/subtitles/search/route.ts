import { NextRequest, NextResponse } from 'next/server';
import { clientKeyFromHeaders, createRateLimiter } from '@/lib/mobile/rate-limit';

const MAX_QUERY_LENGTH = 200;
const MAX_RESULTS = 50;
const FETCH_TIMEOUT_MS = 8_000;

const searchRateLimiter = createRateLimiter({
  limit: 30,
  windowMs: 60_000,
  maxKeys: 2048,
});

function normalizeImdbId(value: string): string | null {
  const cleaned = value.trim().replace(/^tt/i, '');
  return /^\d{1,10}$/.test(cleaned) ? cleaned : null;
}

function normalizeNumericParam(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return /^\d{1,4}$/.test(trimmed) ? trimmed : null;
}

function normalizeLanguage(value: string): string | null {
  const trimmed = value.trim().toLowerCase();
  return /^[a-z]{2,3}(,[a-z]{2,3})*$/.test(trimmed) ? trimmed : null;
}

function errorResponse(status: number, message: string, headers?: Record<string, string>) {
  return NextResponse.json(
    { success: false, results: [], message },
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
  const rateLimit = searchRateLimiter.consume(clientKeyFromHeaders(request.headers));

  if (!rateLimit.allowed) {
    return errorResponse(429, 'Too many subtitle searches. Please try again shortly.', {
      'Retry-After': String(rateLimit.retryAfterSeconds),
      'X-RateLimit-Limit': String(rateLimit.limit),
      'X-RateLimit-Remaining': String(rateLimit.remaining),
    });
  }

  const { searchParams } = new URL(request.url);
  const query = (searchParams.get('query') || '').trim().slice(0, MAX_QUERY_LENGTH);
  const rawImdbId = (searchParams.get('imdbId') || '').trim();
  const season = normalizeNumericParam(searchParams.get('season'));
  const episode = normalizeNumericParam(searchParams.get('episode'));
  const subLanguageId = normalizeLanguage(searchParams.get('lang') || '');

  if (!query && !rawImdbId) {
    return errorResponse(400, 'Missing query or imdbId');
  }

  const imdbId = rawImdbId ? normalizeImdbId(rawImdbId) : null;

  if (rawImdbId && !imdbId) {
    return errorResponse(400, 'Invalid imdbId');
  }

  try {
    let endpoint = 'https://rest.opensubtitles.org/search';

    if (episode) endpoint += `/episode-${episode}`;

    if (imdbId) {
      endpoint += `/imdbid-${imdbId}`;
    } else if (query) {
      endpoint += `/query-${encodeURIComponent(query.toLowerCase())}`;
    }

    if (season) endpoint += `/season-${season}`;
    if (subLanguageId) endpoint += `/sublanguageid-${subLanguageId}`;

    const response = await fetch(endpoint, {
      headers: {
        'x-user-agent': 'VLSub 0.10.2',
        'User-Agent': 'VLSub 0.10.2',
      },
      cache: 'no-store',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      return errorResponse(502, 'Subtitle search is unavailable');
    }

    const data = await response.json();
    if (!Array.isArray(data)) {
      return NextResponse.json({ success: true, count: 0, results: [] });
    }

    const results = data.slice(0, MAX_RESULTS).map((item: any) => ({
      id: item.IDSubtitleFile || item.IDSubtitle,
      title: item.SubFileName || item.MovieReleaseName || item.LanguageName,
      language: item.LanguageName || item.SubLanguageID,
      langCode: item.SubLanguageID,
      downloadUrl: item.SubDownloadLink,
      rating: item.SubRating,
      downloadsCount: item.SubDownloadsCnt,
    }));

    return NextResponse.json({
      success: true,
      count: results.length,
      results,
    });
  } catch (error) {
    console.error('[Subtitle Search] Error:', error);
    return errorResponse(502, 'Subtitle search is unavailable');
  }
}
