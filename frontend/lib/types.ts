export interface ArticleSuggestion {
  title: string;
  canonicalTitle: string;
  displayTitle: string;
  wikipediaUrl: string;
  viaRedirect: boolean;
  kind: "canonical" | "redirect";
}

export interface ArticleNode {
  id: string;
  articleId: number;
  title: string;
  canonicalTitle: string;
  displayTitle: string;
  url: string;
  role: "start" | "intermediate" | "end";
  isStart: boolean;
  isEnd: boolean;
  index: number;
  distanceFromStart: number;
  normalizedDistanceRatio: number;
}

export interface RouteVariant {
  routeIndex: number;
  path: ArticleNode[];
}

export interface ResolvedInput {
  query: string;
  found: boolean;
  matchedTitle: string | null;
  canonicalTitle: string | null;
  viaRedirect: boolean;
}

export interface SearchResult {
  searchId: string;
  searchedAt: Date;
  partial: boolean;
  path: ArticleNode[];
  routes: RouteVariant[];
  totalRoutesFound: string | null;
  displayedRoutes: number;
  pathLength: number;
  nodesVisited: number;
  loadTimeMs: number;
  cacheHit: boolean;
  found: boolean;
  success: boolean;
  failureReason: string | null;
  redirectsApplied: boolean;
  diagnostics: {
    resolutionMs: number;
    bfsMs: number;
    routeEnumerationMs: number;
    totalRequestMs: number;
    firstRouteMs: number;
    lastRouteMs: number;
    nodesExpanded: number;
    frontierExpansions: number;
    forwardVisited: number;
    reverseVisited: number;
  };
  start: ResolvedInput;
  end: ResolvedInput;
}

export interface RecentSearch {
  id: string;
  start: string;
  end: string;
  pathLength: number | null;
  ms: number;
  timestamp: Date;
  found: boolean;
  cacheHit: boolean;
}

export interface StatData {
  totalSearches: number;
  successfulSearches: number;
  failedSearches: number;
  fastestMs: number;
  slowestMs: number;
  averageMs: number;
  averageFirstRouteMs: number;
  cacheHitRate: number;
  topConnector: string;
  mostFrequentBridge: string;
  recentSearches: RecentSearch[];
}

export interface ReadinessState {
  status: "ready" | "loading" | "unreachable";
  ready: boolean;
  graphLoaded: boolean;
  preloadComplete: boolean;
  searchReady: boolean;
  buildReady: boolean;
  totalNodes: number;
  errorMessage: string | null;
}

export interface StatsOverview {
  stats: StatData;
  recentSearches: RecentSearch[];
}
