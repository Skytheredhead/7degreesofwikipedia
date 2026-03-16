// components/StatsPanel.tsx
'use client';
import { useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import type { StatData, RecentSearch } from './lib/types';

interface StatsPanelProps {
  stats: StatData;
  onClose: () => void;
  buttonRef?: { current: HTMLButtonElement | null };
}

function timeAgo(date: Date): string {
  const diff = Date.now() - date.getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

function StatRow({ label, value, mono = true }: { label: string; value: string | number; mono?: boolean }) {
  return (
    <div style={{
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'baseline',
      padding: '5px 0',
      borderBottom: '1px solid rgba(150,155,190,0.07)',
    }}>
      <span style={{
        fontFamily: 'var(--font-azeret), monospace',
        fontSize: 10,
        letterSpacing: '1px',
        textTransform: 'uppercase',
        color: 'rgba(130,135,165,0.7)',
      }}>
        {label}
      </span>
      <span style={{
        fontFamily: mono ? 'var(--font-azeret), monospace' : 'var(--font-syne), sans-serif',
        fontSize: mono ? 12 : 12,
        color: 'rgba(215,218,245,0.9)',
        letterSpacing: mono ? '0.5px' : '0',
        fontWeight: 400,
      }}>
        {value}
      </span>
    </div>
  );
}

function RecentSearchRow({ search }: { search: RecentSearch }) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '5px 0',
      borderBottom: '1px solid rgba(150,155,190,0.06)',
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontFamily: 'var(--font-syne), sans-serif',
          fontSize: 11,
          color: 'rgba(200,203,235,0.85)',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}>
          {search.start} <span style={{ color: 'rgba(140,145,175,0.5)', margin: '0 4px' }}>→</span> {search.end}
        </div>
        <div style={{
          fontFamily: 'var(--font-azeret), monospace',
          fontSize: 9,
          color: 'rgba(110,115,145,0.6)',
          marginTop: 1,
          letterSpacing: '0.5px',
        }}>
          {search.pathLength} hops · {search.ms}ms · {timeAgo(search.timestamp)}
        </div>
      </div>
    </div>
  );
}

