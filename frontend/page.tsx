// app/page.tsx
'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';

import Background from './Background';
import ConstellationGraph from './ConstellationGraph';
import SearchUI from './SearchUI';
import SettingsPanel, { SettingsButton } from './SettingsPanel';
import StatsPanel, { StatsButton } from './StatsPanel';
import { fetchArticleSuggestions, fetchReadiness, fetchStatsOverview, runPathSearchProgressive } from './lib/api';
import type {
  ArticleNode,
  ReadinessState,
  RecentSearch,
  SearchResult,
  StatData
} from './lib/types';

type SearchState = 'idle' | 'loading' | 'result' | 'error';
const GRAPH_VIEWBOX_WIDTH = 1200;
const GRAPH_VIEWBOX_HEIGHT = 700;
const GRAPH_SECTION_TOP = 340;
const SEARCH_TO_GRAPH_GAP = 72;

function formatMs(ms: number): string {
  if (ms < 1000) {
    return `${Math.max(1, Math.round(ms))}ms`;
  }
  return `${(ms / 1000).toFixed(2)}s`;
}

function createEmptyStats(): StatData {
  return {
    totalSearches: 0,
    successfulSearches: 0,
    failedSearches: 0,
    fastestMs: 0,
    slowestMs: 0,
    averageMs: 0,
    cacheHitRate: 0,
    topConnector: 'No searches yet',
    mostFrequentBridge: 'No searches yet',
    recentSearches: [],
  };
}

function createUnavailableReadiness(): ReadinessState {
  return {
    status: 'unreachable',
    ready: false,
    graphLoaded: false,
    preloadComplete: false,
    searchReady: false,
    buildReady: false,
    totalNodes: 0,
    errorMessage: 'Frontend could not reach the backend API.',
  };
}

function applyRouteDisplayLimit(result: SearchResult | null, routeLimit: number): SearchResult | null {
  if (!result || !result.success || result.routes.length === 0) {
    return result;
  }

  const limitedRoutes = result.routes.slice(0, Math.max(1, routeLimit));
  const primaryPath = limitedRoutes[0]?.path ?? result.path;

  return {
    ...result,
    routes: limitedRoutes,
    path: primaryPath,
    displayedRoutes: limitedRoutes.length
  };
}

function countRenderedGraphNodes(result: SearchResult | null): number {
  if (!result || !result.success) {
    return 0;
  }

  const seen = new Set<string>();
  const routes = result.routes.length > 0 ? result.routes : [{ routeIndex: 0, path: result.path }];
  for (const route of routes) {
    for (const node of route.path) {
      seen.add(`${node.articleId}:${node.distanceFromStart ?? node.index}`);
    }
  }
  return seen.size;
}

function buildSearchHelper(result: SearchResult | null, readiness: ReadinessState | null): {
  text: string | null;
  tone: 'default' | 'error';
} {
  if (readiness?.status === 'unreachable') {
    return {
      text: readiness.errorMessage ?? 'Frontend could not reach the backend API.',
      tone: 'error',
    };
  }

  if (readiness?.status === 'loading') {
    return {
      text: 'Backend is still loading the graph into RAM.',
      tone: 'default',
    };
  }

  if (result?.success && result.partial) {
    return {
      text: `First shortest path found in ${formatMs(result.diagnostics.firstRouteMs)}. Mapping the rest...`,
      tone: 'default',
    };
  }

  if (!result || result.success) {
    return {
      text: null,
      tone: 'default',
    };
  }

  switch (result.failureReason) {
    case 'unresolved_both':
      return {
        text: 'Origin and destination articles not found.',
        tone: 'error',
      };
    case 'unresolved_start':
      return {
        text: 'Origin article not found.',
        tone: 'error',
      };
    case 'unresolved_end':
      return {
        text: 'Destination article not found.',
        tone: 'error',
      };
    case 'no_path':
      return {
        text: 'No shortest route could be found between those articles.',
        tone: 'error',
      };
    case 'request_failed':
      return {
        text: 'Search request failed. Please try again.',
        tone: 'error',
      };
    default:
      return {
        text: 'Search failed.',
        tone: 'error',
      };
  }
}

