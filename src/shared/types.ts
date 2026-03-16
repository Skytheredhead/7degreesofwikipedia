export interface DumpFileInfo {
  path: string;
  size: number;
  mtimeMs: number;
}

export interface DumpPaths {
  page: string;
  redirect: string;
  linktarget: string;
  pagelinks: string;
}

export interface ResolvedArticle {
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

export interface SuggestionResult {
  title: string;
  canonicalTitle: string;
  canonicalId: number;
  displayTitle: string;
  wikipediaUrl: string;
  viaRedirect: boolean;
  kind: "canonical" | "redirect";
}

export interface PathNodeMetadata {
  articleId: number;
  canonicalTitle: string;
  displayTitle: string;
  wikipediaUrl: string;
  position: number;
  role: "start" | "intermediate" | "end";
  distanceFromStart: number;
  normalizedDistanceRatio: number;
}

export interface RouteVariant {
  routeIndex: number;
  pathNodeIds: number[];
  pathTitles: string[];
  pathNodes: PathNodeMetadata[];
}

export interface PathSearchMetrics {
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
}

export type PathFailureReason = "unresolved_start" | "unresolved_end" | "unresolved_both" | "no_path" | null;

export interface PathResult {
  found: boolean;
  cached: boolean;
  from: ResolvedArticle;
  to: ResolvedArticle;
  routes: RouteVariant[] | null;
  totalRoutesFound: string | null;
  displayedRoutes: number;
  pathNodeIds: number[] | null;
  pathTitles: string[] | null;
  pathNodes: PathNodeMetadata[] | null;
  pathLength: number | null;
  metrics: PathSearchMetrics;
}

export interface ResolvedArticleResponse {
  query: string;
  found: boolean;
  result: ResolvedArticle | null;
}

export interface SuggestTitlesResponse {
  query: string;
  limit: number;
  count: number;
  suggestions: SuggestionResult[];
}

export interface PathSearchResponse {
  searchId: string;
  searchedAt: string;
  stage: "initial" | "routes" | "complete";
  partial: boolean;
  request: {
    from: string;
    to: string;
  };
  resolution: {
    from: ResolvedArticleResponse;
    to: ResolvedArticleResponse;
    redirectsApplied: boolean;
  };
  found: boolean;
  success: boolean;
  failureReason: PathFailureReason;
  cached: boolean;
  routes: RouteVariant[] | null;
  totalRoutesFound: string | null;
  displayedRoutes: number;
  pathLength: number | null;
  pathNodeIds: number[] | null;
  pathTitles: string[] | null;
  pathNodes: PathNodeMetadata[] | null;
  metrics: PathSearchMetrics;
}

export interface PathSearchStreamEvent {
  type: "result";
  response: PathSearchResponse;
}

export interface RuntimeArtifact {
  version: number;
  builtAt: string;
  dumpFiles: Record<string, DumpFileInfo>;
  counts: {
    canonicalNodes: number;
    aliases: number;
    redirects: number;
    edges: number;
  };
  graph: {
    forwardOffsets: Uint32Array;
    forwardAdjacency: Uint32Array;
    reverseOffsets: Uint32Array;
    reverseAdjacency: Uint32Array;
  };
  titles: {
    canonicalTitles: string[];
    canonicalSearchKeys: string[];
    aliasTitles: string[];
    aliasSearchKeys: string[];
    aliasTargetNodeIds: Uint32Array;
    aliasKinds: Uint8Array;
    sortedAliasIndices: Uint32Array;
    prefixBuckets: Record<string, [number, number]>;
    exactAliasBuckets: Map<string, Map<string, number>>;
  };
}

export interface SearchRecord {
  id: string;
  timestamp: string;
  fromQuery: string;
  toQuery: string;
  fromCanonicalId: number | null;
  toCanonicalId: number | null;
  fromCanonicalTitle: string | null;
  toCanonicalTitle: string | null;
  fromMatchedTitle: string | null;
  toMatchedTitle: string | null;
  fromRedirectApplied: boolean;
  toRedirectApplied: boolean;
  success: boolean;
  failureReason: PathFailureReason;
  cached: boolean;
  durationMs: number;
  firstRouteMs: number;
  pathLength: number | null;
  nodesVisited: number;
  nodesExpanded: number;
  frontierExpansions: number;
  forwardVisited: number;
  reverseVisited: number;
  pathNodeIds: number[] | null;
  pathTitles: string[] | null;
}

export interface HistogramState {
  bounds: number[];
  counts: number[];
  total: number;
}

export interface AggregateSearchStats {
  totalSearches: number;
  successfulSearches: number;
  failedSearches: number;
  cachedSearches: number;
  totalDurationMs: number;
  totalFirstRouteMs: number;
  firstRouteSampleCount: number;
  totalNodesVisited: number;
  totalNodesExpanded: number;
  totalPathLength: number;
  successfulPathCount: number;
  fastestSearch: SearchRecord | null;
  slowestSearch: SearchRecord | null;
  longestPathSearch: SearchRecord | null;
  shortestNonTrivialPathSearch: SearchRecord | null;
  durationHistogram: HistogramState;
  pathLengthHistogram: HistogramState;
  startArticleCounts: Record<string, number>;
  endArticleCounts: Record<string, number>;
  pairCounts: Record<string, number>;
  successfulPairCounts: Record<string, number>;
  failedPairCounts: Record<string, number>;
  connectorCounts: Record<string, number>;
  firstHopCounts: Record<string, number>;
  lastHopCounts: Record<string, number>;
  redirectCounts: Record<string, number>;
}