export default function StatsPanel({ stats, onClose, buttonRef }: StatsPanelProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const successRate =
    stats.totalSearches > 0 ? Math.round((stats.successfulSearches / stats.totalSearches) * 100) : 0;
  const recentCount = stats.recentSearches.length;
  const recentAverage =
    recentCount > 0
      ? Math.round(stats.recentSearches.reduce((sum, search) => sum + search.ms, 0) / recentCount)
      : 0;

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
      className="stats-panel"
      style={{
        position: 'fixed',
        bottom: 'calc(66px + env(safe-area-inset-bottom))',
        left: 66,
        width: 280,
        background: 'rgba(7,8,16,0.94)',
        border: '1px solid rgba(170,175,215,0.15)',
        borderRadius: 6,
        padding: '16px 18px',
        zIndex: 500,
        boxShadow: '0 16px 64px rgba(0,0,0,0.7), 0 0 0 1px rgba(130,135,175,0.06)',
      }}
    >
      {/* Header */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 14,
      }}>
        <span style={{
          fontFamily: 'var(--font-azeret), monospace',
          fontSize: 9,
          letterSpacing: '2px',
          textTransform: 'uppercase',
          color: 'rgba(160,165,200,0.7)',
        }}>
          Stats
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
            transition: 'color 0.15s',
          }}
          onMouseEnter={e => (e.currentTarget.style.color = 'rgba(200,205,240,0.9)')}
          onMouseLeave={e => (e.currentTarget.style.color = 'rgba(140,145,180,0.5)')}
        >
          ×
        </button>
      </div>

      {/* Performance stats */}
      <div style={{ marginBottom: 14 }}>
        <div style={{
          fontFamily: 'var(--font-azeret), monospace',
          fontSize: 8,
          letterSpacing: '1.5px',
          color: 'rgba(100,105,140,0.6)',
          textTransform: 'uppercase',
          marginBottom: 8,
        }}>
          Performance
        </div>
        <StatRow label="Total Searches" value={stats.totalSearches.toLocaleString()} />
        <StatRow label="Successful" value={stats.successfulSearches.toLocaleString()} />
        <StatRow label="Success Rate" value={`${successRate}%`} />
        <StatRow label="Fastest" value={`${stats.fastestMs}ms`} />
        <StatRow label="Slowest" value={`${stats.slowestMs}ms`} />
        <StatRow label="Average" value={`${stats.averageMs}ms`} />
        <StatRow label="Recent Average" value={`${recentAverage}ms`} />
        <StatRow label="Cache Hit Rate" value={`${Math.round(stats.cacheHitRate * 100)}%`} />
      </div>

      {/* Recent searches */}
      <div>
        <div style={{
          fontFamily: 'var(--font-azeret), monospace',
          fontSize: 8,
          letterSpacing: '1.5px',
          color: 'rgba(100,105,140,0.6)',
          textTransform: 'uppercase',
          marginBottom: 8,
        }}>
          Recent
        </div>
        <StatRow label="Recent Searches" value={recentCount.toLocaleString()} />
        {stats.recentSearches.slice(0, 4).map(s => (
          <RecentSearchRow key={s.id} search={s} />
        ))}
      </div>

      {/* Decorative corner detail */}
      <div style={{
        position: 'absolute',
        top: 0, right: 0,
        width: 20, height: 20,
        borderTop: '1px solid rgba(180,185,225,0.2)',
        borderRight: '1px solid rgba(180,185,225,0.2)',
        borderTopRightRadius: 6,
        pointerEvents: 'none',
      }} />
      <div style={{
        position: 'absolute',
        bottom: 0, left: 0,
        width: 14, height: 14,
        borderBottom: '1px solid rgba(180,185,225,0.12)',
        borderLeft: '1px solid rgba(180,185,225,0.12)',
        borderBottomLeftRadius: 6,
        pointerEvents: 'none',
      }} />
    </motion.div>
  );
}

// Stats toggle button
export function StatsButton({
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
      title="Stats"
      style={{
        position: 'fixed',
        bottom: 'calc(20px + env(safe-area-inset-bottom))',
        left: 66,
        width: 36,
        height: 36,
        borderRadius: '50%',
        background: isOpen ? 'rgba(160,165,210,0.12)' : 'rgba(8,9,18,0.8)',
        border: `1px solid ${isOpen ? 'rgba(190,195,235,0.35)' : 'rgba(140,145,185,0.2)'}`,
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 400,
        transition: 'all 0.2s',
        backdropFilter: 'blur(10px)',
      }}
      onMouseEnter={e => {
        (e.currentTarget as HTMLElement).style.borderColor = 'rgba(200,205,240,0.4)';
        (e.currentTarget as HTMLElement).style.background = 'rgba(160,165,210,0.1)';
      }}
      onMouseLeave={e => {
        if (!isOpen) {
          (e.currentTarget as HTMLElement).style.borderColor = 'rgba(140,145,185,0.2)';
          (e.currentTarget as HTMLElement).style.background = 'rgba(8,9,18,0.8)';
        }
      }}
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <path d="M2.5 13.5h11" stroke="rgba(170,175,220,0.42)" strokeWidth="1.1" strokeLinecap="round" />
        <rect x="3.5" y="8.5" width="2.2" height="5" rx="0.8" fill="rgba(190,195,235,0.58)" />
        <rect x="7" y="5.5" width="2.2" height="8" rx="0.8" fill="rgba(204,208,242,0.76)" />
        <rect x="10.5" y="3" width="2.2" height="10.5" rx="0.8" fill="rgba(224,228,248,0.9)" />
      </svg>
    </button>
  );
}
