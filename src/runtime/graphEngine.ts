import fs from "node:fs";
import path from "node:path";
import v8 from "node:v8";

import { appConfig } from "../config.js";
import {
  displayTitleToDbTitle,
  normalizePrefixKey,
  normalizeTitleForSearch,
  tokenizeSearchTerms
} from "../shared/normalize.js";
import type {
  PathNodeMetadata,
  PathResult,
  ResolvedArticle,
  RouteVariant,
  RuntimeArtifact,
  SuggestionResult
} from "../shared/types.js";
import { PathResultCache } from "./cache.js";

interface BfsScratch {
  forwardMark: Uint32Array;
  reverseMark: Uint32Array;
  forwardDistance: Int32Array;
  reverseDistance: Int32Array;
  forwardParent: Int32Array;
  reverseParent: Int32Array;
  forwardQueue: Uint32Array;
  reverseQueue: Uint32Array;
  stamp: number;
}

interface ChunkManifest {
  kind: "string" | "u32" | "u8";
  length: number;
  files: string[];
}

interface PersistedArtifactManifest {
  version: number;
  builtAt: string;
  dumpFiles: RuntimeArtifact["dumpFiles"];
  counts: RuntimeArtifact["counts"];
  prefixBuckets: Record<string, [number, number]>;
  chunks: {
    canonicalTitles: ChunkManifest;
    canonicalSearchKeys: ChunkManifest;
    aliasTitles: ChunkManifest;
    aliasSearchKeys: ChunkManifest;
    aliasTargetNodeIds: ChunkManifest;
    aliasKinds: ChunkManifest;
    sortedAliasIndices: ChunkManifest;
    forwardOffsets: ChunkManifest;
    forwardAdjacency: ChunkManifest;
    reverseOffsets: ChunkManifest;
    reverseAdjacency: ChunkManifest;
  };
}

interface ShortestRouteDag {
  depthBuckets: number[][];
  successorsByNode: Map<number, number[]>;
}

function createScratch(nodeCount: number): BfsScratch {
  return {
    forwardMark: new Uint32Array(nodeCount),
    reverseMark: new Uint32Array(nodeCount),
    forwardDistance: new Int32Array(nodeCount),
    reverseDistance: new Int32Array(nodeCount),
    forwardParent: new Int32Array(nodeCount),
    reverseParent: new Int32Array(nodeCount),
    forwardQueue: new Uint32Array(nodeCount),
    reverseQueue: new Uint32Array(nodeCount),
    stamp: 0
  };
}

function normalizeDisplayTitle(input: string): string {
  return input
    .normalize("NFKC")
    .replaceAll("_", " ")
    .replace(/\s+/g, " ")
    .trim();
}

const MAX_FUZZY_CANDIDATES = 5000;
const SUGGESTION_CACHE_LIMIT = 200;
const FUZZY_RESOLUTION_CACHE_LIMIT = 500;
const MAX_SUFFIX_TRIM_FALLBACK = 5;

export class WikiGraphRuntime {
  readonly #artifact: RuntimeArtifact;
  readonly #cache: PathResultCache;
  readonly #scratch: BfsScratch;
  readonly #suggestionCache = new Map<string, SuggestionResult[]>();
  readonly #fuzzyResolutionCache = new Map<string, number | null>();

  constructor(artifact: RuntimeArtifact) {
    this.#artifact = artifact;
    this.#cache = new PathResultCache(appConfig.cacheSize);
    this.#scratch = createScratch(artifact.counts.canonicalNodes);
  }

  static loadFromDisk(): WikiGraphRuntime {
    const manifest = JSON.parse(fs.readFileSync(appConfig.artifactPath, "utf8")) as PersistedArtifactManifest;
    const artifact: RuntimeArtifact = {
      version: manifest.version,
      builtAt: manifest.builtAt,
      dumpFiles: manifest.dumpFiles,
      counts: manifest.counts,
      graph: {
        forwardOffsets: readUint32Chunks(manifest.chunks.forwardOffsets),
        forwardAdjacency: readUint32Chunks(manifest.chunks.forwardAdjacency),
        reverseOffsets: readUint32Chunks(manifest.chunks.reverseOffsets),
        reverseAdjacency: readUint32Chunks(manifest.chunks.reverseAdjacency)
      },
      titles: {
        canonicalTitles: readStringChunks(manifest.chunks.canonicalTitles),
        canonicalSearchKeys: readStringChunks(manifest.chunks.canonicalSearchKeys),
        aliasTitles: readStringChunks(manifest.chunks.aliasTitles),
        aliasSearchKeys: readStringChunks(manifest.chunks.aliasSearchKeys),
        aliasTargetNodeIds: readUint32Chunks(manifest.chunks.aliasTargetNodeIds),
        aliasKinds: readUint8Chunks(manifest.chunks.aliasKinds),
        sortedAliasIndices: readUint32Chunks(manifest.chunks.sortedAliasIndices),
        prefixBuckets: manifest.prefixBuckets,
        exactAliasBuckets: new Map()
      }
    };
    for (let index = 0; index < artifact.titles.aliasSearchKeys.length; index += 1) {
      const searchKey = artifact.titles.aliasSearchKeys[index]!;
      let bucket = artifact.titles.exactAliasBuckets.get(normalizePrefixKey(searchKey));
      if (!bucket) {
        bucket = new Map<string, number>();
        artifact.titles.exactAliasBuckets.set(normalizePrefixKey(searchKey), bucket);
      }
      if (!bucket.has(searchKey)) {
        bucket.set(searchKey, index);
      }
    }
    return new WikiGraphRuntime(artifact);
  }

