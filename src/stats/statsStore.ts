import fs from "node:fs";

import { appConfig } from "../config.js";
import type { AggregateSearchStats, SearchRecord } from "../shared/types.js";
import {
  createHistogram,
  durationHistogramBounds,
  pathLengthHistogramBounds,
  percentileFromHistogram,
  recordHistogram
} from "./histogram.js";

const RECENT_LIMIT = 250;

function createAggregate(): AggregateSearchStats {
  return {
    totalSearches: 0,
    successfulSearches: 0,
    failedSearches: 0,
    cachedSearches: 0,
    totalDurationMs: 0,
    totalNodesVisited: 0,
    totalNodesExpanded: 0,
    totalPathLength: 0,
    successfulPathCount: 0,
    fastestSearch: null,
    slowestSearch: null,
    longestPathSearch: null,
    shortestNonTrivialPathSearch: null,
    durationHistogram: createHistogram(durationHistogramBounds),
    pathLengthHistogram: createHistogram(pathLengthHistogramBounds),
    startArticleCounts: {},
    endArticleCounts: {},
    pairCounts: {},
    successfulPairCounts: {},
    failedPairCounts: {},
    connectorCounts: {},
    firstHopCounts: {},
    lastHopCounts: {},
    redirectCounts: {}
  };
}

function incrementCounter(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

function topEntries(
  source: Record<string, number>,
  limit: number,
  renderKey: (key: string) => string
): Array<{ key: string; label: string; count: number }> {
  return Object.entries(source)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([key, count]) => ({
      key,
      label: renderKey(key),
      count
    }));
}

export class SearchStatsStore {
  readonly #lifetime: AggregateSearchStats;
  readonly #session: AggregateSearchStats;
  readonly #recent: SearchRecord[];

  constructor() {
    fs.mkdirSync(appConfig.statsDir, { recursive: true });

    this.#lifetime = this.#loadJson<AggregateSearchStats>(appConfig.statsLifetimePath) ?? createAggregate();
    this.#session = createAggregate();
    this.#recent = this.#loadJson<SearchRecord[]>(appConfig.statsRecentPath) ?? [];
  }

