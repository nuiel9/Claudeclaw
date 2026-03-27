import type { Logger } from "../core/types.js";

export interface RateLimitConfig {
  /** Max messages per window per sender (default: 30) */
  perSenderMax: number;
  /** Window duration in ms (default: 60000) */
  windowMs: number;
  /** Max messages per window per channel (default: 200) */
  perChannelMax: number;
  /** Global max messages per window across all senders (default: 500) */
  globalMax: number;
}

const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  perSenderMax: 30,
  windowMs: 60_000,
  perChannelMax: 200,
  globalMax: 500,
};

/**
 * Multi-tier rate limiter: per-sender, per-channel, and global
 * Uses sliding window counters
 */
export class RateLimiter {
  private senderWindows = new Map<string, number[]>();
  private channelWindows = new Map<string, number[]>();
  private globalWindow: number[] = [];
  private config: RateLimitConfig;
  private logger?: Logger;

  constructor(config?: Partial<RateLimitConfig>, logger?: Logger) {
    this.config = { ...DEFAULT_RATE_LIMIT, ...config };
    this.logger = logger;
  }

  /**
   * Check if a message should be rate limited.
   * Returns the tier that triggered the limit, or null if allowed.
   */
  check(senderId: string, channelId: string): RateLimitResult {
    const now = Date.now();
    const windowStart = now - this.config.windowMs;

    // 1. Per-sender check
    const senderTs = this.pruneAndGet(this.senderWindows, senderId, windowStart);
    if (senderTs.length >= this.config.perSenderMax) {
      this.logger?.debug(`Rate limited (sender): ${senderId}`);
      return { limited: true, tier: "sender", retryAfterMs: this.retryAfter(senderTs) };
    }

    // 2. Per-channel check
    const channelTs = this.pruneAndGet(this.channelWindows, channelId, windowStart);
    if (channelTs.length >= this.config.perChannelMax) {
      this.logger?.debug(`Rate limited (channel): ${channelId}`);
      return { limited: true, tier: "channel", retryAfterMs: this.retryAfter(channelTs) };
    }

    // 3. Global check
    this.globalWindow = this.globalWindow.filter((t) => t > windowStart);
    if (this.globalWindow.length >= this.config.globalMax) {
      this.logger?.debug("Rate limited (global)");
      return { limited: true, tier: "global", retryAfterMs: this.retryAfter(this.globalWindow) };
    }

    // Record the message
    senderTs.push(now);
    channelTs.push(now);
    this.globalWindow.push(now);

    return { limited: false, tier: null, retryAfterMs: 0 };
  }

  /**
   * Get current usage stats
   */
  getStats(): {
    activeSenders: number;
    activeChannels: number;
    globalCount: number;
  } {
    return {
      activeSenders: this.senderWindows.size,
      activeChannels: this.channelWindows.size,
      globalCount: this.globalWindow.length,
    };
  }

  /**
   * Update config at runtime
   */
  updateConfig(config: Partial<RateLimitConfig>): void {
    Object.assign(this.config, config);
    this.logger?.info("Rate limit config updated", this.config as any);
  }

  /**
   * Clear all state (e.g., on restart)
   */
  reset(): void {
    this.senderWindows.clear();
    this.channelWindows.clear();
    this.globalWindow = [];
  }

  /**
   * Periodic cleanup of stale entries
   */
  cleanup(): void {
    const windowStart = Date.now() - this.config.windowMs;

    for (const [key, ts] of this.senderWindows) {
      const filtered = ts.filter((t) => t > windowStart);
      if (filtered.length === 0) {
        this.senderWindows.delete(key);
      } else {
        this.senderWindows.set(key, filtered);
      }
    }

    for (const [key, ts] of this.channelWindows) {
      const filtered = ts.filter((t) => t > windowStart);
      if (filtered.length === 0) {
        this.channelWindows.delete(key);
      } else {
        this.channelWindows.set(key, filtered);
      }
    }

    this.globalWindow = this.globalWindow.filter((t) => t > windowStart);
  }

  // --- Internal ---

  private pruneAndGet(
    map: Map<string, number[]>,
    key: string,
    windowStart: number
  ): number[] {
    let ts = map.get(key);
    if (!ts) {
      ts = [];
      map.set(key, ts);
    } else {
      const filtered = ts.filter((t) => t > windowStart);
      map.set(key, filtered);
      ts = filtered;
    }
    return ts;
  }

  private retryAfter(timestamps: number[]): number {
    if (timestamps.length === 0) return 0;
    const oldest = timestamps[0];
    return Math.max(0, oldest + this.config.windowMs - Date.now());
  }
}

export interface RateLimitResult {
  limited: boolean;
  tier: "sender" | "channel" | "global" | null;
  retryAfterMs: number;
}
