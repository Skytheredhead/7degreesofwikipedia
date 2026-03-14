import type { HistogramState } from "../shared/types.js";

export const durationHistogramBounds = [
  1, 2, 5, 10, 20, 30, 50, 75, 100, 150, 200, 300, 500, 750, 1000, 1500, 2000, 3000, 5000, 10000, 30000, 60000
];

export const pathLengthHistogramBounds = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15, 20, 30, 40, 50];

export function createHistogram(bounds: number[]): HistogramState {
  return {
    bounds,
    counts: new Array(bounds.length + 1).fill(0),
    total: 0
  };
}

export function recordHistogram(state: HistogramState, value: number): void {
  let bucketIndex = state.bounds.findIndex((bound) => value <= bound);
  if (bucketIndex === -1) {
    bucketIndex = state.bounds.length;
  }

  state.counts[bucketIndex] = (state.counts[bucketIndex] ?? 0) + 1;
  state.total += 1;
}

export function percentileFromHistogram(state: HistogramState, percentile: number): number | null {
  if (state.total === 0) {
    return null;
  }

  const threshold = Math.ceil(state.total * percentile);
  let running = 0;
  for (let index = 0; index < state.counts.length; index += 1) {
    running += state.counts[index] ?? 0;
    if (running >= threshold) {
      return state.bounds[index] ?? state.bounds.at(-1) ?? null;
    }
  }

  return state.bounds.at(-1) ?? null;
}