  artifactSummary(): {
    builtAt: string;
    counts: RuntimeArtifact["counts"];
    dumpFiles: RuntimeArtifact["dumpFiles"];
    cache: { size: number; capacity: number };
    preload: {
      graphLoaded: boolean;
      ramReady: boolean;
      searchReady: boolean;
      canonicalNodes: number;
      aliasEntries: number;
    };
  } {
    return {
      builtAt: this.#artifact.builtAt,
      counts: this.#artifact.counts,
      dumpFiles: this.#artifact.dumpFiles,
      cache: this.#cache.stats(),
      preload: {
        graphLoaded: true,
        ramReady: true,
        searchReady: true,
        canonicalNodes: this.#artifact.counts.canonicalNodes,
        aliasEntries: this.#artifact.counts.aliases
      }
    };
  }

  wikipediaUrlForTitle(title: string): string {
    return `https://en.wikipedia.org/wiki/${encodeURIComponent(displayTitleToDbTitle(title))}`;
  }

  canonicalTitleForNode(nodeId: number): string {
    return this.#artifact.titles.canonicalTitles[nodeId]!;
  }

  nodeMetadata(nodeId: number, position: number, totalNodes: number): PathNodeMetadata {
    const canonicalTitle = this.canonicalTitleForNode(nodeId);
    const pathLength = Math.max(0, totalNodes - 1);
    return {
      articleId: nodeId,
      canonicalTitle,
      displayTitle: canonicalTitle,
      wikipediaUrl: this.wikipediaUrlForTitle(canonicalTitle),
      position,
      role: position === 0 ? "start" : position === totalNodes - 1 ? "end" : "intermediate",
      distanceFromStart: position,
      normalizedDistanceRatio: pathLength === 0 ? 0 : position / pathLength
    };
  }

  resolveTitle(query: string): ResolvedArticle | null {
    const normalizedQuery = normalizeTitleForSearch(query);
    const aliasIndex =
      this.#findResolvedAliasIndex(query, normalizedQuery) ?? this.#findAliasIndexBySuffixTrim(query);
    if (aliasIndex === undefined) {
      return null;
    }

    const canonicalId = this.#artifact.titles.aliasTargetNodeIds[aliasIndex]!;
    const matchedTitle = this.#artifact.titles.aliasTitles[aliasIndex]!;
    const canonicalTitle = this.#artifact.titles.canonicalTitles[canonicalId]!;
    const viaRedirect = this.#artifact.titles.aliasKinds[aliasIndex] === 1;

    return {
      query,
      normalizedQuery,
      matchedTitle,
      canonicalTitle,
      canonicalId,
      displayTitle: canonicalTitle,
      wikipediaUrl: this.wikipediaUrlForTitle(canonicalTitle),
      viaRedirect,
      kind: viaRedirect ? "redirect" : "canonical"
    };
  }

  suggestTitles(query: string, limit = appConfig.autocompleteDefaultLimit): SuggestionResult[] {
    const normalizedQuery = normalizeTitleForSearch(query);
    if (!normalizedQuery) {
      return [];
    }

    const cappedLimit = Math.max(1, Math.min(limit, appConfig.autocompleteMaxLimit));
    const cacheKey = `${normalizedQuery}:${cappedLimit}`;
    const cached = this.#suggestionCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const suggestions: SuggestionResult[] = [];
    const seenCanonicalIds = new Set<number>();
    const prefixCandidates = this.#prefixSuggestionCandidates(normalizedQuery, cappedLimit);

    for (const aliasIndex of prefixCandidates) {
      if (suggestions.length >= cappedLimit) {
        break;
      }
      this.#appendSuggestion(suggestions, seenCanonicalIds, aliasIndex);
    }

    const queryTokens = tokenizeSearchTerms(query);
    if (suggestions.length < cappedLimit && queryTokens.length > 1) {
      const rankedCandidates = this.#rankSuggestionCandidates(query, Math.max(cappedLimit * 4, 16));
      for (const candidate of rankedCandidates) {
        if (suggestions.length >= cappedLimit) {
          break;
        }
        this.#appendSuggestion(suggestions, seenCanonicalIds, candidate.aliasIndex);
      }
    }

    return this.#rememberSuggestions(cacheKey, suggestions);
  }

  findShortestPath(fromQuery: string, toQuery: string): PathResult {
    const from = this.resolveTitle(fromQuery);
    const to = this.resolveTitle(toQuery);
    if (!from || !to) {
      throw new Error("Both articles must resolve to canonical Wikipedia articles before path search.");
    }

    return this.findShortestPathResolved(from, to);
  }

  findShortestPathResolved(from: ResolvedArticle, to: ResolvedArticle): PathResult {
    return this.beginShortestPathResolved(from, to).finalize();
  }

