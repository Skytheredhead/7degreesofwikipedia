import type {
  ArticleNode,
  ArticleSuggestion,
  ReadinessState,
  RecentSearch,
  ResolvedInput,
  RouteVariant,
  SearchResult,
  StatsOverview
} from "./types";

interface BackendResolvedArticle {
  query: string;
  normalizedQuery: string;
  matchedTitle: string;
  canonicalTitle: string;
  canonicalId: number;
  displayTitle: string;
  wikipediaUrl: string;
  viaRedirect: boolean;
  kind: "canonical" | "redirect";
}

interface BackendResolvedArticleResponse {
  query: string;
  found: boolean;
  result: BackendResolvedArticle | null;
}

interface BackendSuggestionResponse {
  query: string;
  limit: number;
  count: number;
  suggestions: Array<{
    title: string;
    canonicalTitle: string;
    canonicalId: number;
    displayTitle: string;
    wikipediaUrl: string;
    viaRedirect: boolean;
    kind: "canonical" | "redirect";
  }>;
}

interface BackendSearchResponse {
  searchId: string;
  searchedAt: string;
  stage: "initial" | "routes" | "complete";
  partial: boolean;
  request: {
    from: string;
    to: string;
  };
  resolution: {
    from: BackendResolvedArticleResponse;
    to: BackendResolvedArticleResponse;
    redirectsApplied: boolean;
  };
  found: boolean;
  success: boolean;
  failureReason: string | null;
  cached: boolean;
  totalRoutesFound: string | null;
  displayedRoutes: number;
  routes: Array<{
    routeIndex: number;
    pathNodeIds: number[];
    pathTitles: string[];
    pathNodes: Array<{
      articleId: number;
      canonicalTitle: string;
      displayTitle: string;
      wikipediaUrl: string;
      position: number;
      role: "start" | "intermediate" | "end";
      distanceFromStart: number;
      normalizedDistanceRatio: number;
    }>;
  }> | null;
  pathLength: number | null;
  pathNodeIds: number[] | null;
  pathTitles: string[] | null;
  pathNodes: Array<{
    articleId: number;
    canonicalTitle: string;
    displayTitle: string;
    wikipediaUrl: string;
    position: number;
    role: "start" | "intermediate" | "end";
    distanceFromStart: number;
    normalizedDistanceRatio: number;
  }> | null;
  metrics: {
    durationMs: number;
    resolutionMs: number;
    bfsMs: number;
    routeEnumerationMs: number;
    totalRequestMs: number;
    firstRouteMs: number;
    lastRouteMs: number;
    nodesVisited: number;
    nodesExpanded: number;
    frontierExpansions: number;
    forwardVisited: number;
    reverseVisited: number;
  };
}

interface BackendSearchStreamEvent {
  type: "result";
  response: BackendSearchResponse;
}

interface BackendSearchRecord {
  id: string;
  timestamp: string;
  fromQuery: string;
  toQuery: string;
  success: boolean;
  cached: boolean;
  durationMs: number;
  pathLength: number | null;
}

interface BackendStatsSummary {
  summary: {
    totals: {
      totalSearches: number;
      successfulSearches: number;
      failedSearches: number;
      averageDurationMs: number | null;
      cacheHitRate: number | null;
    };
  };
}

interface BackendStatsOverview {
  recent: BackendSearchRecord[];
  lifetime: {
    totals: {
      totalSearches: number;
      successfulSearches: number;
      failedSearches: number;
      averageDurationMs: number | null;
      cacheHitRate: number | null;
    };
    records: {
      fastest: { durationMs: number } | null;
      slowest: { durationMs: number } | null;
    };
    top: {
      connectors: Array<{ label: string; count: number }>;
      firstHops: Array<{ label: string; count: number }>;
    };
  };
}

interface BackendReadinessResponse {
  ready: boolean;
  build: {
    ready: boolean;
  };
  readiness: {
    graphLoaded: boolean;
    preloadComplete: boolean;
    searchReady: boolean;
  };
  runtime?: {
    counts?: {
      canonicalNodes?: number;
    };
  };
}

const DEFAULT_BACKEND_URL = "http://127.0.0.1:3030";

function backendBaseUrl(): string {
  return (process.env.NEXT_PUBLIC_WIKI_BACKEND_URL ?? DEFAULT_BACKEND_URL).replace(/\/+$/, "");
}

