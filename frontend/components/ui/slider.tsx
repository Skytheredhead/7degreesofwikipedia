'use client';

import * as SliderPrimitive from '@radix-ui/react-slider';
import { forwardRef } from 'react';

type SliderProps = React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root>;

export const Slider = forwardRef<
  React.ElementRef<typeof SliderPrimitive.Root>,
  SliderProps
>(function Slider({ children, value, defaultValue, min = 0, max = 100, step = 1, style, ...props }, ref) {
  const thumbCount = Math.max(
    1,
    value?.length ?? defaultValue?.length ?? 1
  );

  return (
    <SliderPrimitive.Root
      ref={ref}
      value={value}
      defaultValue={defaultValue}
      min={min}
      max={max}
      step={step}
      style={{
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        width: '100%',
        height: 22,
        touchAction: 'none',
        userSelect: 'none',
        ...style
      }}
      {...props}
    >
      <SliderPrimitive.Track
        style={{
          position: 'relative',
          flexGrow: 1,
          height: 10,
          overflow: 'hidden',
          borderRadius: 999,
          background:
            'linear-gradient(180deg, rgba(26,29,45,0.98) 0%, rgba(15,17,28,0.98) 100%)',
          border: '1px solid rgba(110,116,155,0.26)',
          boxShadow:
            'inset 0 1px 0 rgba(255,255,255,0.04), 0 0 0 1px rgba(8,10,18,0.42)'
        }}
      >
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background:
              'repeating-linear-gradient(90deg, rgba(255,255,255,0.028) 0 1px, transparent 1px 16px)',
            pointerEvents: 'none'
          }}
        />
        <SliderPrimitive.Range
          style={{
            position: 'absolute',
            height: '100%',
            borderRadius: 999,
            background:
              'linear-gradient(90deg, rgba(236,240,255,0.96) 0%, rgba(196,202,245,0.92) 38%, rgba(154,162,226,0.86) 100%)',
            boxShadow:
              '0 0 18px rgba(176,184,245,0.3), inset 0 0 8px rgba(255,255,255,0.26)'
          }}
        />
      </SliderPrimitive.Track>
      {Array.from({ length: thumbCount }, (_, index) => (
        <SliderPrimitive.Thumb
          key={index}
          aria-label={thumbCount > 1 ? `Slider thumb ${index + 1}` : 'Slider thumb'}
          style={{
            display: 'block',
            width: 20,
            height: 20,
            borderRadius: 999,
            border: '1px solid rgba(255,255,255,0.34)',
            background:
              'radial-gradient(circle at 32% 30%, rgba(255,255,255,0.98) 0%, rgba(232,236,255,0.94) 42%, rgba(164,172,226,0.96) 100%)',
            boxShadow:
              '0 6px 16px rgba(0,0,0,0.42), 0 0 0 5px rgba(193,199,245,0.08)',
            outline: 'none',
            cursor: 'grab'
          }}
        />
      ))}
      {children}
    </SliderPrimitive.Root>
  );
});

