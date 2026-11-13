/**
 * Limits of an LruCache. An instance lives for hours on Vercel Fluid, so every
 * in-memory cache needs a cap on its entries and, for large values, on their
 * total weight.
 */
export interface LruOptions {
  maxEntries: number;
  /**
   * Most total weight (about the JSON length of the values, in bytes). An
   * entry heavier than this alone is not kept.
   */
  maxWeight?: number;
  /** Default time to live of an entry; none when absent. */
  ttlMs?: number;
}

export interface LruSetOptions {
  weight?: number;
  /** Replaces the cache's default time to live for this entry. */
  ttlMs?: number;
}

/** The sweep for expired entries scans every entry: not more than this often. */
const SWEEP_INTERVAL_MS = 1000;

interface Slot<V> {
  value: V;
  weight: number;
  expiresAt: number;
}

/**
 * A Map that forgets: the least recently used entries go first when a limit
 * is passed, and expired entries are dropped on read and on writes (at most
 * once a second), so they free their memory without waiting for eviction.
 */
export class LruCache<K, V> {
  private readonly options: LruOptions;
  private readonly slots = new Map<K, Slot<V>>();
  private totalWeight = 0;
  private nextSweepAt = 0;

  constructor(options: LruOptions) {
    this.options = options;
  }

  get size(): number {
    return this.slots.size;
  }

  /** The total weight of the entries kept now. */
  get weight(): number {
    return this.totalWeight;
  }

  /** The value, or undefined when it is missing or expired. */
  get(key: K): V | undefined {
    const slot = this.live(key);
    if (!slot) return undefined;
    this.slots.delete(key);
    this.slots.set(key, slot);
    return slot.value;
  }

  /** Whether a live entry exists. Does not count as a use. */
  has(key: K): boolean {
    return this.live(key) !== undefined;
  }

  set(key: K, value: V, options: LruSetOptions = {}): void {
    this.delete(key);
    const weight = options.weight ?? 0;
    const { maxWeight } = this.options;
    if (maxWeight !== undefined && weight > maxWeight) return;
    const ttlMs = options.ttlMs ?? this.options.ttlMs ?? Infinity;
    this.slots.set(key, { value, weight, expiresAt: Date.now() + ttlMs });
    this.totalWeight += weight;
    this.prune();
  }

  delete(key: K): boolean {
    const slot = this.slots.get(key);
    if (!slot) return false;
    this.slots.delete(key);
    this.totalWeight -= slot.weight;
    return true;
  }

  clear(): void {
    this.slots.clear();
    this.totalWeight = 0;
  }

  /** The keys of every entry, live or not, least recently used first. */
  keys(): K[] {
    return [...this.slots.keys()];
  }

  private live(key: K): Slot<V> | undefined {
    const slot = this.slots.get(key);
    if (!slot) return undefined;
    if (slot.expiresAt <= Date.now()) {
      this.delete(key);
      return undefined;
    }
    return slot;
  }

  private prune(): void {
    const now = Date.now();
    if (now >= this.nextSweepAt) {
      this.nextSweepAt = now + SWEEP_INTERVAL_MS;
      for (const [key, slot] of this.slots) {
        if (slot.expiresAt <= now) this.delete(key);
      }
    }
    const maxWeight = this.options.maxWeight ?? Infinity;
    for (const key of this.slots.keys()) {
      if (
        this.slots.size <= this.options.maxEntries &&
        this.totalWeight <= maxWeight
      ) {
        break;
      }
      this.delete(key);
    }
  }
}