function stripNodeDisambiguation(title: string): string {
  return title.replace(/\s+\([^()]+\)$/, "").trim();
}

function toResolvedInput(payload: BackendResolvedArticleResponse): ResolvedInput {
  return {
    query: payload.query,
    found: payload.found,
    matchedTitle: payload.result?.matchedTitle ?? null,
    canonicalTitle: payload.result?.canonicalTitle ?? null,
    viaRedirect: payload.result?.viaRedirect ?? false
  };
}

function toArticleNode(
  node: NonNullable<BackendSearchResponse["pathNodes"]>[number],
  duplicateCounts: Map<string, number>
): ArticleNode {
  const simplifiedTitle = stripNodeDisambiguation(node.displayTitle);
  const displayTitle = (duplicateCounts.get(simplifiedTitle) ?? 0) > 1 ? node.displayTitle : simplifiedTitle;
  return {
    id: String(node.articleId),
    articleId: node.articleId,
    title: node.canonicalTitle,
    canonicalTitle: node.canonicalTitle,
    displayTitle,
    url: node.wikipediaUrl,
    role: node.role,
    isStart: node.role === "start",
    isEnd: node.role === "end",
    index: node.position,
    distanceFromStart: node.distanceFromStart,
    normalizedDistanceRatio: node.normalizedDistanceRatio
  };
}

function toRouteVariant(
  route: NonNullable<BackendSearchResponse["routes"]>[number],
  duplicateCounts: Map<string, number>
): RouteVariant {
  return {
    routeIndex: route.routeIndex,
    path: route.pathNodes.map((node) => toArticleNode(node, duplicateCounts))
  };
}

function buildNodeDisplayCounts(payload: BackendSearchResponse): Map<string, number> {
  const counts = new Map<string, number>();
  const allNodes = [
    ...(payload.pathNodes ?? []),
    ...(payload.routes?.flatMap((route) => route.pathNodes) ?? [])
  ];

  for (const node of allNodes) {
    const simplifiedTitle = stripNodeDisambiguation(node.displayTitle);
    counts.set(simplifiedTitle, (counts.get(simplifiedTitle) ?? 0) + 1);
  }

  return counts;
}

function toRecentSearch(record: BackendSearchRecord): RecentSearch {
  return {
    id: record.id,
    start: record.fromQuery,
    end: record.toQuery,
    pathLength: record.pathLength,
    ms: Math.round(record.durationMs),
    timestamp: new Date(record.timestamp),
    found: record.success,
    cacheHit: record.cached
  };
}

async function apiFetch<T>(pathname: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${backendBaseUrl()}${pathname}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {})
    },
    cache: "no-store"
  });

  if (!response.ok) {
    let message = `Request failed with status ${response.status}`;
    try {
      const error = (await response.json()) as { message?: string; error?: string };
      message = error.message ?? error.error ?? message;
    } catch {
      // Ignore JSON parsing errors and fall back to the generic status message.
    }
    throw new Error(message);
  }

  return (await response.json()) as T;
}

export async function fetchArticleSuggestions(query: string, limit = 6): Promise<ArticleSuggestion[]> {
  const trimmed = query.trim();
  if (trimmed.length < 2) {
    return [];
  }

  const payload = await apiFetch<BackendSuggestionResponse>(
    `/api/articles/suggest?q=${encodeURIComponent(trimmed)}&limit=${limit}`
  );

  return payload.suggestions.map((suggestion) => ({
    title: suggestion.title,
    canonicalTitle: suggestion.canonicalTitle,
    displayTitle: suggestion.displayTitle,
    wikipediaUrl: suggestion.wikipediaUrl,
    viaRedirect: suggestion.viaRedirect,
    kind: suggestion.kind
  }));
}

export async function runPathSearch(start: string, end: string): Promise<SearchResult> {
  const payload = await apiFetch<BackendSearchResponse>("/api/path", {
    method: "POST",
    body: JSON.stringify({ start, end })
  });
  return toSearchResult(payload);
}

