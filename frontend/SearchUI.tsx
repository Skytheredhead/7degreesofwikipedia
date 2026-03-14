// components/SearchUI.tsx
'use client';
import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

import type { ArticleSuggestion } from './lib/types';

interface SearchUIProps {
  startValue: string;
  endValue: string;
  startPlaceholder?: string;
  endPlaceholder?: string;
  onStartChange: (value: string) => void;
  onEndChange: (value: string) => void;
  onStartFocus?: () => void;
  onEndFocus?: () => void;
  onSearch: (overrides?: { start?: string; end?: string }) => void;
  onSwap: () => void;
  isLoading: boolean;
  disabled?: boolean;
  helperText?: string | null;
  helperTone?: 'default' | 'error';
  getSuggestions: (query: string) => Promise<ArticleSuggestion[]>;
}

interface AutocompleteProps {
  suggestions: ArticleSuggestion[];
  onSelect: (suggestion: ArticleSuggestion) => void;
  visible: boolean;
}

function AutocompleteList({ suggestions, onSelect, visible }: AutocompleteProps) {
  return (
    <AnimatePresence>
      {visible && suggestions.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: -6, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -4, scale: 0.97 }}
          transition={{ duration: 0.12, ease: 'easeOut' }}
          style={{
            position: 'absolute',
            top: 'calc(100% + 8px)',
            left: 0,
            right: 0,
            background: 'rgba(8,9,18,0.97)',
            border: '1px solid rgba(190,195,230,0.18)',
            borderRadius: 6,
            overflow: 'hidden',
            zIndex: 200,
            backdropFilter: 'blur(16px)',
            boxShadow: '0 10px 40px rgba(0,0,0,0.45)',
          }}
        >
          {suggestions.map((suggestion, index) => (
            <motion.button
              key={`${suggestion.title}-${suggestion.canonicalTitle}`}
              tabIndex={-1}
              initial={{ opacity: 0, x: -4 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: index * 0.03 }}
              onClick={() => onSelect(suggestion)}
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                padding: '10px 14px',
                background: 'transparent',
                border: 'none',
                color: 'rgba(220,224,248,0.88)',
                fontFamily: 'var(--font-syne), sans-serif',
                fontSize: 13,
                cursor: 'pointer',
                letterSpacing: '0.01em',
                borderBottom:
                  index < suggestions.length - 1 ? '1px solid rgba(160,165,200,0.06)' : 'none',
              }}
              onMouseEnter={(event) => {
                event.currentTarget.style.background = 'rgba(180,185,230,0.07)';
              }}
              onMouseLeave={(event) => {
                event.currentTarget.style.background = 'transparent';
              }}
            >
              <div>{suggestion.title}</div>
              {suggestion.viaRedirect && suggestion.title !== suggestion.canonicalTitle && (
                <div
                  style={{
                    marginTop: 2,
                    fontFamily: 'var(--font-azeret), monospace',
                    fontSize: 9,
                    letterSpacing: '0.5px',
                    color: 'rgba(145,150,180,0.75)',
                    textTransform: 'uppercase',
                  }}
                >
                  redirects to {suggestion.canonicalTitle}
                </div>
              )}
            </motion.button>
          ))}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

interface InputFieldProps {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  label: string;
  onEnter: (nextValue?: string) => void;
  onFocusInput?: () => void;
  disabled?: boolean;
  getSuggestions: (query: string) => Promise<ArticleSuggestion[]>;
  inputRef?: { current: HTMLInputElement | null };
}