  beginShortestPathResolved(from: ResolvedArticle, to: ResolvedArticle): {
    initial: PathResult;
    expandDisplayedRoutes: () => PathResult;
    finalize: () => PathResult;
  } {
    const cacheKey = `${from.canonicalId}->${to.canonicalId}`;
    const cached = this.#cache.get(cacheKey);
    if (cached) {
      const cachedResult: PathResult = {
        ...cached,
        cached: true,
        metrics: {
          ...cached.metrics,
          durationMs: 0,
          bfsMs: 0,
          routeEnumerationMs: 0,
          firstRouteMs: 0,
          lastRouteMs: 0,
          nodesVisited: 0,
          nodesExpanded: 0,
          frontierExpansions: 0,
          forwardVisited: 0,
          reverseVisited: 0
        }
      };
      return {
        initial: cachedResult,
        expandDisplayedRoutes: () => cachedResult,
        finalize: () => cachedResult
      };
    }

    const bfsStartedAt = performance.now();
    const pathNodeIds = this.#runBidirectionalBfs(from.canonicalId, to.canonicalId);
    const bfsMs = performance.now() - bfsStartedAt;
    const primaryRoute = pathNodeIds === null ? null : this.#routeVariant(pathNodeIds, 0);
    const initial: PathResult = {
      found: pathNodeIds !== null,
      cached: false,
      from,
      to,
      routes: primaryRoute ? [primaryRoute] : null,
      totalRoutesFound: null,
      displayedRoutes: primaryRoute ? 1 : 0,
      pathNodeIds: primaryRoute?.pathNodeIds ?? null,
      pathTitles: primaryRoute?.pathTitles ?? null,
      pathNodes: primaryRoute?.pathNodes ?? null,
      pathLength: primaryRoute ? primaryRoute.pathNodeIds.length - 1 : null,
      metrics: {
        durationMs: bfsMs,
        resolutionMs: 0,
        bfsMs,
        routeEnumerationMs: 0,
        totalRequestMs: bfsMs,
        firstRouteMs: bfsMs,
        lastRouteMs: bfsMs,
        nodesVisited: this.#lastMetrics.nodesVisited,
        nodesExpanded: this.#lastMetrics.nodesExpanded,
        frontierExpansions: this.#lastMetrics.frontierExpansions,
        forwardVisited: this.#lastMetrics.forwardVisited,
        reverseVisited: this.#lastMetrics.reverseVisited
      }
    };

    if (pathNodeIds === null) {
      return {
        initial,
        expandDisplayedRoutes: () => initial,
        finalize: () => initial
      };
    }

    let routeDag: ShortestRouteDag | null = null;
    let sampledRouteIds: number[][] | null = null;
    let expanded: PathResult | null = null;
    let finalized: PathResult | null = null;
    let routePreparationMs = 0;
    return {
      initial,
      expandDisplayedRoutes: () => {
        if (expanded) {
          return expanded;
        }

        const routeStartedAt = performance.now();
        routeDag ??= this.#buildShortestRouteDag(from.canonicalId, to.canonicalId, pathNodeIds.length - 1);
        sampledRouteIds ??= this.#collectDisplayedRoutes(
          routeDag,
          from.canonicalId,
          to.canonicalId,
          pathNodeIds
        );
        routePreparationMs = performance.now() - routeStartedAt;
        const expandedRoutes = sampledRouteIds.map((routeNodeIds, index) =>
          this.#routeVariant(routeNodeIds, index)
        );
        const expandedPrimaryRoute = expandedRoutes[0] ?? primaryRoute;
        const durationMs = bfsMs + routePreparationMs;

        expanded = {
          found: true,
          cached: false,
          from,
          to,
          routes: expandedRoutes,
          totalRoutesFound: null,
          displayedRoutes: expandedRoutes.length,
          pathNodeIds: expandedPrimaryRoute?.pathNodeIds ?? null,
          pathTitles: expandedPrimaryRoute?.pathTitles ?? null,
          pathNodes: expandedPrimaryRoute?.pathNodes ?? null,
          pathLength: expandedPrimaryRoute ? expandedPrimaryRoute.pathNodeIds.length - 1 : null,
          metrics: {
            durationMs,
            resolutionMs: 0,
            bfsMs,
            routeEnumerationMs: routePreparationMs,
            totalRequestMs: durationMs,
            firstRouteMs: bfsMs,
            lastRouteMs: durationMs,
            nodesVisited: this.#lastMetrics.nodesVisited,
            nodesExpanded: this.#lastMetrics.nodesExpanded,
            frontierExpansions: this.#lastMetrics.frontierExpansions,
            forwardVisited: this.#lastMetrics.forwardVisited,
            reverseVisited: this.#lastMetrics.reverseVisited
          }
        };

        return expanded;
      },
      finalize: () => {
        if (finalized) {
          return finalized;
        }

        const routeStartedAt = performance.now();
        routeDag ??= this.#buildShortestRouteDag(from.canonicalId, to.canonicalId, pathNodeIds.length - 1);
        sampledRouteIds ??= this.#collectDisplayedRoutes(
          routeDag,
          from.canonicalId,
          to.canonicalId,
          pathNodeIds
        );
        const sampledRoutes = sampledRouteIds.map((routeNodeIds, index) =>
          this.#routeVariant(routeNodeIds, index)
        );
        const totalRoutesFound = this.#countShortestRoutes(
          routeDag,
          from.canonicalId,
          to.canonicalId,
          pathNodeIds.length - 1
        );
        const routeEnumerationMs = routePreparationMs + (performance.now() - routeStartedAt);
        const durationMs = bfsMs + routeEnumerationMs;
        const fullPrimaryRoute = sampledRoutes[0] ?? primaryRoute;

