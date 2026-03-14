import fs from "node:fs";

import { appConfig } from "../config.js";
import { buildRuntimeArtifact, getBuildReadiness } from "../build/builder.js";
import { discoverDumpPaths } from "../build/discover.js";
import { WikiGraphRuntime } from "../runtime/graphEngine.js";
import type {
  DumpPaths,
  PathFailureReason,
  PathResult,
  PathSearchMetrics,
  PathSearchResponse,
  PathSearchStreamEvent,
  ResolvedArticleResponse,
  SearchRecord,
  SuggestTitlesResponse
} from "../shared/types.js";
import { SearchStatsStore } from "../stats/statsStore.js";

export class WikiService {
  #runtime: WikiGraphRuntime | null;
  readonly #stats: SearchStatsStore;
  readonly #startedAt: string;

  private constructor(runtime: WikiGraphRuntime | null) {
    this.#runtime = runtime;
    this.#stats = new SearchStatsStore();
    this.#startedAt = new Date().toISOString();
  }

  static async bootstrap(): Promise<WikiService> {
    if (fs.existsSync(appConfig.artifactPath)) {
      return new WikiService(WikiGraphRuntime.loadFromDisk());
    }

    const discovery = discoverDumpPaths();
    if (discovery.missing.length === 0) {
      await buildRuntimeArtifact(discovery.dumps as DumpPaths);
      return new WikiService(WikiGraphRuntime.loadFromDisk());
    }

    return new WikiService(null);
  }

  isReady(): boolean {
    return this.#runtime !== null;
  }

  readiness(): Record<string, unknown> {
    const readiness = getBuildReadiness();
    const runtimeSummary = this.#runtime?.artifactSummary() ?? null;
    const memoryUsage = process.memoryUsage();
    return {
      startedAt: this.#startedAt,
      ready: this.isReady(),
      readiness: {
        graphLoaded: runtimeSummary?.preload.graphLoaded ?? false,
        preloadComplete: runtimeSummary?.preload.ramReady ?? false,
        searchReady: runtimeSummary?.preload.searchReady ?? false
      },
      build: readiness,
      runtime: runtimeSummary,
      memory: {
        rssBytes: memoryUsage.rss,
        heapUsedBytes: memoryUsage.heapUsed,
        heapTotalBytes: memoryUsage.heapTotal,
        externalBytes: memoryUsage.external,
        arrayBuffersBytes: memoryUsage.arrayBuffers
      }
    };
  }

  status(): Record<string, unknown> {
    return {
      ...this.readiness(),
      stats: {
        session: this.statsSummary("session"),
        lifetime: this.statsSummary("lifetime")
      }
    };
  }

  resolveTitle(title: string): ResolvedArticleResponse {
    const runtime = this.#requireRuntime();
    const result = runtime.resolveTitle(title);
    return {
      query: title,
      found: result !== null,
      result
    };
  }

  suggestTitles(query: string, limit?: number): SuggestTitlesResponse {
    const runtime = this.#requireRuntime();
    const suggestions = runtime.suggestTitles(query, limit);
    return {
      query,
      limit: limit ?? appConfig.autocompleteDefaultLimit,
      count: suggestions.length,
      suggestions
    };
  }

  searchPath(from: string, to: string): PathSearchResponse {
    const runtime = this.#requireRuntime();
    const searchedAt = new Date().toISOString();
    const searchId = crypto.randomUUID();
    const startedAt = performance.now();
    const resolutionStartedAt = performance.now();
    const resolvedFrom = this.resolveTitle(from);
    const resolvedTo = this.resolveTitle(to);
    const resolutionMs = performance.now() - resolutionStartedAt;
    const redirectsApplied =
      (resolvedFrom.result?.viaRedirect ?? false) || (resolvedTo.result?.viaRedirect ?? false);

    if (!resolvedFrom.result || !resolvedTo.result) {
      const response = this.#buildPathSearchResponse({
        searchId,
        searchedAt,
        from,
        to,
        resolvedFrom,
        resolvedTo,
        redirectsApplied,
        result: null,
        startedAt,
        resolutionMs,
        failureReason: this.#failureReasonForResolution(resolvedFrom, resolvedTo),
        stage: "complete"
      });