function InputField({
  value,
  onChange,
  placeholder,
  label,
  onEnter,
  onFocusInput,
  disabled,
  getSuggestions,
  inputRef: forwardedRef
}: InputFieldProps) {
  const [focused, setFocused] = useState(false);
  const [suggestions, setSuggestions] = useState<ArticleSuggestion[]>([]);
  const [suggestionsQuery, setSuggestionsQuery] = useState('');
  const internalInputRef = useRef<HTMLInputElement>(null);
  const inputRef = forwardedRef ?? internalInputRef;

  useEffect(() => {
    if (disabled || value.trim().length < 2) {
      setSuggestions([]);
      setSuggestionsQuery('');
      return;
    }

    let cancelled = false;
    const requestValue = value;
    const timer = window.setTimeout(async () => {
      try {
        const nextSuggestions = await getSuggestions(requestValue);
        if (!cancelled) {
          setSuggestions(nextSuggestions);
          setSuggestionsQuery(requestValue.trim().toLowerCase());
        }
      } catch {
        if (!cancelled) {
          setSuggestions([]);
          setSuggestionsQuery('');
        }
      }
    }, 120);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [disabled, getSuggestions, value]);

  const handleSelect = (suggestion: ArticleSuggestion) => {
    onChange(suggestion.canonicalTitle);
    setSuggestions([]);
    setSuggestionsQuery('');
    inputRef.current?.blur();
  };

  const commitAndBlur = (nextValue?: string) => {
    setSuggestions([]);
    setSuggestionsQuery('');
    setFocused(false);
    inputRef.current?.blur();
    onEnter(nextValue);
  };

  const hasFreshSuggestions =
    suggestions.length > 0 && suggestionsQuery === value.trim().toLowerCase();

  return (
    <div style={{ position: 'relative', flex: '1 1 240px', minWidth: 0 }}>
      <div
        style={{
          position: 'absolute',
          top: -18,
          left: 2,
          fontSize: 9,
          letterSpacing: '1.8px',
          textTransform: 'uppercase',
          color: focused ? 'rgba(200,205,240,0.7)' : 'rgba(130,135,160,0.5)',
          fontFamily: 'var(--font-azeret), monospace',
          transition: 'color 0.2s',
          pointerEvents: 'none',
          userSelect: 'none',
        }}
      >
        {label}
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          borderBottom: `1px solid ${
            focused ? 'rgba(200,205,240,0.45)' : 'rgba(140,145,175,0.22)'
          }`,
          paddingBottom: 8,
          transition: 'border-color 0.2s',
        }}
      >
        <input
          ref={inputRef}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onFocus={() => {
            setFocused(true);
            onFocusInput?.();
          }}
          onBlur={() => setTimeout(() => setFocused(false), 150)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              if (hasFreshSuggestions) {
                const selectedTitle = suggestions[0]!.canonicalTitle;
                onChange(selectedTitle);
                commitAndBlur(selectedTitle);
                return;
              }
              commitAndBlur();
              return;
            }

            if (event.key === 'Tab') {
              if (hasFreshSuggestions) {
                onChange(suggestions[0]!.canonicalTitle);
              }
              setSuggestions([]);
              setSuggestionsQuery('');
            }
          }}
          placeholder={placeholder}
          disabled={disabled}
          style={{
            flex: 1,
            background: 'transparent',
            border: 'none',
            outline: 'none',
            color: 'rgba(232,235,252,0.95)',
            fontFamily: 'var(--font-syne), sans-serif',
            fontSize: 15,
            fontWeight: 400,
            letterSpacing: '0.02em',
            caretColor: 'rgba(200,205,240,0.8)',
            opacity: disabled ? 0.5 : 1,
          }}
        />
      </div>
      <AutocompleteList suggestions={suggestions} onSelect={handleSelect} visible={focused && hasFreshSuggestions} />
    </div>
  );
}