        finalized = {
          found: true,
          cached: false,
          from,
          to,
          routes: sampledRoutes,
          totalRoutesFound,
          displayedRoutes: sampledRoutes.length,
          pathNodeIds: fullPrimaryRoute?.pathNodeIds ?? null,
          pathTitles: fullPrimaryRoute?.pathTitles ?? null,
          pathNodes: fullPrimaryRoute?.pathNodes ?? null,
          pathLength: fullPrimaryRoute ? fullPrimaryRoute.pathNodeIds.length - 1 : null,
          metrics: {
            durationMs,
            resolutionMs: 0,
            bfsMs,
            routeEnumerationMs,
            totalRequestMs: durationMs,
            firstRouteMs: bfsMs,
            lastRouteMs: durationMs,
            nodesVisited: this.#lastMetrics.nodesVisited,
            nodesExpanded: this.#lastMetrics.nodesExpanded,
            frontierExpansions: this.#lastMetrics.frontierExpansions,
            forwardVisited: this.#lastMetrics.forwardVisited,
            reverseVisited: this.#lastMetrics.reverseVisited
          }
        };

        this.#cache.set(cacheKey, finalized);
        return finalized;
      }
    };
  }

  readonly #lastMetrics = {
    nodesVisited: 0,
    nodesExpanded: 0,
    frontierExpansions: 0,
    forwardVisited: 0,
    reverseVisited: 0
  };

  #nextScratchStamp(): number {
    this.#scratch.stamp += 1;
    if (this.#scratch.stamp === 0) {
      this.#scratch.forwardMark.fill(0);
      this.#scratch.reverseMark.fill(0);
      this.#scratch.stamp = 1;
    }
    return this.#scratch.stamp;
  }

  #findAliasIndex(query: string, normalizedQuery: string): number | undefined {
    const exactMatch = this.#findExactDisplayAliasIndex(query, normalizedQuery);
    if (exactMatch !== undefined) {
      return exactMatch;
    }

    return this.#artifact.titles.exactAliasBuckets.get(normalizePrefixKey(normalizedQuery))?.get(normalizedQuery);
  }

  #findResolvedAliasIndex(query: string, normalizedQuery: string): number | undefined {
    return this.#findAliasIndex(query, normalizedQuery) ?? this.#findFuzzyAliasIndex(query, normalizedQuery);
  }

  #findAliasIndexBySuffixTrim(query: string): number | undefined {
    const trimmedQuery = query.trimEnd();
    for (let trimCount = 1; trimCount <= MAX_SUFFIX_TRIM_FALLBACK; trimCount += 1) {
      if (trimmedQuery.length - trimCount < 2) {
        break;
      }

      const shortenedQuery = trimmedQuery.slice(0, -trimCount).trimEnd();
      if (!shortenedQuery) {
        break;
      }

      const normalizedShortenedQuery = normalizeTitleForSearch(shortenedQuery);
      if (!normalizedShortenedQuery) {
        break;
      }

      const aliasIndex = this.#findResolvedAliasIndex(shortenedQuery, normalizedShortenedQuery);
      if (aliasIndex !== undefined) {
        return aliasIndex;
      }
    }

    return undefined;
  }

  #findExactDisplayAliasIndex(query: string, normalizedQuery: string): number | undefined {
    const displayQuery = normalizeDisplayTitle(query);
    const bucket =
      this.#artifact.titles.prefixBuckets[normalizedQuery.slice(0, 2)] ??
      this.#artifact.titles.prefixBuckets[normalizedQuery.slice(0, 1)];

    if (!bucket) {
      return undefined;
    }

    for (let offset = bucket[0]; offset < bucket[1]; offset += 1) {
      const aliasIndex = this.#artifact.titles.sortedAliasIndices[offset]!;
      if (this.#artifact.titles.aliasSearchKeys[aliasIndex] !== normalizedQuery) {
        continue;
      }
      if (this.#artifact.titles.aliasTitles[aliasIndex] === displayQuery) {
        return aliasIndex;
      }
    }

    return undefined;
  }

  #findFuzzyAliasIndex(query: string, normalizedQuery: string): number | undefined {
    if (!normalizedQuery) {
      return undefined;
    }

    const cached = this.#fuzzyResolutionCache.get(normalizedQuery);
    if (cached !== undefined) {
      return cached ?? undefined;
    }

    const aliasIndex = this.#rankSuggestionCandidates(query, 1)[0]?.aliasIndex ?? null;
    this.#rememberFuzzyResolution(normalizedQuery, aliasIndex);
    return aliasIndex ?? undefined;
  }

  #rankSuggestionCandidates(query: string, limit = appConfig.autocompleteMaxLimit): Array<{
    aliasIndex: number;
    score: number;
  }> {
    const normalizedQuery = normalizeTitleForSearch(query);
    if (!normalizedQuery) {
      return [];
    }

    const queryTokens = tokenizeSearchTerms(query);
    if (queryTokens.length === 0) {
      return [];
    }

    const candidateOffsets = this.#candidateAliasOffsetsForTokens(normalizedQuery, queryTokens);
    const ranked: Array<{ aliasIndex: number; score: number }> = [];

    for (const aliasIndex of candidateOffsets) {
      const aliasKey = this.#artifact.titles.aliasSearchKeys[aliasIndex]!;
      const aliasTokens = tokenizeSearchTerms(aliasKey);
      if (aliasTokens.length === 0) {
        continue;
      }

      let matchedTokens = 0;
      let tokenPositionSum = 0;
      let failed = false;

      for (const queryToken of queryTokens) {
        const tokenIndex = aliasTokens.findIndex((aliasToken) => aliasToken.startsWith(queryToken));
        if (tokenIndex === -1) {
          failed = true;
          break;
        }
        matchedTokens += 1;
        tokenPositionSum += tokenIndex;
      }

      if (failed) {
        continue;
      }

      const prefixBonus = aliasKey.startsWith(normalizedQuery) ? 200 : 0;
      const exactBonus = aliasKey === normalizedQuery ? 400 : 0;
      const containsBonus = aliasKey.includes(normalizedQuery) ? 50 : 0;
      const compactLengthPenalty = aliasTokens.length * 2 + aliasKey.length * 0.02;
      const score =
        exactBonus +
        prefixBonus +
        containsBonus +
        matchedTokens * 60 +
        tokenPositionSum * -4 -
        compactLengthPenalty;

      ranked.push({ aliasIndex, score });
    }

    ranked.sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return left.aliasIndex - right.aliasIndex;
    });

    return ranked.slice(0, Math.max(1, limit));
  }

  #candidateAliasOffsetsForTokens(normalizedQuery: string, queryTokens: string[]): number[] {
    const offsets = new Set<number>();
    const prefixQueries = [normalizedQuery, ...queryTokens];

    for (const prefixQuery of prefixQueries) {
      if (!prefixQuery) {
        continue;
      }
      const prefixCandidates = this.#prefixSuggestionCandidates(prefixQuery, 512);
      for (const aliasIndex of prefixCandidates) {
        offsets.add(aliasIndex);
        if (offsets.size >= MAX_FUZZY_CANDIDATES) {
          return Array.from(offsets);
        }
      }
    }

    if (offsets.size > 0) {
      return Array.from(offsets);
    }

    const primaryBucketKeys = new Set<string>();
    const fallbackBucketKeys = new Set<string>();

    for (const token of [normalizedQuery, ...queryTokens]) {
      if (!token) {
        continue;
      }
      if (token.length >= 2) {
        primaryBucketKeys.add(token.slice(0, 2));
      }
      fallbackBucketKeys.add(token.slice(0, 1));
    }

    const candidateBucketKeys = primaryBucketKeys.size > 0 ? primaryBucketKeys : fallbackBucketKeys;
    const perBucketLimit = Math.max(250, Math.floor(MAX_FUZZY_CANDIDATES / Math.max(candidateBucketKeys.size, 1)));

    for (const bucketKey of candidateBucketKeys) {
      const bucket = this.#artifact.titles.prefixBuckets[bucketKey];
      if (!bucket) {
        continue;
      }
      let scanned = 0;
      for (let offset = bucket[0]; offset < bucket[1] && scanned < perBucketLimit; offset += 1) {
        offsets.add(this.#artifact.titles.sortedAliasIndices[offset]!);
        scanned += 1;
        if (offsets.size >= MAX_FUZZY_CANDIDATES) {
          return Array.from(offsets);
        }
      }
    }

    return Array.from(offsets);
  }

  #prefixSuggestionCandidates(normalizedQuery: string, limit: number): number[] {
    const bucket =
      this.#artifact.titles.prefixBuckets[normalizedQuery.slice(0, 2)] ??
      this.#artifact.titles.prefixBuckets[normalizedQuery.slice(0, 1)];

    if (!bucket) {
      return [];
    }

    const [start, end] = bucket;
    let left = start;
    let right = end;

    while (left < right) {
      const middle = Math.floor((left + right) / 2);
      const aliasIndex = this.#artifact.titles.sortedAliasIndices[middle]!;
      const aliasKey = this.#artifact.titles.aliasSearchKeys[aliasIndex]!;
      if (aliasKey < normalizedQuery) {
        left = middle + 1;
      } else {
        right = middle;
      }
    }

    const aliasIndices: number[] = [];
    const scanLimit = Math.max(limit * 4, 12);
    for (let offset = left; offset < end && aliasIndices.length < scanLimit; offset += 1) {
      const aliasIndex = this.#artifact.titles.sortedAliasIndices[offset]!;
      const aliasKey = this.#artifact.titles.aliasSearchKeys[aliasIndex]!;
      if (!aliasKey.startsWith(normalizedQuery)) {
        break;
      }
      aliasIndices.push(aliasIndex);
    }

    return aliasIndices;
  }

  #appendSuggestion(target: SuggestionResult[], seenCanonicalIds: Set<number>, aliasIndex: number): boolean {
    const canonicalId = this.#artifact.titles.aliasTargetNodeIds[aliasIndex]!;
    if (seenCanonicalIds.has(canonicalId)) {
      return false;
    }

    seenCanonicalIds.add(canonicalId);
    const viaRedirect = this.#artifact.titles.aliasKinds[aliasIndex] === 1;
    const canonicalTitle = this.#artifact.titles.canonicalTitles[canonicalId]!;
    target.push({
      title: this.#artifact.titles.aliasTitles[aliasIndex]!,
      canonicalTitle,
      canonicalId,
      displayTitle: canonicalTitle,
      wikipediaUrl: this.wikipediaUrlForTitle(canonicalTitle),
      viaRedirect,
      kind: viaRedirect ? "redirect" : "canonical"
    });
    return true;
  }

  #rememberSuggestions(cacheKey: string, suggestions: SuggestionResult[]): SuggestionResult[] {
    const cachedSuggestions = suggestions.slice();
    this.#suggestionCache.set(cacheKey, cachedSuggestions);
    if (this.#suggestionCache.size > SUGGESTION_CACHE_LIMIT) {
      const oldestKey = this.#suggestionCache.keys().next().value;
      if (oldestKey) {
        this.#suggestionCache.delete(oldestKey);
      }
    }
    return cachedSuggestions;
  }

  #rememberFuzzyResolution(normalizedQuery: string, aliasIndex: number | null): void {
    this.#fuzzyResolutionCache.set(normalizedQuery, aliasIndex);
    if (this.#fuzzyResolutionCache.size > FUZZY_RESOLUTION_CACHE_LIMIT) {
      const oldestKey = this.#fuzzyResolutionCache.keys().next().value;
      if (oldestKey) {
        this.#fuzzyResolutionCache.delete(oldestKey);
      }
    }
  }

  #runBidirectionalBfs(startNodeId: number, targetNodeId: number): number[] | null {
    const { forwardOffsets, forwardAdjacency, reverseOffsets, reverseAdjacency } = this.#artifact.graph;
    const scratch = this.#scratch;
    const stamp = this.#nextScratchStamp();
    this.#lastMetrics.nodesVisited = 0;
    this.#lastMetrics.nodesExpanded = 0;
    this.#lastMetrics.frontierExpansions = 0;
    this.#lastMetrics.forwardVisited = 0;
    this.#lastMetrics.reverseVisited = 0;

    if (startNodeId === targetNodeId) {
      this.#lastMetrics.nodesVisited = 1;
      return [startNodeId];
    }

    let forwardHead = 0;
    let forwardTail = 1;
    let reverseHead = 0;
    let reverseTail = 1;
    scratch.forwardQueue[0] = startNodeId;
    scratch.reverseQueue[0] = targetNodeId;
    scratch.forwardMark[startNodeId] = stamp;
    scratch.reverseMark[targetNodeId] = stamp;
    scratch.forwardParent[startNodeId] = -1;
    scratch.reverseParent[targetNodeId] = -1;
    this.#lastMetrics.nodesVisited = 2;
    this.#lastMetrics.forwardVisited = 1;
    this.#lastMetrics.reverseVisited = 1;

    let meetingNodeId = -1;

    while (forwardHead < forwardTail && reverseHead < reverseTail) {
      const expandForward = forwardTail - forwardHead <= reverseTail - reverseHead;
      const queue = expandForward ? scratch.forwardQueue : scratch.reverseQueue;
      const head = expandForward ? forwardHead : reverseHead;
      const tail = expandForward ? forwardTail : reverseTail;
      const levelEnd = tail;

      this.#lastMetrics.frontierExpansions += 1;

      for (let cursor = head; cursor < levelEnd; cursor += 1) {
        const nodeId = queue[cursor]!;
        this.#lastMetrics.nodesExpanded += 1;

        const offsets = expandForward ? forwardOffsets : reverseOffsets;
        const adjacency = expandForward ? forwardAdjacency : reverseAdjacency;
        const ownMarks = expandForward ? scratch.forwardMark : scratch.reverseMark;
        const otherMarks = expandForward ? scratch.reverseMark : scratch.forwardMark;
        const ownParents = expandForward ? scratch.forwardParent : scratch.reverseParent;
        const ownQueue = expandForward ? scratch.forwardQueue : scratch.reverseQueue;
        let ownTail = expandForward ? forwardTail : reverseTail;

        for (let edgeIndex = offsets[nodeId]!; edgeIndex < (offsets[nodeId + 1] ?? 0); edgeIndex += 1) {
          const neighbor = adjacency[edgeIndex]!;
          if (ownMarks[neighbor] === stamp) {
            continue;
          }

          ownMarks[neighbor] = stamp;
          ownParents[neighbor] = nodeId;
          ownQueue[ownTail] = neighbor;
          ownTail += 1;
          this.#lastMetrics.nodesVisited += 1;

          if (expandForward) {
            this.#lastMetrics.forwardVisited += 1;
          } else {
            this.#lastMetrics.reverseVisited += 1;
          }

          if (otherMarks[neighbor] === stamp) {
            meetingNodeId = neighbor;
            if (expandForward) {
              forwardTail = ownTail;
            } else {
              reverseTail = ownTail;
            }
            break;
          }
        }

        if (expandForward) {
          forwardTail = ownTail;
        } else {
          reverseTail = ownTail;
        }

        if (meetingNodeId !== -1) {
          break;
        }
      }

      if (expandForward) {
        forwardHead = levelEnd;
      } else {
        reverseHead = levelEnd;
      }

      if (meetingNodeId !== -1) {
        return this.#reconstructPath(meetingNodeId, startNodeId, targetNodeId);
      }
    }

    return null;
  }

  #computeShortestRoutes(
    startNodeId: number,
    targetNodeId: number,
    shortestLength: number
  ): { routes: RouteVariant[]; totalRoutesFound: string; displayedRoutes: number } {
    const routeDag = this.#buildShortestRouteDag(startNodeId, targetNodeId, shortestLength);
    const sampledRoutes = this.#collectDisplayedRoutes(routeDag, startNodeId, targetNodeId);

    return {
      routes: sampledRoutes.map((routeNodeIds, index) => this.#routeVariant(routeNodeIds, index)),
      totalRoutesFound: this.#countShortestRoutes(routeDag, startNodeId, targetNodeId, shortestLength),
      displayedRoutes: sampledRoutes.length
    };
  }

  #buildShortestRouteDag(
    startNodeId: number,
    targetNodeId: number,
    shortestLength: number
  ): ShortestRouteDag {
    const forwardStamp = this.#nextScratchStamp();
    const reverseStamp = this.#nextScratchStamp();

    this.#runBoundedBfs(
      startNodeId,
      shortestLength,
      this.#artifact.graph.forwardOffsets,
      this.#artifact.graph.forwardAdjacency,
      this.#scratch.forwardMark,
      this.#scratch.forwardDistance,
      this.#scratch.forwardQueue,
      forwardStamp
    );
    this.#runBoundedBfs(
      targetNodeId,
      shortestLength,
      this.#artifact.graph.reverseOffsets,
      this.#artifact.graph.reverseAdjacency,
      this.#scratch.reverseMark,
      this.#scratch.reverseDistance,
      this.#scratch.reverseQueue,
      reverseStamp,
      (nodeId, depth) =>
        this.#scratch.forwardMark[nodeId] === forwardStamp &&
        this.#scratch.forwardDistance[nodeId]! + depth <= shortestLength
    );

    const routeDag: ShortestRouteDag = {
      depthBuckets: Array.from({ length: shortestLength + 1 }, () => [] as number[]),
      successorsByNode: new Map<number, number[]>()
    };
    const queue = [startNodeId];
    const queued = new Set<number>(queue);
    routeDag.depthBuckets[0]!.push(startNodeId);
    let head = 0;

    while (head < queue.length) {
      const nodeId = queue[head]!;
      head += 1;
      const neighbors = this.#shortestRouteNeighbors(
        nodeId,
        shortestLength,
        forwardStamp,
        reverseStamp
      );
      if (neighbors.length > 0) {
        routeDag.successorsByNode.set(nodeId, neighbors);
      }

      for (const neighbor of neighbors) {
        if (queued.has(neighbor)) {
          continue;
        }
        queued.add(neighbor);
        routeDag.depthBuckets[this.#scratch.forwardDistance[neighbor]!]!.push(neighbor);
        queue.push(neighbor);
      }
    }

    return routeDag;
  }

  #collectDisplayedRoutes(
    routeDag: ShortestRouteDag,
    startNodeId: number,
    targetNodeId: number,
    preferredFirstRoute?: number[] | null
  ): number[][] {
    const sampledRoutes: number[][] = [];
    const seenRouteKeys = new Set<string>();

    if (preferredFirstRoute && preferredFirstRoute.length > 0) {
      sampledRoutes.push([...preferredFirstRoute]);
      seenRouteKeys.add(preferredFirstRoute.join("->"));
    }

    const currentPath = [startNodeId];
    const collectRoutes = (nodeId: number): void => {
      if (sampledRoutes.length >= appConfig.maxDisplayedRoutes) {
        return;
      }

      if (nodeId === targetNodeId) {
        const routeKey = currentPath.join("->");
        if (!seenRouteKeys.has(routeKey)) {
          sampledRoutes.push([...currentPath]);
          seenRouteKeys.add(routeKey);
        }
        return;
      }

      for (const neighbor of routeDag.successorsByNode.get(nodeId) ?? []) {
        currentPath.push(neighbor);
        collectRoutes(neighbor);
        currentPath.pop();
        if (sampledRoutes.length >= appConfig.maxDisplayedRoutes) {
          return;
        }
      }
    };

    collectRoutes(startNodeId);
    return sampledRoutes.slice(0, appConfig.maxDisplayedRoutes);
  }

  #countShortestRoutes(
    routeDag: ShortestRouteDag,
    startNodeId: number,
    targetNodeId: number,
    shortestLength: number
  ): string {
    const routeCountMemo = new Map<number, number | bigint>();
    const addRouteCounts = (left: number | bigint, right: number | bigint): number | bigint => {
      if (typeof left === "number" && typeof right === "number") {
        const total = left + right;
        if (Number.isSafeInteger(total)) {
          return total;
        }
        return BigInt(left) + BigInt(right);
      }
      return BigInt(left) + BigInt(right);
    };

    routeCountMemo.set(targetNodeId, 1);
    for (let depth = shortestLength - 1; depth >= 0; depth -= 1) {
      for (const nodeId of routeDag.depthBuckets[depth] ?? []) {
        let total: number | bigint = 0;
        for (const neighbor of routeDag.successorsByNode.get(nodeId) ?? []) {
          total = addRouteCounts(total, routeCountMemo.get(neighbor) ?? 0);
        }
        routeCountMemo.set(nodeId, total);
      }
    }

    return String(routeCountMemo.get(startNodeId) ?? 0);
  }

  #runBoundedBfs(
    startNodeId: number,
    maxDepth: number,
    offsets: Uint32Array,
    adjacency: Uint32Array,
    marks: Uint32Array,
    distances: Int32Array,
    queue: Uint32Array,
    stamp: number,
    canVisit?: (nodeId: number, depth: number) => boolean
  ): number {
    let head = 0;
    let tail = 1;
    queue[0] = startNodeId;
    marks[startNodeId] = stamp;
    distances[startNodeId] = 0;

    while (head < tail) {
      const nodeId = queue[head]!;
      head += 1;
      const depth = distances[nodeId]!;
      if (depth >= maxDepth) {
        continue;
      }

      for (let edgeIndex = offsets[nodeId]!; edgeIndex < (offsets[nodeId + 1] ?? 0); edgeIndex += 1) {
        const neighbor = adjacency[edgeIndex]!;
        if (marks[neighbor] === stamp) {
          continue;
        }
        if (canVisit && !canVisit(neighbor, depth + 1)) {
          continue;
        }

        marks[neighbor] = stamp;
        distances[neighbor] = depth + 1;
        queue[tail] = neighbor;
        tail += 1;
      }
    }

    return tail;
  }

  #shortestRouteNeighbors(
    nodeId: number,
    shortestLength: number,
    forwardStamp: number,
    reverseStamp: number
  ): number[] {
    if (this.#scratch.forwardMark[nodeId] !== forwardStamp) {
      return [];
    }

    const neighbors: number[] = [];
    const sourceDistance = this.#scratch.forwardDistance[nodeId]!;
    const { forwardOffsets, forwardAdjacency } = this.#artifact.graph;

    for (
      let edgeIndex = forwardOffsets[nodeId]!;
      edgeIndex < (forwardOffsets[nodeId + 1] ?? 0);
      edgeIndex += 1
    ) {
      const neighbor = forwardAdjacency[edgeIndex]!;
      if (this.#scratch.forwardMark[neighbor] !== forwardStamp) {
        continue;
      }
      if (this.#scratch.reverseMark[neighbor] !== reverseStamp) {
        continue;
      }

      const forwardDistance = this.#scratch.forwardDistance[neighbor]!;
      const reverseDistance = this.#scratch.reverseDistance[neighbor]!;
      if (forwardDistance !== sourceDistance + 1) {
        continue;
      }
      if (sourceDistance + 1 + reverseDistance !== shortestLength) {
        continue;
      }

      neighbors.push(neighbor);
    }

    return neighbors;
  }

  #routeVariant(routeNodeIds: number[], routeIndex: number): RouteVariant {
    return {
      routeIndex,
      pathNodeIds: routeNodeIds,
      pathTitles: routeNodeIds.map((nodeId) => this.canonicalTitleForNode(nodeId)),
      pathNodes: routeNodeIds.map((nodeId, index, ids) => this.nodeMetadata(nodeId, index, ids.length))
    };
  }

  #reconstructPath(meetingNodeId: number, startNodeId: number, targetNodeId: number): number[] {
    const { forwardParent, reverseParent } = this.#scratch;

    const left: number[] = [];
    let cursor = meetingNodeId;
    while (cursor !== -1) {
      left.push(cursor);
      cursor = forwardParent[cursor]!;
    }
    left.reverse();

    const right: number[] = [];
    cursor = reverseParent[meetingNodeId]!;
    while (cursor !== -1) {
      right.push(cursor);
      cursor = reverseParent[cursor]!;
    }

    const path = left.concat(right);
    if (path[0] !== startNodeId || path[path.length - 1] !== targetNodeId) {
      throw new Error("Path reconstruction failed integrity check.");
    }

    return path;
  }
}

function readStringChunks(manifest: ChunkManifest): string[] {
  const items: string[] = [];
  for (const file of manifest.files) {
    const chunk = v8.deserialize(fs.readFileSync(path.join(appConfig.artifactRootDir, file))) as string[];
    for (const value of chunk) {
      items.push(value);
    }
  }
  return items;
}

function readUint32Chunks(manifest: ChunkManifest): Uint32Array {
  const values = new Uint32Array(manifest.length);
  let offset = 0;
  for (const file of manifest.files) {
    const buffer = fs.readFileSync(path.join(appConfig.artifactRootDir, file));
    const chunk = new Uint32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / Uint32Array.BYTES_PER_ELEMENT);
    values.set(chunk, offset);
    offset += chunk.length;
  }
  return values;
}

function readUint8Chunks(manifest: ChunkManifest): Uint8Array {
  const values = new Uint8Array(manifest.length);
  let offset = 0;
  for (const file of manifest.files) {
    const buffer = fs.readFileSync(path.join(appConfig.artifactRootDir, file));
    const chunk = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    values.set(chunk, offset);
    offset += chunk.length;
  }
  return values;
}
