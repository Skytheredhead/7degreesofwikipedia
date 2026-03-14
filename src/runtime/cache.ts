import type { PathResult } from "../shared/types.js";

export class PathResultCache {
  readonly #maxEntries: number;
  readonly #cache = new Map<string, PathResult>();

  constructor(maxEntries: number) {
    this.#maxEntries = maxEntries;
  }

  get(key: string): PathResult | undefined {
    const value = this.#cache.get(key);
    if (!value) {
      return undefined;
    }

    this.#cache.delete(key);
    this.#cache.set(key, value);
    return value;
  }

  set(key: string, value: PathResult): void {
    if (this.#cache.has(key)) {
      this.#cache.delete(key);
    }

    this.#cache.set(key, value);
    if (this.#cache.size <= this.#maxEntries) {
      return;
    }

    const oldestKey = this.#cache.keys().next().value;
    if (oldestKey !== undefined) {
      this.#cache.delete(oldestKey);
    }
  }

  stats(): { size: number; capacity: number } {
    return {
      size: this.#cache.size,
      capacity: this.#maxEntries
    };
  }
}
