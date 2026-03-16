import type { NextRequest } from "next/server";

const DEFAULT_BACKEND_URL = "https://7wikiapi.skylarenns.com";
const BODYLESS_METHODS = new Set(["GET", "HEAD"]);
const SEARCH_RATE_LIMIT_MS = 1000;
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);
const searchRequestTimestamps = new Map<string, number>();

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

function backendBaseUrl(): string {
  return (process.env.WIKI_BACKEND_URL ?? process.env.NEXT_PUBLIC_WIKI_BACKEND_URL ?? DEFAULT_BACKEND_URL).replace(
    /\/+$/,
    ""
  );
}

function buildUpstreamUrl(pathSegments: string[] = [], search: string): string {
  const pathname = pathSegments.join("/");
  return `${backendBaseUrl()}/api/${pathname}${search}`;
}

function copyRequestHeaders(request: NextRequest): Headers {
  const headers = new Headers();

  for (const [key, value] of request.headers.entries()) {
    if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
      headers.set(key, value);
    }
  }

  return headers;
}

function isSearchPath(pathSegments: string[] = []): boolean {
  const joined = pathSegments.join("/");
  return joined === "path" || joined === "path/stream" || joined === "paths";
}

function extractClientIp(request: NextRequest): string {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) {
    return forwardedFor.split(",")[0]?.trim() ?? "unknown";
  }

  return (
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-real-ip") ??
    "unknown"
  );
}

function pruneRateLimitEntries(now: number): void {
  if (searchRequestTimestamps.size < 2048) {
    return;
  }

  for (const [key, timestamp] of searchRequestTimestamps.entries()) {
    if (now - timestamp > SEARCH_RATE_LIMIT_MS * 5) {
      searchRequestTimestamps.delete(key);
    }
  }
}

function checkSearchRateLimit(request: NextRequest, pathSegments: string[] = []): Response | null {
  if (!isSearchPath(pathSegments)) {
    return null;
  }

  const now = Date.now();
  pruneRateLimitEntries(now);
  const clientIp = extractClientIp(request);
  const lastRequestAt = searchRequestTimestamps.get(clientIp) ?? 0;
  const remainingMs = SEARCH_RATE_LIMIT_MS - (now - lastRequestAt);

  if (remainingMs > 0) {
    return Response.json(
      {
        error: "rate_limited",
        message: `Rate limit: one search per second per IP. Try again in ${Math.ceil(remainingMs)}ms.`,
        retryAfterMs: Math.ceil(remainingMs)
      },
      {
        status: 429,
        headers: {
          "Retry-After": "1"
        }
      }
    );
  }

  searchRequestTimestamps.set(clientIp, now);
  return null;
}

async function proxyRequest(request: NextRequest, pathSegments: string[] = []): Promise<Response> {
  const body = BODYLESS_METHODS.has(request.method) ? undefined : await request.arrayBuffer();
  const init: RequestInit = {
    method: request.method,
    headers: copyRequestHeaders(request),
    body: body && body.byteLength > 0 ? body : undefined,
    redirect: "manual",
    cache: "no-store"
  };

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(buildUpstreamUrl(pathSegments, request.nextUrl.search), init);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Upstream request failed.";
    return Response.json(
      {
        error: "upstream_fetch_failed",
        message
      },
      { status: 502 }
    );
  }

  const headers = new Headers();
  for (const [key, value] of upstreamResponse.headers.entries()) {
    if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
      headers.set(key, value);
    }
  }

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers
  });
}

type RouteContext = {
  params: Promise<{
    path?: string[];
  }>;
};

async function handle(request: NextRequest, context: RouteContext): Promise<Response> {
  const { path = [] } = await context.params;
  const rateLimited = checkSearchRateLimit(request, path);
  if (rateLimited) {
    return rateLimited;
  }
  return proxyRequest(request, path);
}

export { handle as GET, handle as POST, handle as PUT, handle as PATCH, handle as DELETE, handle as HEAD, handle as OPTIONS };
