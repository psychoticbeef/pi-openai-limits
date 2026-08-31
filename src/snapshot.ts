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
  const { fiveHour, weekly } = snapshot.usage;
  const status = `5h ${formatPercent(fiveHour.usedPercent)} resets ${formatReset(fiveHour.resetAt, now, options)}`
    + ` | week ${formatPercent(weekly.usedPercent)} resets ${formatReset(weekly.resetAt, now, options)}`;
  return snapshot.stale ? `${status} · ${formatCompactAge(now - snapshot.fetchedAt)}` : status;
}
