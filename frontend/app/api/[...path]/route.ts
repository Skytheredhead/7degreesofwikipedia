import type { NextRequest } from "next/server";

const DEFAULT_BACKEND_URL = "https://7wikiapi.skylarenns.com";
const BODYLESS_METHODS = new Set(["GET", "HEAD"]);
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

async function proxyRequest(request: NextRequest, pathSegments: string[] = []): Promise<Response> {
  const init: RequestInit & { duplex?: "half" } = {
    method: request.method,
    headers: copyRequestHeaders(request),
    body: BODYLESS_METHODS.has(request.method) ? undefined : request.body,
    duplex: BODYLESS_METHODS.has(request.method) ? undefined : "half",
    redirect: "manual",
    cache: "no-store"
  };

  const upstreamResponse = await fetch(buildUpstreamUrl(pathSegments, request.nextUrl.search), init);

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
  return proxyRequest(request, path);
}

export { handle as GET, handle as POST, handle as PUT, handle as PATCH, handle as DELETE, handle as HEAD, handle as OPTIONS };