      this.#stats.recordSearch(this.#toSearchRecord(response));
      return response;
    }

    const result = runtime.findShortestPathResolved(resolvedFrom.result, resolvedTo.result);
    const response = this.#buildPathSearchResponse({
      searchId,
      searchedAt,
      from,
      to,
      resolvedFrom,
      resolvedTo,
      redirectsApplied,
      result,
      startedAt,
      resolutionMs,
      stage: "complete"
    });

    this.#stats.recordSearch(this.#toSearchRecord(response));
    return response;
  }

  async searchPathProgressive(
    from: string,
    to: string,
    onEvent: (event: PathSearchStreamEvent) => Promise<void> | void
  ): Promise<PathSearchResponse> {
    const runtime = this.#requireRuntime();
    const searchedAt = new Date().toISOString();
    const searchId = crypto.randomUUID();
    const startedAt = performance.now();
    const resolutionStartedAt = performance.now();
    const resolvedFrom = this.resolveTitle(from);
    const resolvedTo = this.resolveTitle(to);
    const resolutionMs = performance.now() - resolutionStartedAt;
    const redirectsApplied =
      (resolvedFrom.result?.viaRedirect ?? false) || (resolvedTo.result?.viaRedirect ?? false);

    if (!resolvedFrom.result || !resolvedTo.result) {
      const response = this.#buildPathSearchResponse({
        searchId,
        searchedAt,
        from,
        to,
        resolvedFrom,
        resolvedTo,
        redirectsApplied,
        result: null,
        startedAt,
        resolutionMs,
        failureReason: this.#failureReasonForResolution(resolvedFrom, resolvedTo),
        stage: "complete"
      });
      await onEvent({ type: "result", response });
      this.#stats.recordSearch(this.#toSearchRecord(response));
      return response;
    }

    const progressive = runtime.beginShortestPathResolved(resolvedFrom.result, resolvedTo.result);
    const initialResponse = this.#buildPathSearchResponse({
      searchId,
      searchedAt,
      from,
      to,
      resolvedFrom,
      resolvedTo,
      redirectsApplied,
      result: progressive.initial,
      startedAt,
      resolutionMs,
      stage: progressive.initial.cached || !progressive.initial.found ? "complete" : "initial"
    });
    await onEvent({ type: "result", response: initialResponse });

    if (initialResponse.stage === "complete") {
      this.#stats.recordSearch(this.#toSearchRecord(initialResponse));
      return initialResponse;
    }

    await new Promise<void>((resolve) => setImmediate(resolve));

    const expandedResponse = this.#buildPathSearchResponse({
      searchId,
      searchedAt,
      from,
      to,
      resolvedFrom,
      resolvedTo,
      redirectsApplied,
      result: progressive.expandDisplayedRoutes(),
      startedAt,
      resolutionMs,
      stage: "routes"
    });
    await onEvent({ type: "result", response: expandedResponse });

    await new Promise<void>((resolve) => setImmediate(resolve));

    const finalResponse = this.#buildPathSearchResponse({
      searchId,
      searchedAt,
      from,
      to,
      resolvedFrom,
      resolvedTo,
      redirectsApplied,
      result: progressive.finalize(),
      startedAt,
      resolutionMs,
      stage: "complete"
    });
    await onEvent({ type: "result", response: finalResponse });
    this.#stats.recordSearch(this.#toSearchRecord(finalResponse));
    return finalResponse;
  }

  statsSummary(scope: "session" | "lifetime"): Record<string, unknown> {
    const runtime = this.#requireRuntime();
    return {
      scope,
      summary: this.#stats.summary(scope, (nodeId) => runtime.canonicalTitleForNode(nodeId))
    };
  }

  performanceSummary(scope: "session" | "lifetime"): Record<string, unknown> {
    const runtime = this.#requireRuntime();
    const summary = this.#stats.summary(scope, (nodeId) => runtime.canonicalTitleForNode(nodeId));
    return {
      scope,
      totals: summary.totals,
      histograms: summary.histograms,
      records: summary.records
    };
  }

  topSearches(): Record<string, unknown> {
    const runtime = this.#requireRuntime();
    const summary = this.#stats.summary("lifetime", (nodeId) => runtime.canonicalTitleForNode(nodeId));
    return {
      scope: "lifetime",
      topSearches: {
        startArticles: summary.top.startArticles,
        endArticles: summary.top.endArticles,
        pairs: summary.top.pairs,
        successfulPairs: summary.top.successfulPairs,
        failedPairs: summary.top.failedPairs,
        redirects: summary.top.redirects
      }
    };
  }

  topConnectors(): Record<string, unknown> {
    const runtime = this.#requireRuntime();
    const summary = this.#stats.summary("lifetime", (nodeId) => runtime.canonicalTitleForNode(nodeId));
    return {
      scope: "lifetime",
      connectors: {
        topConnectors: summary.top.connectors,
        firstHops: summary.top.firstHops,
        lastHops: summary.top.lastHops
      }
    };
  }

  leaderboard(): Record<string, unknown> {
    const runtime = this.#requireRuntime();
    const summary = this.#stats.summary("lifetime", (nodeId) => runtime.canonicalTitleForNode(nodeId));
    return {
      scope: "lifetime",
      leaderboards: {
        records: summary.records,
        topPairs: summary.top.successfulPairs,
        topConnectors: summary.top.connectors,
        topRedirects: summary.top.redirects
      }
    };
  }

  recentSearches(limit?: number): Record<string, unknown> {
    return {
      searches: this.#stats.recentSearches(limit ?? appConfig.recentSearchLimit)
    };
  }

  statsOverview(): Record<string, unknown> {
    const runtime = this.#requireRuntime();
    const session = this.#stats.summary("session", (nodeId) => runtime.canonicalTitleForNode(nodeId));
    const lifetime = this.#stats.summary("lifetime", (nodeId) => runtime.canonicalTitleForNode(nodeId));
    const recent = this.#stats.recentSearches(appConfig.recentSearchLimit);

    return {
      generatedAt: new Date().toISOString(),
      recent,
      session,
      lifetime,
      performance: {
        session: {
          totals: session.totals,
          histograms: session.histograms,
          records: session.records
        },
        lifetime: {
          totals: lifetime.totals,
          histograms: lifetime.histograms,
          records: lifetime.records
        }
      },
      top: {
        startArticles: lifetime.top.startArticles,
        endArticles: lifetime.top.endArticles,
        pairs: lifetime.top.pairs,
        successfulPairs: lifetime.top.successfulPairs,
        failedPairs: lifetime.top.failedPairs,
        connectors: lifetime.top.connectors,
        firstHops: lifetime.top.firstHops,
        lastHops: lifetime.top.lastHops,
        redirects: lifetime.top.redirects,
        interesting: {
          mostCommonPair: lifetime.top.pairs[0] ?? null,
          mostCommonSuccessfulPair: lifetime.top.successfulPairs[0] ?? null,
          mostCommonFailedPair: lifetime.top.failedPairs[0] ?? null,
          topConnector: lifetime.top.connectors[0] ?? null,
          topFirstHop: lifetime.top.firstHops[0] ?? null,
          topLastHop: lifetime.top.lastHops[0] ?? null,
          topRedirect: lifetime.top.redirects[0] ?? null
        }
      }
    };
  }

  #toSearchRecord(response: PathSearchResponse): SearchRecord {
    return {
      id: response.searchId,
      timestamp: response.searchedAt,
      fromQuery: response.request.from,
      toQuery: response.request.to,
      fromCanonicalId: response.resolution.from.result?.canonicalId ?? null,
      toCanonicalId: response.resolution.to.result?.canonicalId ?? null,
      fromCanonicalTitle: response.resolution.from.result?.canonicalTitle ?? null,
      toCanonicalTitle: response.resolution.to.result?.canonicalTitle ?? null,
      fromMatchedTitle: response.resolution.from.result?.matchedTitle ?? null,
      toMatchedTitle: response.resolution.to.result?.matchedTitle ?? null,
      fromRedirectApplied: response.resolution.from.result?.viaRedirect ?? false,
      toRedirectApplied: response.resolution.to.result?.viaRedirect ?? false,
      success: response.success,
      failureReason: response.failureReason,
      cached: response.cached,
      durationMs: response.metrics.totalRequestMs,
      pathLength: response.pathLength,
      nodesVisited: response.metrics.nodesVisited,
      nodesExpanded: response.metrics.nodesExpanded,
      frontierExpansions: response.metrics.frontierExpansions,
      forwardVisited: response.metrics.forwardVisited,
      reverseVisited: response.metrics.reverseVisited,
      pathNodeIds: response.pathNodeIds,
      pathTitles: response.pathTitles
    };
  }

  #failureReasonForResolution(
    from: ResolvedArticleResponse,
    to: ResolvedArticleResponse
  ): Exclude<PathFailureReason, "no_path" | null> {
    if (!from.result && !to.result) {
      return "unresolved_both";
    }
    if (!from.result) {
      return "unresolved_start";
    }
    return "unresolved_end";
  }

  #zeroMetrics(totalRequestMs: number, resolutionMs: number): PathSearchMetrics {
    return {
      durationMs: 0,
      resolutionMs,
      bfsMs: 0,
      routeEnumerationMs: 0,
      totalRequestMs: Math.max(0, totalRequestMs),
      firstRouteMs: Math.max(0, resolutionMs),
      lastRouteMs: Math.max(0, totalRequestMs),
      nodesVisited: 0,
      nodesExpanded: 0,
      frontierExpansions: 0,
      forwardVisited: 0,
      reverseVisited: 0
    };
  }

  #buildPathSearchResponse({
    searchId,
    searchedAt,
    from,
    to,
    resolvedFrom,
    resolvedTo,
    redirectsApplied,
    result,
    startedAt,
    resolutionMs,
    stage,
    failureReason
  }: {
    searchId: string;
    searchedAt: string;
    from: string;
    to: string;
    resolvedFrom: ResolvedArticleResponse;
    resolvedTo: ResolvedArticleResponse;
    redirectsApplied: boolean;
    result: PathResult | null;
    startedAt: number;
    resolutionMs: number;
      stage: "initial" | "routes" | "complete";
    failureReason?: PathFailureReason;
  }): PathSearchResponse {
    return {
      searchId,
      searchedAt,
      stage,
      partial: stage !== "complete",
      request: {
        from,
        to
      },
      resolution: {
        from: resolvedFrom,
        to: resolvedTo,
        redirectsApplied
      },
      found: result?.found ?? false,
      success: result?.found ?? false,
      failureReason: failureReason ?? (result?.found ? null : "no_path"),
      cached: result?.cached ?? false,
      routes: result?.routes ?? null,
      totalRoutesFound: result?.totalRoutesFound ?? null,
      displayedRoutes: result?.displayedRoutes ?? 0,
      pathLength: result?.pathLength ?? null,
      pathNodeIds: result?.pathNodeIds ?? null,
      pathTitles: result?.pathTitles ?? null,
      pathNodes: result?.pathNodes ?? null,
      metrics: result
        ? {
            ...result.metrics,
            resolutionMs,
            totalRequestMs: resolutionMs + result.metrics.durationMs,
            firstRouteMs: resolutionMs + result.metrics.firstRouteMs,
            lastRouteMs: resolutionMs + result.metrics.lastRouteMs
          }
        : this.#zeroMetrics(performance.now() - startedAt, resolutionMs)
    };
  }

  #requireRuntime(): WikiGraphRuntime {
    if (!this.#runtime) {
      throw new Error(
        `Runtime artifact not ready. Build status: ${JSON.stringify(getBuildReadiness())}`
      );
    }

    return this.#runtime;
  }
}