function ResultMeta({
  result,
  totalNodes
}: {
  result: SearchResult | null;
  totalNodes: number;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailsCardRef = useRef<HTMLDivElement | null>(null);
  const detailsButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    setDetailsOpen(false);
  }, [result?.searchId]);

  useEffect(() => {
    if (!detailsOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      if (detailsCardRef.current?.contains(target) || detailsButtonRef.current?.contains(target)) {
        return;
      }
      setDetailsOpen(false);
    };

    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [detailsOpen]);

  if (!result || !result.success) {
    return null;
  }

  const totalRenderedNodes = countRenderedGraphNodes(result);
  const totalRoutesLabel =
    result.partial
      ? 'finding the rest of the shortest routes'
      : result.totalRoutesFound === null
        ? 'counting routes'
        : result.totalRoutesFound === '1'
          ? '1 total route'
          : `${result.totalRoutesFound} total routes`;

  return (
    <motion.div
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      style={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        alignItems: 'center',
        gap: 10,
        fontFamily: 'var(--font-azeret), monospace',
        fontSize: 10,
        letterSpacing: '0.8px',
        color: 'rgba(150,155,185,0.72)',
        userSelect: 'none',
        overflow: 'visible',
      }}
    >
      <AnimatePresence>
        {detailsOpen && (
          <div
            style={{
              position: 'absolute',
              left: '50%',
              bottom: 'calc(100% + 12px)',
              transform: 'translateX(-50%)',
              width: 'min(560px, 92vw)',
              zIndex: 40,
              pointerEvents: 'auto',
            }}
          >
            <motion.div
              ref={detailsCardRef}
              initial={{ opacity: 0, y: 6, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 4, scale: 0.98 }}
              transition={{ duration: 0.16, ease: 'easeOut' }}
              style={{
                background: 'rgba(8,9,18,0.94)',
                border: '1px solid rgba(170,175,215,0.16)',
                borderRadius: 8,
                padding: '12px 14px',
                boxShadow: '0 16px 48px rgba(0,0,0,0.45)',
                backdropFilter: 'blur(16px)',
                color: 'rgba(192,198,228,0.82)',
              }}
            >
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
                  gap: 10,
                }}
              >
                <div>Total: <span style={{ color: 'rgba(235,239,255,0.96)' }}>{formatMs(result.diagnostics.totalRequestMs)}</span></div>
                <div>First route: <span style={{ color: 'rgba(235,239,255,0.96)' }}>{formatMs(result.diagnostics.firstRouteMs)}</span></div>
                <div>Last route: <span style={{ color: 'rgba(235,239,255,0.96)' }}>{formatMs(result.diagnostics.lastRouteMs)}</span></div>
                <div>Resolution: <span style={{ color: 'rgba(235,239,255,0.96)' }}>{formatMs(result.diagnostics.resolutionMs)}</span></div>
                <div>BFS traversal: <span style={{ color: 'rgba(235,239,255,0.96)' }}>{formatMs(result.diagnostics.bfsMs)}</span></div>
                <div>Route counting: <span style={{ color: 'rgba(235,239,255,0.96)' }}>{formatMs(result.diagnostics.routeEnumerationMs)}</span></div>
                <div>Displayed routes: <span style={{ color: 'rgba(235,239,255,0.96)' }}>{result.displayedRoutes}</span></div>
                <div>Total routes: <span style={{ color: 'rgba(235,239,255,0.96)' }}>{result.totalRoutesFound ?? 'counting'}</span></div>
                <div>Total nodes: <span style={{ color: 'rgba(235,239,255,0.96)' }}>{totalNodes > 0 ? totalNodes.toLocaleString() : totalRenderedNodes.toLocaleString()}</span></div>
                <div>Rendered nodes: <span style={{ color: 'rgba(235,239,255,0.96)' }}>{totalRenderedNodes.toLocaleString()}</span></div>
                <div>Cache: <span style={{ color: 'rgba(235,239,255,0.96)' }}>{result.cacheHit ? 'hit' : 'miss'}</span></div>
                <div>Nodes expanded: <span style={{ color: 'rgba(235,239,255,0.96)' }}>{result.diagnostics.nodesExpanded.toLocaleString()}</span></div>
                <div>Frontier expansions: <span style={{ color: 'rgba(235,239,255,0.96)' }}>{result.diagnostics.frontierExpansions.toLocaleString()}</span></div>
                <div>Forward visited: <span style={{ color: 'rgba(235,239,255,0.96)' }}>{result.diagnostics.forwardVisited.toLocaleString()}</span></div>
                <div>Reverse visited: <span style={{ color: 'rgba(235,239,255,0.96)' }}>{result.diagnostics.reverseVisited.toLocaleString()}</span></div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 14,
        }}
      >
        <span style={{ color: 'rgba(224,228,250,0.95)' }}>{formatMs(result.loadTimeMs)}</span>
        <span>first path in {formatMs(result.diagnostics.firstRouteMs)}</span>
        <span>{result.pathLength} hops</span>
        <span>{totalRoutesLabel}</span>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <span>{result.nodesVisited.toLocaleString()} nodes visited</span>
          <button
            ref={detailsButtonRef}
            onClick={() => setDetailsOpen((open) => !open)}
            title="Search diagnostics"
            style={{
              width: 16,
              height: 16,
              borderRadius: '50%',
              border: '1px solid rgba(170,175,210,0.28)',
              background: detailsOpen ? 'rgba(170,175,210,0.16)' : 'transparent',
              color: 'rgba(215,220,245,0.82)',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              padding: 0,
              lineHeight: 0,
            }}
          >
            <svg width="8" height="8" viewBox="0 0 8 8" fill="none" aria-hidden="true">
              <circle cx="4" cy="1.6" r="0.8" fill="currentColor" />
              <path d="M4 3.1V6.2" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
            </svg>
          </button>
        </span>
      </div>
    </motion.div>
  );
}

