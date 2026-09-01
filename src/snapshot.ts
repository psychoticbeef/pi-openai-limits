import type { OpenAIUsage, UsageTransport } from "./usage.js";
import { normalizeOpenAIUsage } from "./usage.js";

export const REFRESH_COOLDOWN_MS = 5 * 60 * 1000;

export interface UsageSnapshot {
  usage: OpenAIUsage;
  fetchedAt: number;
  stale: boolean;
}

export class UsageSnapshotStore {
  private current: UsageSnapshot | undefined;

  constructor(
    private readonly transport: UsageTransport,
    private readonly now: () => number = Date.now,
  ) {}

  get snapshot(): UsageSnapshot | undefined {
    return this.current;
  }

  clear(): void {
    this.current = undefined;
  }

  markStale(): void {
    if (this.current) this.current = { ...this.current, stale: true };
  }

  canRefresh(): boolean {
    return !this.current || this.now() - this.current.fetchedAt >= REFRESH_COOLDOWN_MS;
  }

  async refresh(
    access: string,
    signal?: AbortSignal,
    shouldCommit: () => boolean = () => true,
  ): Promise<boolean> {
    try {
      const usage = normalizeOpenAIUsage(await this.transport(access, signal));
      if (!shouldCommit()) return false;
      this.current = { usage, fetchedAt: this.now(), stale: false };
      return true;
    } catch {
      if (shouldCommit()) this.markStale();
      return false;
    }
  }
}

export interface FormatUsageOptions {
  locale?: string;
  timeZone?: string;
}

function formatPercent(value: number): string {
  return `${Math.round(value)}%`;
}

function formatWindowDuration(windowSeconds: number): string {
  if (windowSeconds === 604_800) return "week";
  if (windowSeconds % 604_800 === 0) return `${windowSeconds / 604_800}w`;
  if (windowSeconds % 86_400 === 0) return `${windowSeconds / 86_400}d`;
  if (windowSeconds % 3_600 === 0) return `${windowSeconds / 3_600}h`;
  return `${windowSeconds}s`;
}

function formatReset(timestampSeconds: number, now: number, options: FormatUsageOptions): string {
  const reset = new Date(timestampSeconds * 1000);
  const current = new Date(now);
  const dateFormatter = new Intl.DateTimeFormat(options.locale ?? "en", {
    timeZone: options.timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const sameDay = dateFormatter.format(reset) === dateFormatter.format(current);
  return new Intl.DateTimeFormat(options.locale ?? "en", {
    timeZone: options.timeZone,
    ...(sameDay ? {} : { weekday: "short" as const }),
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(reset);
}

export function formatCompactAge(elapsedMs: number): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function formatUsageStatus(
  snapshot: UsageSnapshot,
  now: number,
  options: FormatUsageOptions = {},
): string {
  const status = snapshot.usage.windows.map((window) =>
    `${formatWindowDuration(window.windowSeconds)} ${formatPercent(window.usedPercent)}`
    + ` resets ${formatReset(window.resetAt, now, options)}`
  ).join(" | ");
  return snapshot.stale ? `${status} · ${formatCompactAge(now - snapshot.fetchedAt)}` : status;
}