  #loadJson<T>(filePath: string): T | null {
    if (!fs.existsSync(filePath)) {
      return null;
    }

    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  }

  #writeJson(filePath: string, value: unknown): void {
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
  }

  #updateAggregate(aggregate: AggregateSearchStats, record: SearchRecord): void {
    aggregate.totalSearches += 1;
    aggregate.totalDurationMs += record.durationMs;
    aggregate.totalNodesVisited += record.nodesVisited;
    aggregate.totalNodesExpanded += record.nodesExpanded;
    if (record.cached) {
      aggregate.cachedSearches += 1;
    }

    if (record.success) {
      aggregate.successfulSearches += 1;
      if (record.pathLength !== null) {
        aggregate.totalPathLength += record.pathLength;
        aggregate.successfulPathCount += 1;
        recordHistogram(aggregate.pathLengthHistogram, record.pathLength);

        if (
          !aggregate.longestPathSearch ||
          (aggregate.longestPathSearch.pathLength ?? -1) < record.pathLength
        ) {
          aggregate.longestPathSearch = record;
        }

        if (
          record.pathLength > 0 &&
          (!aggregate.shortestNonTrivialPathSearch ||
            (aggregate.shortestNonTrivialPathSearch.pathLength ?? Number.POSITIVE_INFINITY) > record.pathLength)
        ) {
          aggregate.shortestNonTrivialPathSearch = record;
        }
      }
    } else {
      aggregate.failedSearches += 1;
    }

    recordHistogram(aggregate.durationHistogram, record.durationMs);

    if (!aggregate.fastestSearch || aggregate.fastestSearch.durationMs > record.durationMs) {
      aggregate.fastestSearch = record;
    }
    if (!aggregate.slowestSearch || aggregate.slowestSearch.durationMs < record.durationMs) {
      aggregate.slowestSearch = record;
    }

    if (record.fromCanonicalId !== null) {
      incrementCounter(aggregate.startArticleCounts, String(record.fromCanonicalId));
    }
    if (record.toCanonicalId !== null) {
      incrementCounter(aggregate.endArticleCounts, String(record.toCanonicalId));
    }
    if (record.fromCanonicalId !== null && record.toCanonicalId !== null) {
      incrementCounter(aggregate.pairCounts, `${record.fromCanonicalId}->${record.toCanonicalId}`);
    }

    if (record.success && record.fromCanonicalId !== null && record.toCanonicalId !== null) {
      incrementCounter(aggregate.successfulPairCounts, `${record.fromCanonicalId}->${record.toCanonicalId}`);
    } else if (record.fromCanonicalId !== null && record.toCanonicalId !== null) {
      incrementCounter(aggregate.failedPairCounts, `${record.fromCanonicalId}->${record.toCanonicalId}`);
    }

    if (record.fromRedirectApplied && record.fromMatchedTitle) {
      incrementCounter(aggregate.redirectCounts, record.fromMatchedTitle);
    }
    if (record.toRedirectApplied && record.toMatchedTitle) {
      incrementCounter(aggregate.redirectCounts, record.toMatchedTitle);
    }

    if (record.pathNodeIds && record.pathNodeIds.length > 2) {
      incrementCounter(aggregate.firstHopCounts, String(record.pathNodeIds[1]));
      incrementCounter(aggregate.lastHopCounts, String(record.pathNodeIds[record.pathNodeIds.length - 2]));

      for (let index = 1; index < record.pathNodeIds.length - 1; index += 1) {
        incrementCounter(aggregate.connectorCounts, String(record.pathNodeIds[index]));
      }
    }
  }

  recordSearch(record: SearchRecord): void {
    this.#recent.unshift(record);
    if (this.#recent.length > RECENT_LIMIT) {
      this.#recent.length = RECENT_LIMIT;
    }

    this.#updateAggregate(this.#session, record);
    this.#updateAggregate(this.#lifetime, record);

    fs.appendFileSync(appConfig.statsLogPath, `${JSON.stringify(record)}\n`);
    this.#writeJson(appConfig.statsRecentPath, this.#recent);
    this.#writeJson(appConfig.statsLifetimePath, this.#lifetime);
  }

  recentSearches(limit = 25): SearchRecord[] {
    return this.#recent.slice(0, limit);
  }

  summary(
    scope: "session" | "lifetime",
    resolveNode: (nodeId: number) => string
  ): {
    totals: Record<string, number | null>;
    histograms: {
      duration: AggregateSearchStats["durationHistogram"];
      pathLength: AggregateSearchStats["pathLengthHistogram"];
    };
    records: {
      fastest: SearchRecord | null;
      slowest: SearchRecord | null;
      longestPath: SearchRecord | null;
      shortestNonTrivialPath: SearchRecord | null;
    };
    top: {
      startArticles: Array<{ key: string; label: string; count: number }>;
      endArticles: Array<{ key: string; label: string; count: number }>;
      pairs: Array<{ key: string; label: string; count: number }>;
      successfulPairs: Array<{ key: string; label: string; count: number }>;
      failedPairs: Array<{ key: string; label: string; count: number }>;
      connectors: Array<{ key: string; label: string; count: number }>;
      firstHops: Array<{ key: string; label: string; count: number }>;
      lastHops: Array<{ key: string; label: string; count: number }>;
      redirects: Array<{ key: string; label: string; count: number }>;
    };
  } {
    const aggregate = scope === "session" ? this.#session : this.#lifetime;
    const averageDurationMs =
      aggregate.totalSearches === 0 ? null : aggregate.totalDurationMs / aggregate.totalSearches;
    const averagePathLength =
      aggregate.successfulPathCount === 0 ? null : aggregate.totalPathLength / aggregate.successfulPathCount;
    const averageNodesVisited =
      aggregate.totalSearches === 0 ? null : aggregate.totalNodesVisited / aggregate.totalSearches;
    const averageNodesExpanded =
      aggregate.totalSearches === 0 ? null : aggregate.totalNodesExpanded / aggregate.totalSearches;
    const cacheHitRate =
      aggregate.totalSearches === 0 ? null : aggregate.cachedSearches / aggregate.totalSearches;

    const renderNode = (key: string) => resolveNode(Number(key));
    const renderPair = (key: string) => {
      const [from, to] = key.split("->");
      return `${resolveNode(Number(from))} -> ${resolveNode(Number(to))}`;
    };

    return {
      totals: {
        totalSearches: aggregate.totalSearches,
        successfulSearches: aggregate.successfulSearches,
        failedSearches: aggregate.failedSearches,
        cachedSearches: aggregate.cachedSearches,
        averageDurationMs,
        medianDurationMs: percentileFromHistogram(aggregate.durationHistogram, 0.5),
        p95DurationMs: percentileFromHistogram(aggregate.durationHistogram, 0.95),
        p99DurationMs: percentileFromHistogram(aggregate.durationHistogram, 0.99),
        averagePathLength,
        longestPathLength: aggregate.longestPathSearch?.pathLength ?? null,
        shortestNonTrivialPathLength: aggregate.shortestNonTrivialPathSearch?.pathLength ?? null,
        averageNodesVisited,
        averageNodesExpanded,
        cacheHitRate
      },
      histograms: {
        duration: aggregate.durationHistogram,
        pathLength: aggregate.pathLengthHistogram
      },
      records: {
        fastest: aggregate.fastestSearch,
        slowest: aggregate.slowestSearch,
        longestPath: aggregate.longestPathSearch,
        shortestNonTrivialPath: aggregate.shortestNonTrivialPathSearch
      },
      top: {
        startArticles: topEntries(aggregate.startArticleCounts, 15, renderNode),
        endArticles: topEntries(aggregate.endArticleCounts, 15, renderNode),
        pairs: topEntries(aggregate.pairCounts, 15, renderPair),
        successfulPairs: topEntries(aggregate.successfulPairCounts, 15, renderPair),
        failedPairs: topEntries(aggregate.failedPairCounts, 15, renderPair),
        connectors: topEntries(aggregate.connectorCounts, 15, renderNode),
        firstHops: topEntries(aggregate.firstHopCounts, 15, renderNode),
        lastHops: topEntries(aggregate.lastHopCounts, 15, renderNode),
        redirects: topEntries(aggregate.redirectCounts, 15, (key) => key)
      }
    };
  }
}