function RecentSearches({ searches, onSelect }: { searches: RecentSearch[]; onSelect: (from: string, to: string) => void }) {
  if (searches.length === 0) {
    return (
      <div
        style={{
          fontFamily: 'var(--font-azeret), monospace',
          fontSize: 10,
          letterSpacing: '1px',
          color: 'rgba(95,100,130,0.65)',
          textTransform: 'uppercase',
        }}
      >
        No history yet
      </div>
    );
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'stretch',
        gap: 10,
      }}
    >
      {searches.slice(0, 8).map((search) => (
        <button
          key={search.id}
          onClick={() => onSelect(search.start, search.end)}
          style={{
            background: 'transparent',
            border: 'none',
            color: 'rgba(206,211,240,0.86)',
            cursor: 'pointer',
            fontFamily: 'var(--font-syne), sans-serif',
            fontSize: 11,
            padding: '6px 8px',
            textAlign: 'left',
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
            borderRadius: 6,
            transition: 'transform 0.18s ease, background 0.18s ease, color 0.18s ease',
          }}
          onMouseEnter={(event) => {
            event.currentTarget.style.transform = 'translateX(4px)';
            event.currentTarget.style.background = 'rgba(170,175,215,0.08)';
            event.currentTarget.style.color = 'rgba(236,240,255,0.98)';
          }}
          onMouseLeave={(event) => {
            event.currentTarget.style.transform = 'translateX(0)';
            event.currentTarget.style.background = 'transparent';
            event.currentTarget.style.color = 'rgba(206,211,240,0.86)';
          }}
        >
          <span>{search.start} {'->'} {search.end}</span>
          <span
            style={{
              fontFamily: 'var(--font-azeret), monospace',
              fontSize: 9,
              letterSpacing: '0.5px',
              color: 'rgba(150,155,188,0.72)',
            }}
          >
            {search.pathLength ?? 'n/a'} hops · {search.ms}ms
          </span>
        </button>
      ))}
    </div>
  );
}

