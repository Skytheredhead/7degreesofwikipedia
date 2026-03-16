import Fastify from "fastify";
import cors from "@fastify/cors";
import { randomUUID } from "node:crypto";

import { appConfig } from "../config.js";
import { WikiService } from "../services/wikiService.js";

const SEARCH_RATE_LIMIT_MS = 1000;
const searchRequestTimestamps = new Map<string, number>();

function extractClientIp(headers: Record<string, unknown>): string {
  const forwardedFor = typeof headers["x-forwarded-for"] === "string" ? headers["x-forwarded-for"] : "";
  if (forwardedFor) {
    return forwardedFor.split(",")[0]?.trim() ?? "unknown";
  }

  const connectingIp = typeof headers["cf-connecting-ip"] === "string" ? headers["cf-connecting-ip"] : "";
  if (connectingIp) {
    return connectingIp;
  }

  const realIp = typeof headers["x-real-ip"] === "string" ? headers["x-real-ip"] : "";
  return realIp || "unknown";
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

async function main(): Promise<void> {
  const wiki = await WikiService.bootstrap();
  const app = Fastify({
    logger: true
  });

  await app.register(cors, {
    origin: true
  });

  app.setErrorHandler((error, request, reply) => {
    const message = error instanceof Error ? error.message : "Unknown server error.";

    if (message.startsWith("Runtime artifact not ready.")) {
      return reply.status(503).send({
        error: "runtime_not_ready",
        message,
        readiness: wiki.readiness()
      });
    }

    request.log.error(error);
    return reply.status(500).send({
      error: "internal_error",
      message
    });
  });

  app.get("/health", async () => ({
    ok: wiki.isReady(),
    status: wiki.readiness()
  }));

  app.get("/api/status", async () => wiki.status());
  app.get("/api/readiness", async () => wiki.readiness());

  app.get("/api/articles/resolve", async (request, reply) => {
    const title = (request.query as { title?: string }).title;
    if (!title) {
      return reply.status(400).send({ error: "Missing title query parameter." });
    }

    return wiki.resolveTitle(title);
  });

  app.get("/api/articles/suggest", async (request, reply) => {
    const { q, limit } = request.query as { q?: string; limit?: string };
    if (!q) {
      return reply.status(400).send({ error: "Missing q query parameter." });
    }

    return wiki.suggestTitles(q, limit ? Number(limit) : undefined);
  });

  app.get("/api/paths", async (request, reply) => {
    const now = Date.now();
    pruneRateLimitEntries(now);
    const clientIp = extractClientIp(request.headers as Record<string, unknown>);
    const remainingMs = SEARCH_RATE_LIMIT_MS - (now - (searchRequestTimestamps.get(clientIp) ?? 0));
    if (remainingMs > 0) {
      reply.header("Retry-After", "1");
      return reply.status(429).send({
        error: "rate_limited",
        message: `Rate limit: one search per second per IP. Try again in ${Math.ceil(remainingMs)}ms.`,
        retryAfterMs: Math.ceil(remainingMs)
      });
    }
    searchRequestTimestamps.set(clientIp, now);

    const { from, to } = request.query as { from?: string; to?: string };
    if (!from || !to) {
      return reply.status(400).send({ error: "Missing from or to query parameter." });
    }

    return wiki.searchPath(from, to);
  });

  app.post("/api/path", async (request, reply) => {
    const now = Date.now();
    pruneRateLimitEntries(now);
    const clientIp = extractClientIp(request.headers as Record<string, unknown>);
    const remainingMs = SEARCH_RATE_LIMIT_MS - (now - (searchRequestTimestamps.get(clientIp) ?? 0));
    if (remainingMs > 0) {
      reply.header("Retry-After", "1");
      return reply.status(429).send({
        error: "rate_limited",
        message: `Rate limit: one search per second per IP. Try again in ${Math.ceil(remainingMs)}ms.`,
        retryAfterMs: Math.ceil(remainingMs)
      });
    }
    searchRequestTimestamps.set(clientIp, now);

    const body = request.body as { from?: string; to?: string; start?: string; end?: string } | null;
    const from = body?.from ?? body?.start;
    const to = body?.to ?? body?.end;
    if (!from || !to) {
      return reply.status(400).send({ error: "Missing from/start or to/end in request body." });
    }

    return wiki.searchPath(from, to);
  });

  app.post("/api/path/stream", async (request, reply) => {
    const now = Date.now();
    pruneRateLimitEntries(now);
    const clientIp = extractClientIp(request.headers as Record<string, unknown>);
    const remainingMs = SEARCH_RATE_LIMIT_MS - (now - (searchRequestTimestamps.get(clientIp) ?? 0));
    if (remainingMs > 0) {
      reply.header("Retry-After", "1");
      return reply.status(429).send({
        error: "rate_limited",
        message: `Rate limit: one search per second per IP. Try again in ${Math.ceil(remainingMs)}ms.`,
        retryAfterMs: Math.ceil(remainingMs)
      });
    }
    searchRequestTimestamps.set(clientIp, now);

    const body = request.body as { from?: string; to?: string; start?: string; end?: string } | null;
    const from = body?.from ?? body?.start;
    const to = body?.to ?? body?.end;
    if (!from || !to) {
      return reply.status(400).send({ error: "Missing from/start or to/end in request body." });
    }

    reply.hijack();
    const origin = typeof request.headers.origin === "string" ? request.headers.origin : "*";
    reply.raw.writeHead(200, {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      Vary: "Origin",
      "Access-Control-Allow-Origin": origin
    });

    try {
      await wiki.searchPathProgressive(from, to, async (event) => {
        reply.raw.write(`${JSON.stringify(event)}\n`);
        if (typeof reply.raw.flushHeaders === "function") {
          reply.raw.flushHeaders();
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
      });
    } catch (error) {
      request.log.error(error);
      reply.raw.write(
        `${JSON.stringify({
          type: "result",
          response: {
              searchId: randomUUID(),
            searchedAt: new Date().toISOString(),
            stage: "complete",
            partial: false,
            request: { from, to },
            resolution: {
              from: { query: from, found: false, result: null },
              to: { query: to, found: false, result: null },
              redirectsApplied: false
            },
            found: false,
            success: false,
            failureReason: "no_path",
            cached: false,
            routes: null,
            totalRoutesFound: null,
            displayedRoutes: 0,
            pathLength: null,
            pathNodeIds: null,
            pathTitles: null,
            pathNodes: null,
            metrics: {
              durationMs: 0,
              resolutionMs: 0,
              bfsMs: 0,
              routeEnumerationMs: 0,
              totalRequestMs: 0,
              firstRouteMs: 0,
              lastRouteMs: 0,
              nodesVisited: 0,
              nodesExpanded: 0,
              frontierExpansions: 0,
              forwardVisited: 0,
              reverseVisited: 0
            }
          }
        })}\n`
      );
    } finally {
      reply.raw.end();
    }
  });

  app.get("/api/stats/session", async () => wiki.statsSummary("session"));
  app.get("/api/stats/lifetime", async () => wiki.statsSummary("lifetime"));
  app.get("/api/stats", async () => wiki.statsOverview());
  app.get("/api/stats/overview", async () => wiki.statsOverview());
  app.get("/api/stats/recent", async (request) => {
    const { limit } = request.query as { limit?: string };
    return wiki.recentSearches(limit ? Number(limit) : undefined);
  });
  app.get("/api/stats/performance", async (request) => {
    const { scope } = request.query as { scope?: "session" | "lifetime" };
    return wiki.performanceSummary(scope ?? "lifetime");
  });
  app.get("/api/stats/top-searches", async () => wiki.topSearches());
  app.get("/api/stats/connectors", async () => wiki.topConnectors());
  app.get("/api/stats/leaderboard", async () => wiki.leaderboard());

  await app.listen({
    host: appConfig.defaultHost,
    port: appConfig.defaultPort
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