export default function SearchUI({
  startValue,
  endValue,
  startPlaceholder = 'Article one',
  endPlaceholder = 'Article two',
  onStartChange,
  onEndChange,
  onStartFocus,
  onEndFocus,
  onSearch,
  onSwap,
  isLoading,
  disabled = false,
  helperText,
  helperTone = 'default',
  getSuggestions
}: SearchUIProps) {
  const startInputRef = useRef<HTMLInputElement>(null);
  const endInputRef = useRef<HTMLInputElement>(null);
  const blurInputs = () => {
    startInputRef.current?.blur();
    endInputRef.current?.blur();
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  };

  return (
    <div style={{ width: '100%' }}>
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'flex-end',
          gap: 16,
          width: '100%',
        }}
      >
        <InputField
          value={startValue}
          onChange={onStartChange}
          placeholder={startPlaceholder}
          label="Origin"
          onEnter={(nextStart) => {
            const resolvedStart = (nextStart ?? startValue).trim();
            if (!endValue.trim()) {
              if (resolvedStart) {
                onStartChange(resolvedStart);
              }
              window.setTimeout(() => endInputRef.current?.focus(), 0);
              return;
            }
            onSearch(nextStart ? { start: nextStart } : undefined);
          }}
          onFocusInput={onStartFocus}
          disabled={disabled}
          getSuggestions={getSuggestions}
          inputRef={startInputRef}
        />

        <button
          onClick={() => {
            blurInputs();
            onSwap();
          }}
          title="Swap articles"
          disabled={disabled}
          tabIndex={-1}
          style={{
            flexShrink: 0,
            background: 'transparent',
            border: '1px solid rgba(150,155,185,0.22)',
            borderRadius: '50%',
            width: 30,
            height: 30,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: disabled ? 'not-allowed' : 'pointer',
            color: 'rgba(180,185,220,0.72)',
            transition: 'all 0.2s',
            opacity: disabled ? 0.45 : 1,
            marginBottom: 2,
          }}
          onMouseEnter={(event) => {
            if (disabled) {
              return;
            }
            event.currentTarget.style.borderColor = 'rgba(210,215,245,0.5)';
            event.currentTarget.style.transform = 'rotate(180deg)';
          }}
          onMouseLeave={(event) => {
            event.currentTarget.style.borderColor = 'rgba(150,155,185,0.22)';
            event.currentTarget.style.transform = 'rotate(0deg)';
          }}
        >
          <svg width="14" height="14" viewBox="0 0 12 12" fill="none">
            <path
              d="M1 6h10M8 3l3 3-3 3"
              stroke="currentColor"
              strokeWidth="1.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M4 9L1 6l3-3"
              stroke="currentColor"
              strokeWidth="1.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>

        <InputField
          value={endValue}
          onChange={onEndChange}
          placeholder={endPlaceholder}
          label="Destination"
          onEnter={(nextEnd) => onSearch(nextEnd ? { end: nextEnd } : undefined)}
          onFocusInput={onEndFocus}
          disabled={disabled}
          getSuggestions={getSuggestions}
          inputRef={endInputRef}
        />

        <button
          onClick={() => {
            blurInputs();
            onSearch();
          }}
          disabled={isLoading || disabled}
          style={{
            flexShrink: 0,
            background: 'transparent',
            border: '1px solid rgba(190,195,230,0.3)',
            borderRadius: 3,
            padding: '8px 18px',
            color:
              isLoading || disabled ? 'rgba(150,155,190,0.5)' : 'rgba(228,232,255,0.94)',
            fontFamily: 'var(--font-azeret), monospace',
            fontSize: 11,
            letterSpacing: '1.5px',
            textTransform: 'uppercase',
            cursor: isLoading || disabled ? 'wait' : 'pointer',
            transition: 'all 0.2s',
            minWidth: 112,
            marginBottom: 4,
          }}
          onMouseEnter={(event) => {
            if (isLoading || disabled) {
              return;
            }
            event.currentTarget.style.background = 'rgba(180,185,230,0.06)';
            event.currentTarget.style.borderColor = 'rgba(210,215,250,0.5)';
          }}
          onMouseLeave={(event) => {
            event.currentTarget.style.background = 'transparent';
            event.currentTarget.style.borderColor = 'rgba(190,195,230,0.3)';
          }}
        >
          {isLoading ? <LoadingDots /> : 'Find Path'}
        </button>
      </div>

      {helperText && (
        <div
          style={{
            marginTop: 14,
            fontFamily: 'var(--font-azeret), monospace',
            fontSize: 9,
            letterSpacing: '1px',
            textTransform: 'uppercase',
            textAlign: 'center',
            color:
              helperTone === 'error'
                ? 'rgba(240,168,168,0.82)'
                : 'rgba(120,125,160,0.58)',
          }}
        >
          {helperText}
        </div>
      )}
    </div>
  );
}

function LoadingDots() {
  return (
    <span style={{ display: 'inline-flex', gap: 3, alignItems: 'center', justifyContent: 'center' }}>
      {[0, 1, 2].map((index) => (
        <span
          key={index}
          style={{
            width: 3,
            height: 3,
            borderRadius: '50%',
            background: 'rgba(180,185,220,0.7)',
            animation: `subtlePulse 0.9s ease-in-out ${index * 0.15}s infinite`,
            display: 'inline-block',
          }}
        />
      ))}
    </span>
  );
}