function HistoryButton({
  onClick,
  isOpen,
  buttonRef
}: {
  onClick: () => void;
  isOpen: boolean;
  buttonRef?: { current: HTMLButtonElement | null };
}) {
  return (
    <button
      ref={buttonRef}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={onClick}
      title="History"
      style={{
        position: 'fixed',
        bottom: 'calc(20px + env(safe-area-inset-bottom))',
        left: 20,
        width: 38,
        height: 38,
        borderRadius: '50%',
        background: isOpen ? 'rgba(160,165,210,0.12)' : 'rgba(8,9,18,0.8)',
        border: `1px solid ${isOpen ? 'rgba(190,195,235,0.35)' : 'rgba(140,145,185,0.2)'}`,
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 420,
        transition: 'all 0.2s',
        backdropFilter: 'blur(10px)',
      }}
      onMouseEnter={(event) => {
        event.currentTarget.style.borderColor = 'rgba(200,205,240,0.4)';
        event.currentTarget.style.background = 'rgba(160,165,210,0.1)';
      }}
      onMouseLeave={(event) => {
        if (!isOpen) {
          event.currentTarget.style.borderColor = 'rgba(140,145,185,0.2)';
          event.currentTarget.style.background = 'rgba(8,9,18,0.8)';
        }
      }}
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <path
          d="M3.5 2.5h7a2 2 0 0 1 2 2v8.5l-2.7-1.6a1.6 1.6 0 0 0-1.6 0L5.5 13V4.5a2 2 0 0 1 2-2Z"
          stroke="rgba(214,218,246,0.82)"
          strokeWidth="1.2"
          strokeLinejoin="round"
        />
        <path
          d="M6 5.5h4.2M6 7.8h4.2"
          stroke="rgba(176,181,220,0.68)"
          strokeWidth="1.1"
          strokeLinecap="round"
        />
      </svg>
    </button>
  );
}

function HistoryPanel({
  searches,
  onClose,
  onSelect,
  buttonRef
}: {
  searches: RecentSearch[];
  onClose: () => void;
  onSelect: (from: string, to: string) => void;
  buttonRef?: { current: HTMLButtonElement | null };
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      if (panelRef.current?.contains(target)) {
        return;
      }
      if (buttonRef?.current?.contains(target)) {
        return;
      }
      onClose();
    };

    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [buttonRef, onClose]);

  return (
    <motion.div
      ref={panelRef}
      initial={{ opacity: 0, y: 12, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 8, scale: 0.97 }}
      transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
      style={{
        position: 'fixed',
        bottom: 'calc(66px + env(safe-area-inset-bottom))',
        left: 20,
        width: 320,
        maxWidth: 'calc(100vw - 40px)',
        background: 'rgba(7,8,16,0.94)',
        border: '1px solid rgba(170,175,215,0.15)',
        borderRadius: 8,
        padding: '16px 18px',
        zIndex: 500,
        boxShadow: '0 16px 64px rgba(0,0,0,0.7), 0 0 0 1px rgba(130,135,175,0.06)',
        backdropFilter: 'blur(20px)',
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 14,
        }}
      >
        <span
          style={{
            fontFamily: 'var(--font-azeret), monospace',
            fontSize: 9,
            letterSpacing: '2px',
            textTransform: 'uppercase',
            color: 'rgba(160,165,200,0.7)',
          }}
        >
          History
        </span>
        <button
          onClick={onClose}
          style={{
            background: 'transparent',
            border: 'none',
            color: 'rgba(140,145,180,0.5)',
            cursor: 'pointer',
            padding: 2,
            fontSize: 16,
            lineHeight: 1,
          }}
        >
          ×
        </button>
      </div>
      <RecentSearches searches={searches} onSelect={onSelect} />
    </motion.div>
  );
}