function toSearchResult(payload: BackendSearchResponse): SearchResult {
  const duplicateCounts = buildNodeDisplayCounts(payload);

  return {
    searchId: payload.searchId,
    searchedAt: new Date(payload.searchedAt),
    partial: payload.partial,
    path: payload.pathNodes?.map((node) => toArticleNode(node, duplicateCounts)) ?? [],
    routes: payload.routes?.map((route) => toRouteVariant(route, duplicateCounts)) ?? [],
    totalRoutesFound: payload.totalRoutesFound,
    displayedRoutes: payload.displayedRoutes,
    pathLength: payload.pathLength ?? 0,
    nodesVisited: payload.metrics.nodesVisited,
    loadTimeMs: Math.round(payload.metrics.durationMs),
    cacheHit: payload.cached,
    found: payload.found,
    success: payload.success,
    failureReason: payload.failureReason,
    redirectsApplied: payload.resolution.redirectsApplied,
    diagnostics: {
      resolutionMs: Math.round(payload.metrics.resolutionMs),
      bfsMs: Math.round(payload.metrics.bfsMs),
      routeEnumerationMs: Math.round(payload.metrics.routeEnumerationMs),
      totalRequestMs: Math.round(payload.metrics.totalRequestMs),
      firstRouteMs: Math.round(payload.metrics.firstRouteMs),
      lastRouteMs: Math.round(payload.metrics.lastRouteMs),
      nodesExpanded: payload.metrics.nodesExpanded,
      frontierExpansions: payload.metrics.frontierExpansions,
      forwardVisited: payload.metrics.forwardVisited,
      reverseVisited: payload.metrics.reverseVisited
    },
    start: toResolvedInput(payload.resolution.from),
    end: toResolvedInput(payload.resolution.to)
  };
}

export async function runPathSearchProgressive(
  start: string,
  end: string,
  options: {
    signal?: AbortSignal;
    onUpdate?: (result: SearchResult) => void;
  } = {}
): Promise<SearchResult> {
  const response = await fetch(`${backendBaseUrl()}/api/path/stream`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ start, end }),
    cache: "no-store",
    signal: options.signal
  });

  if (!response.ok || !response.body) {
    let message = `Request failed with status ${response.status}`;
    try {
      const error = (await response.json()) as { message?: string; error?: string };
      message = error.message ?? error.error ?? message;
    } catch {
      // Ignore JSON parsing errors and fall back to the generic status message.
    }
    throw new Error(message);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finalResult: SearchResult | null = null;

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });

    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line) {
        const event = JSON.parse(line) as BackendSearchStreamEvent;
        if (event.type === "result") {
          const nextResult = toSearchResult(event.response);
          options.onUpdate?.(nextResult);
          finalResult = nextResult;
        }
      }
      newlineIndex = buffer.indexOf("\n");
    }

    if (done) {
      break;
    }
  }

  if (!finalResult) {
    throw new Error("Streaming path search ended before returning a result.");
  }

  return finalResult;
}

export async function fetchReadiness(): Promise<ReadinessState> {
  const payload = await apiFetch<BackendReadinessResponse>("/api/readiness");
  return {
    ready: payload.ready,
    graphLoaded: payload.readiness.graphLoaded,
    preloadComplete: payload.readiness.preloadComplete,
    searchReady: payload.readiness.searchReady,
    buildReady: payload.build.ready,
    totalNodes: payload.runtime?.counts?.canonicalNodes ?? 0
  };
}

export async function fetchStatsOverview(): Promise<StatsOverview> {
  const payload = await apiFetch<BackendStatsOverview>("/api/stats/overview");
  const recentSearches = payload.recent.map(toRecentSearch);
  return {
    stats: {
      totalSearches: payload.lifetime.totals.totalSearches,
      successfulSearches: payload.lifetime.totals.successfulSearches,
      failedSearches: payload.lifetime.totals.failedSearches,
      fastestMs: Math.round(payload.lifetime.records.fastest?.durationMs ?? 0),
      slowestMs: Math.round(payload.lifetime.records.slowest?.durationMs ?? 0),
      averageMs: Math.round(payload.lifetime.totals.averageDurationMs ?? 0),
      cacheHitRate: payload.lifetime.totals.cacheHitRate ?? 0,
      topConnector: payload.lifetime.top.connectors[0]?.label ?? "No searches yet",
      mostFrequentBridge:
        payload.lifetime.top.firstHops[0]?.label ?? payload.lifetime.top.connectors[0]?.label ?? "No searches yet",
      recentSearches
    },
    recentSearches
  };
}

export async function fetchSessionSummary(): Promise<BackendStatsSummary> {
  return apiFetch<BackendStatsSummary>("/api/stats/session");
}
