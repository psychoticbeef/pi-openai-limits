import type { ContinuationPlan } from "./quota.js";

export interface TimerScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(callback: () => void, intervalMs: number): unknown;
  clearInterval(handle: unknown): void;
}

export const systemTimerScheduler: TimerScheduler = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

export class ContinuationTimerRegistry {
  private current: ContinuationPlan | undefined;
  private timeoutHandle: unknown;
  private intervalHandle: unknown;

  constructor(
    private readonly scheduler: TimerScheduler = systemTimerScheduler,
    private readonly now: () => number = Date.now,
  ) {}

  get plan(): ContinuationPlan | undefined {
    return this.current;
  }

  get remainingMs(): number | undefined {
    return this.current ? Math.max(0, this.current.continueAt - this.now()) : undefined;
  }

  schedule(
    plan: ContinuationPlan,
    onFire: (plan: ContinuationPlan) => void,
    onTick: () => void,
  ): boolean {
    if (this.current?.key === plan.key) return false;
    this.clear();
    this.current = plan;
    this.timeoutHandle = this.scheduler.setTimeout(() => {
      const fired = this.current;
      this.clear();
      onTick();
      if (fired) onFire(fired);
    }, Math.max(0, plan.continueAt - this.now()));
    this.intervalHandle = this.scheduler.setInterval(onTick, 1000);
    onTick();
    return true;
  }

  clear(): void {
    if (this.timeoutHandle !== undefined) this.scheduler.clearTimeout(this.timeoutHandle);
    if (this.intervalHandle !== undefined) this.scheduler.clearInterval(this.intervalHandle);
    this.timeoutHandle = undefined;
    this.intervalHandle = undefined;
    this.current = undefined;
  }
}

export function formatContinuationCountdown(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}