export default function Home() {
  const [searchState, setSearchState] = useState<SearchState>('idle');
  const [startValue, setStartValue] = useState('');
  const [endValue, setEndValue] = useState('');
  const [committedStartValue, setCommittedStartValue] = useState('');
  const [committedEndValue, setCommittedEndValue] = useState('');
  const [result, setResult] = useState<SearchResult | null>(null);
  const [statsOpen, setStatsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [recentSearches, setRecentSearches] = useState<RecentSearch[]>([]);
  const [stats, setStats] = useState<StatData>(createEmptyStats());
  const [readiness, setReadiness] = useState<ReadinessState | null>(null);
  const [graphScale, setGraphScale] = useState(1);
  const [routeLimit, setRouteLimit] = useState(5);
  const [wireSpeed, setWireSpeed] = useState(1);
  const [nodeDrift, setNodeDrift] = useState(1);
  const [graphTopAnchorY, setGraphTopAnchorY] = useState<number | null>(null);
  const [graphViewportSize, setGraphViewportSize] = useState({ width: 0, height: 0 });
  const [searchBlockHeight, setSearchBlockHeight] = useState(0);
  const [viewportWidth, setViewportWidth] = useState(0);
  const graphViewportRef = useRef<HTMLDivElement | null>(null);
  const searchBlockRef = useRef<HTMLDivElement | null>(null);
  const historyButtonRef = useRef<HTMLButtonElement | null>(null);
  const statsButtonRef = useRef<HTMLButtonElement | null>(null);
  const settingsButtonRef = useRef<HTMLButtonElement | null>(null);
  const searchAbortRef = useRef<AbortController | null>(null);
  const searchRunIdRef = useRef(0);

  const refreshBackendState = useCallback(async () => {
    const [statsResult, readinessResult] = await Promise.allSettled([
      fetchStatsOverview(),
      fetchReadiness(),
    ]);

    if (statsResult.status === 'fulfilled') {
      setStats(statsResult.value.stats);
      setRecentSearches(statsResult.value.recentSearches);
    } else {
      console.error('Stats refresh failed:', statsResult.reason);
      setStats(createEmptyStats());
      setRecentSearches([]);
    }

    if (readinessResult.status === 'fulfilled') {
      setReadiness(readinessResult.value);
      return;
    }

    console.error('Readiness refresh failed:', readinessResult.reason);
    const fallback = createUnavailableReadiness();
    fallback.errorMessage =
      readinessResult.reason instanceof Error
        ? readinessResult.reason.message
        : 'Frontend could not reach the backend API.';
    setReadiness(fallback);
  }, []);

  useEffect(() => {
    void refreshBackendState();
  }, [refreshBackendState]);

  useEffect(() => {
    if (readiness?.status === 'ready') {
      return;
    }

    const intervalId = window.setInterval(() => {
      void refreshBackendState();
    }, 2000);

    return () => window.clearInterval(intervalId);
  }, [readiness?.status, refreshBackendState]);

  useEffect(() => {
    const updateViewportWidth = () => {
      setViewportWidth(window.innerWidth);
    };

    updateViewportWidth();
    window.addEventListener('resize', updateViewportWidth);
    return () => window.removeEventListener('resize', updateViewportWidth);
  }, []);

  useEffect(() => {
    const element = graphViewportRef.current;
    if (!element) {
      return;
    }

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) {
        return;
      }
      setGraphViewportSize({
        width: entry.contentRect.width,
        height: entry.contentRect.height
      });
    });

    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const element = searchBlockRef.current;
    if (!element) {
      return;
    }

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) {
        return;
      }
      setSearchBlockHeight(entry.contentRect.height);
    });

    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const handleSearch = useCallback(async (overrides?: { start?: string; end?: string }) => {
    const nextStartValue = (overrides?.start ?? startValue).trim() || committedStartValue.trim();
    const nextEndValue = (overrides?.end ?? endValue).trim() || committedEndValue.trim();

    if (!nextStartValue || !nextEndValue) {
      return;
    }

    searchAbortRef.current?.abort();
    const abortController = new AbortController();
    searchAbortRef.current = abortController;
    searchRunIdRef.current += 1;
    const searchRunId = searchRunIdRef.current;
    setResult(null);
    setSearchState('loading');

    try {
      const nextResult = await runPathSearchProgressive(nextStartValue, nextEndValue, {
        signal: abortController.signal,
        onUpdate: (incomingResult) => {
          if (searchRunIdRef.current !== searchRunId) {
            return;
          }
          setResult(incomingResult);
          const resolvedStartValue = incomingResult.start.canonicalTitle ?? nextStartValue;
          const resolvedEndValue = incomingResult.end.canonicalTitle ?? nextEndValue;
          setCommittedStartValue(resolvedStartValue);
          setCommittedEndValue(resolvedEndValue);
          setStartValue(resolvedStartValue);
          setEndValue(resolvedEndValue);
          setSearchState(
            incomingResult.partial ? 'loading' : incomingResult.success ? 'result' : 'error'
          );
        }
      });
      if (searchRunIdRef.current !== searchRunId) {
        return;
      }
      setSearchState(nextResult.success ? 'result' : 'error');
      await refreshBackendState().catch((refreshError) => {
        console.error('Backend state refresh failed after search:', refreshError);
      });
    } catch (error) {
      if (abortController.signal.aborted) {
        return;
      }
      console.error('Search failed:', error);
      setResult({
        searchId: crypto.randomUUID(),
        searchedAt: new Date(),
        partial: false,
        path: [],
        routes: [],
        totalRoutesFound: null,
        displayedRoutes: 0,
        pathLength: 0,
        nodesVisited: 0,
        loadTimeMs: 0,
        cacheHit: false,
        found: false,
        success: false,
        failureReason: 'request_failed',
        redirectsApplied: false,
        diagnostics: {
          resolutionMs: 0,
          bfsMs: 0,
          routeEnumerationMs: 0,
          totalRequestMs: 0,
          firstRouteMs: 0,
          lastRouteMs: 0,
          nodesExpanded: 0,
          frontierExpansions: 0,
          forwardVisited: 0,
          reverseVisited: 0,
        },
        start: {
          query: nextStartValue,
          found: false,
          matchedTitle: null,
          canonicalTitle: null,
          viaRedirect: false,
        },
        end: {
          query: nextEndValue,
          found: false,
          matchedTitle: null,
          canonicalTitle: null,
          viaRedirect: false,
        },
      });
      setCommittedStartValue(nextStartValue);
      setCommittedEndValue(nextEndValue);
      setStartValue(nextStartValue);
      setEndValue(nextEndValue);
      setSearchState('error');
      await refreshBackendState().catch(() => undefined);
    } finally {
      if (searchAbortRef.current === abortController) {
        searchAbortRef.current = null;
      }
    }
  }, [committedEndValue, committedStartValue, endValue, refreshBackendState, startValue]);

  const handleSwap = useCallback(() => {
    const currentStart = startValue.trim() || committedStartValue.trim();
    const currentEnd = endValue.trim() || committedEndValue.trim();
    if (!currentStart || !currentEnd) {
      return;
    }

    setStartValue(currentEnd);
    setEndValue(currentStart);
    void handleSearch({ start: currentEnd, end: currentStart });
  }, [committedEndValue, committedStartValue, endValue, handleSearch, startValue]);

  const handleNodeClick = useCallback((node: ArticleNode) => {
    window.open(node.url, '_blank', 'noopener,noreferrer');
  }, []);

  const handlePairSelect = useCallback((start: string, end: string) => {
    setStartValue(start);
    setEndValue(end);
    setCommittedStartValue(start);
    setCommittedEndValue(end);
    setHistoryOpen(false);
    setStatsOpen(false);
    setSettingsOpen(false);
    void handleSearch({ start, end });
  }, [handleSearch]);

  const handleStartFocus = useCallback(() => {
    if (!result) {
      return;
    }
    if (startValue.trim() && startValue.trim() === committedStartValue.trim()) {
      setStartValue('');
    }
  }, [committedStartValue, result, startValue]);

  const handleEndFocus = useCallback(() => {
    if (!result) {
      return;
    }
    if (endValue.trim() && endValue.trim() === committedEndValue.trim()) {
      setEndValue('');
    }
  }, [committedEndValue, endValue, result]);

  const handleStartBlur = useCallback(() => {
    if (!result) {
      return;
    }
    if (!startValue.trim() && committedStartValue.trim()) {
      setStartValue(committedStartValue);
    }
  }, [committedStartValue, result, startValue]);

  const handleEndBlur = useCallback(() => {
    if (!result) {
      return;
    }
    if (!endValue.trim() && committedEndValue.trim()) {
      setEndValue(committedEndValue);
    }
  }, [committedEndValue, endValue, result]);

  const handleHomeReset = useCallback(() => {
    searchAbortRef.current?.abort();
    setSearchState('idle');
    setResult(null);
    setStartValue('');
    setEndValue('');
    setCommittedStartValue('');
    setCommittedEndValue('');
    setStatsOpen(false);
    setHistoryOpen(false);
    setSettingsOpen(false);
  }, []);

  const toggleHistoryPanel = useCallback(() => {
    setHistoryOpen((open) => {
      const nextOpen = !open;
      if (nextOpen) {
        setStatsOpen(false);
        setSettingsOpen(false);
      }
      return nextOpen;
    });
  }, []);

  const toggleStatsPanel = useCallback(() => {
    setStatsOpen((open) => {
      const nextOpen = !open;
      if (nextOpen) {
        setHistoryOpen(false);
        setSettingsOpen(false);
      }
      return nextOpen;
    });
  }, []);

  const toggleSettingsPanel = useCallback(() => {
    setSettingsOpen((open) => {
      const nextOpen = !open;
      if (nextOpen) {
        setHistoryOpen(false);
        setStatsOpen(false);
      }
      return nextOpen;
    });
  }, []);

  const routeLimitMax = 100;
  const displayResult = useMemo(
    () => applyRouteDisplayLimit(result, routeLimit),
    [result, routeLimit]
  );
  const isMobileLayout = viewportWidth > 0 ? viewportWidth <= 768 : false;
  const hasResultLayout = Boolean(result);
  const hasGraph = Boolean(displayResult?.success);
  const helper = buildSearchHelper(displayResult, readiness);
  const searchTop = (() => {
    if (isMobileLayout) {
      return 0;
    }
    if (!hasResultLayout) {
      return '58%';
    }
    if (graphTopAnchorY === null || !graphViewportSize.width || !graphViewportSize.height || !searchBlockHeight) {
      return 240;
    }
    const scale = Math.min(
      graphViewportSize.width / GRAPH_VIEWBOX_WIDTH,
      graphViewportSize.height / GRAPH_VIEWBOX_HEIGHT
    );
    const offsetY = (graphViewportSize.height - GRAPH_VIEWBOX_HEIGHT * scale) / 2;
    const anchorY = offsetY + graphTopAnchorY * scale;
    const liftedTop =
      GRAPH_SECTION_TOP +
      anchorY -
      searchBlockHeight -
      SEARCH_TO_GRAPH_GAP;
    return Math.max(140, Math.round(liftedTop));
  })();

  return (
    <>
      <Background />
      <div
        style={{
          position: 'relative',
          zIndex: 1,
          width: '100%',
          minHeight: isMobileLayout ? '100svh' : '100vh',
          overflowX: 'hidden',
          overflowY: isMobileLayout ? 'auto' : 'hidden',
          paddingTop: isMobileLayout ? 'calc(20px + env(safe-area-inset-top))' : 0,
          paddingBottom: isMobileLayout ? 'calc(116px + env(safe-area-inset-bottom))' : 0,
        }}
      >
        <div
          style={{
            position: isMobileLayout ? 'relative' : 'absolute',
            top: isMobileLayout ? undefined : 36,
            left: isMobileLayout ? undefined : 40,
            right: isMobileLayout ? undefined : undefined,
            zIndex: 10,
            display: 'flex',
            justifyContent: isMobileLayout ? 'center' : 'flex-start',
            pointerEvents: 'none',
            padding: isMobileLayout ? '44px 20px 0' : 0,
          }}
        >
          <button
            onClick={handleHomeReset}
            style={{
              background: 'transparent',
              border: 'none',
              padding: 0,
              cursor: 'pointer',
              fontFamily: 'var(--font-syne), sans-serif',
              fontWeight: 800,
              fontSize: isMobileLayout ? 'clamp(2.25rem, 7.8vw, 3rem)' : 24,
              letterSpacing: isMobileLayout ? '-1.1px' : '-0.5px',
              color: isMobileLayout ? 'rgba(240,242,255,0.96)' : 'rgba(228,230,248,0.88)',
              lineHeight: 1,
              transition: 'color 0.2s, opacity 0.2s',
              textAlign: isMobileLayout ? 'center' : 'left',
              maxWidth: isMobileLayout ? 360 : undefined,
              textWrap: 'balance',
              textShadow: isMobileLayout ? '0 0 28px rgba(132, 142, 208, 0.16)' : 'none',
              pointerEvents: 'auto',
            }}
            onMouseEnter={(event) => {
              event.currentTarget.style.color = isMobileLayout
                ? 'rgba(248,249,255,0.98)'
                : 'rgba(240,242,255,0.98)';
            }}
            onMouseLeave={(event) => {
              event.currentTarget.style.color = isMobileLayout
                ? 'rgba(240,242,255,0.96)'
                : 'rgba(228,230,248,0.88)';
            }}
          >
            Seven Degrees of Wikipedia
          </button>
        </div>

        <div
          style={{
            position: isMobileLayout ? 'relative' : 'absolute',
            left: isMobileLayout ? undefined : 0,
            right: isMobileLayout ? undefined : 0,
            zIndex: 20,
            display: 'flex',
            justifyContent: 'center',
            top: isMobileLayout ? undefined : searchTop,
            marginTop: isMobileLayout ? 52 : 0,
            padding: isMobileLayout ? '0 20px' : 0,
          }}
        >
          <motion.div
            ref={searchBlockRef}
            initial={false}
            animate={{
              y: hasResultLayout ? 0 : -28
            }}
            transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
            style={{
              width: isMobileLayout ? 'min(420px, 100%)' : 'min(720px, 92vw)',
              display: 'flex',
              flexDirection: 'column',
              gap: isMobileLayout ? 12 : 14,
            }}
          >
            <SearchUI
              startValue={startValue}
              endValue={endValue}
              startPlaceholder={committedStartValue || 'Article one'}
              endPlaceholder={committedEndValue || 'Article two'}
              onStartChange={setStartValue}
              onEndChange={setEndValue}
              onStartFocus={handleStartFocus}
              onEndFocus={handleEndFocus}
              onStartBlur={handleStartBlur}
              onEndBlur={handleEndBlur}
              onSearch={handleSearch}
              onSwap={handleSwap}
              isLoading={searchState === 'loading'}
              disabled={readiness ? readiness.status !== 'ready' : false}
              helperText={helper.text}
              helperTone={helper.tone}
              getSuggestions={fetchArticleSuggestions}
              isCompactLayout={isMobileLayout}
            />
            <ResultMeta result={displayResult} totalNodes={readiness?.totalNodes ?? 0} />
          </motion.div>
        </div>

        <div
          ref={graphViewportRef}
          style={{
            position: isMobileLayout ? 'relative' : 'absolute',
            inset: isMobileLayout ? undefined : 0,
            top: isMobileLayout ? undefined : 340,
            bottom: isMobileLayout ? undefined : 46,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: isMobileLayout ? '0 20px' : '0 24px',
            marginTop: isMobileLayout ? (hasGraph ? 28 : 0) : 0,
            minHeight: isMobileLayout && hasGraph ? 280 : 0,
            height: isMobileLayout ? (hasGraph ? 'min(46svh, 380px)' : 0) : undefined,
          }}
        >
          <AnimatePresence mode="wait">
            {hasGraph && displayResult ? (
              <motion.div
                key={displayResult.searchId}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.3, ease: 'easeOut' }}
                style={{
                  width: '100%',
                  height: '100%',
                  transform: `scale(${graphScale})`,
                  transformOrigin: 'center center'
                }}
              >
                <ConstellationGraph
                  result={displayResult}
                  onNodeClick={handleNodeClick}
                  onTopAnchorChange={setGraphTopAnchorY}
                  wireSpeed={wireSpeed}
                  nodeDrift={nodeDrift}
                />
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>
      </div>
      <AnimatePresence>
        {settingsOpen && (
          <SettingsPanel
            graphScale={graphScale}
            routeLimit={Math.min(routeLimit, routeLimitMax)}
            routeLimitMax={routeLimitMax}
            wireSpeed={wireSpeed}
            nodeDrift={nodeDrift}
            buttonRef={settingsButtonRef}
            onGraphScaleChange={setGraphScale}
            onRouteLimitChange={setRouteLimit}
            onWireSpeedChange={setWireSpeed}
            onNodeDriftChange={setNodeDrift}
            onClose={() => setSettingsOpen(false)}
          />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {statsOpen && (
          <StatsPanel
            stats={{ ...stats, recentSearches }}
            buttonRef={statsButtonRef}
            onClose={() => setStatsOpen(false)}
          />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {historyOpen && (
          <HistoryPanel
            searches={recentSearches}
            buttonRef={historyButtonRef}
            onClose={() => setHistoryOpen(false)}
            onSelect={handlePairSelect}
          />
        )}
      </AnimatePresence>
      <SettingsButton onClick={toggleSettingsPanel} isOpen={settingsOpen} buttonRef={settingsButtonRef} />
      <StatsButton onClick={toggleStatsPanel} isOpen={statsOpen} buttonRef={statsButtonRef} />
      <HistoryButton onClick={toggleHistoryPanel} isOpen={historyOpen} buttonRef={historyButtonRef} />
    </>
  );
}
