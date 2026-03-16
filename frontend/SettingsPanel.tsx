'use client';

import { useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import { Slider } from './components/ui/slider';

interface SettingsPanelProps {
  graphScale: number;
  routeLimit: number;
  routeLimitMax: number;
  wireSpeed: number;
  nodeDrift: number;
  disallowNewsSites: boolean;
  buttonRef?: { current: HTMLButtonElement | null };
  onGraphScaleChange: (value: number) => void;
  onRouteLimitChange: (value: number) => void;
  onWireSpeedChange: (value: number) => void;
  onNodeDriftChange: (value: number) => void;
  onDisallowNewsSitesChange: (value: boolean) => void;
  onClose: () => void;
}

function SliderRow({
  label,
  valueLabel,
  min,
  max,
  step,
  value,
  onChange
}: {
  label: string;
  valueLabel: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <label
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 10
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 12
        }}
      >
        <span
          style={{
            fontFamily: 'var(--font-azeret), monospace',
            fontSize: 9,
            letterSpacing: '1.4px',
            textTransform: 'uppercase',
            color: 'rgba(150,155,190,0.72)'
          }}
        >
          {label}
        </span>
        <span
          style={{
            fontFamily: 'var(--font-syne), sans-serif',
            fontSize: 12,
            color: 'rgba(228,232,250,0.88)'
          }}
        >
          {valueLabel}
        </span>
      </div>
      <Slider
        min={min}
        max={max}
        step={step}
        value={[value]}
        onValueChange={(nextValue) => onChange(nextValue[0] ?? value)}
      />
    </label>
  );
}

function ToggleRow({
  label,
  description,
  checked,
  onChange
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 14,
        width: '100%',
        background: 'rgba(10,12,24,0.54)',
        border: '1px solid rgba(170,175,215,0.14)',
        borderRadius: 8,
        padding: '10px 12px',
        color: 'inherit',
        cursor: 'pointer',
        textAlign: 'left'
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
        <span
          style={{
            fontFamily: 'var(--font-azeret), monospace',
            fontSize: 9,
            letterSpacing: '1.4px',
            textTransform: 'uppercase',
            color: 'rgba(150,155,190,0.72)'
          }}
        >
          {label}
        </span>
        <span
          style={{
            fontFamily: 'var(--font-syne), sans-serif',
            fontSize: 12,
            lineHeight: 1.35,
            color: 'rgba(214,219,242,0.82)'
          }}
        >
          {description}
        </span>
      </div>
      <span
        aria-hidden="true"
        style={{
          position: 'relative',
          flexShrink: 0,
          width: 38,
          height: 22,
          borderRadius: 999,
          background: checked ? 'rgba(208,214,248,0.28)' : 'rgba(92,97,126,0.42)',
          border: `1px solid ${checked ? 'rgba(220,225,255,0.42)' : 'rgba(134,139,170,0.24)'}`,
          transition: 'background 0.18s ease, border-color 0.18s ease'
        }}
      >
        <span
          style={{
            position: 'absolute',
            top: 2,
            left: checked ? 18 : 2,
            width: 16,
            height: 16,
            borderRadius: '50%',
            background: checked ? 'rgba(242,244,255,0.96)' : 'rgba(200,204,228,0.72)',
            boxShadow: checked ? '0 0 16px rgba(185,190,235,0.3)' : 'none',
            transition: 'left 0.18s ease, background 0.18s ease, box-shadow 0.18s ease'
          }}
        />
      </span>
    </button>
  );
}

export default function SettingsPanel({
  graphScale,
  routeLimit,
  routeLimitMax,
  wireSpeed,
  nodeDrift,
  disallowNewsSites,
  buttonRef,
  onGraphScaleChange,
  onRouteLimitChange,
  onWireSpeedChange,
  onNodeDriftChange,
  onDisallowNewsSitesChange,
  onClose
}: SettingsPanelProps) {
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
        left: 112,
        width: 308,
        maxWidth: 'calc(100vw - 132px)',
        background: 'rgba(7,8,16,0.94)',
        border: '1px solid rgba(170,175,215,0.15)',
        borderRadius: 8,
        padding: '16px 18px',
        zIndex: 500,
        boxShadow: '0 16px 64px rgba(0,0,0,0.7), 0 0 0 1px rgba(130,135,175,0.06)',
        backdropFilter: 'blur(20px)'
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 14
        }}
      >
        <span
          style={{
            fontFamily: 'var(--font-azeret), monospace',
            fontSize: 9,
            letterSpacing: '2px',
            textTransform: 'uppercase',
            color: 'rgba(160,165,200,0.7)'
          }}
        >
          Settings
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
            lineHeight: 1
          }}
        >
          ×
        </button>
      </div>

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 16
        }}
      >
        <SliderRow
          label="Graph size"
          valueLabel={`${Math.round(graphScale * 100)}%`}
          min={0.8}
          max={1.3}
          step={0.05}
          value={graphScale}
          onChange={onGraphScaleChange}
        />
        <SliderRow
          label="Displayed routes"
          valueLabel={`${routeLimit}`}
          min={1}
          max={routeLimitMax}
          step={1}
          value={routeLimit}
          onChange={onRouteLimitChange}
        />
        <SliderRow
          label="Wire speed"
          valueLabel={`${wireSpeed.toFixed(2)}x`}
          min={0.4}
          max={1.6}
          step={0.1}
          value={wireSpeed}
          onChange={onWireSpeedChange}
        />
        <SliderRow
          label="Node drift"
          valueLabel={`${Math.round(nodeDrift * 100)}%`}
          min={0}
          max={1.5}
          step={0.1}
          value={nodeDrift}
          onChange={onNodeDriftChange}
        />
        <ToggleRow
          label="Disallow news sites"
          description="Hide shortest routes that pass through news organization articles."
          checked={disallowNewsSites}
          onChange={onDisallowNewsSitesChange}
        />
      </div>
    </motion.div>
  );
}

export function SettingsButton({
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
      title="Settings"
      style={{
        position: 'fixed',
        bottom: 'calc(20px + env(safe-area-inset-bottom))',
        left: 112,
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
        backdropFilter: 'blur(10px)'
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
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path
          d="M6.3 2.4h3.4l.5 1.7c.2.1.5.2.7.3l1.6-.7 1.7 2.9-1.3 1.1c0 .2 0 .5 0 .7s0 .5 0 .7l1.3 1.1-1.7 2.9-1.6-.7c-.2.1-.5.2-.7.3l-.5 1.7H6.3l-.5-1.7a4 4 0 0 1-.7-.3l-1.6.7-1.7-2.9 1.3-1.1a5 5 0 0 1 0-1.4L1.8 6.6l1.7-2.9 1.6.7c.2-.1.5-.2.7-.3l.5-1.7Z"
          stroke="rgba(220,224,248,0.86)"
          strokeWidth="1.1"
          strokeLinejoin="round"
        />
        <circle cx="8" cy="8" r="2" stroke="rgba(220,224,248,0.86)" strokeWidth="1.1" />
      </svg>
    </button>
  );
}
