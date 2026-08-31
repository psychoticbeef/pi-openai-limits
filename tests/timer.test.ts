import { describe, expect, it, vi } from "vitest";

import type { ContinuationPlan } from "../src/quota.js";
import {
  ContinuationTimerRegistry,
  formatContinuationCountdown,
  type TimerScheduler,
} from "../src/timer.js";

class FakeScheduler implements TimerScheduler {
  nextId = 1;
  timeouts = new Map<number, { callback: () => void; delayMs: number }>();
  intervals = new Map<number, { callback: () => void; intervalMs: number }>();
  clearedTimeouts: number[] = [];
  clearedIntervals: number[] = [];

  setTimeout(callback: () => void, delayMs: number): number {
    const id = this.nextId++;
    this.timeouts.set(id, { callback, delayMs });
    return id;
  }

  clearTimeout(handle: unknown): void {
    const id = handle as number;
    this.clearedTimeouts.push(id);
    this.timeouts.delete(id);
  }

  setInterval(callback: () => void, intervalMs: number): number {
    const id = this.nextId++;
    this.intervals.set(id, { callback, intervalMs });
    return id;
  }

  clearInterval(handle: unknown): void {
    const id = handle as number;
    this.clearedIntervals.push(id);
    this.intervals.delete(id);
  }

  fireTimeout(id: number): void {
    this.timeouts.get(id)?.callback();
  }

  tickIntervals(): void {
    for (const interval of this.intervals.values()) interval.callback();
  }
}

const START = Date.UTC(2025, 0, 1, 12, 0, 0);
const firstPlan: ContinuationPlan = {
  key: "18000:1735736400",
  resetAt: 1_735_736_400,
  continueAt: START + 3_900_000,
};

describe("Continuation Timer Registry and Countdown", () => {
  it("UT-4 schedules one Continuation Timer and updates live countdown", () => {
    let now = START;
    const scheduler = new FakeScheduler();
    const registry = new ContinuationTimerRegistry(scheduler, () => now);
    const onTick = vi.fn();

    expect(registry.schedule(firstPlan, vi.fn(), onTick)).toBe(true);
    expect([...scheduler.timeouts.values()][0]?.delayMs).toBe(3_900_000);
    expect([...scheduler.intervals.values()][0]?.intervalMs).toBe(1000);
    expect(onTick).toHaveBeenCalledOnce();

    now += 1000;
    scheduler.tickIntervals();
    expect(registry.remainingMs).toBe(3_899_000);
    expect(onTick).toHaveBeenCalledTimes(2);
  });

  it("UT-4 deduplicates the same Reset Window and replaces obsolete scheduling state", () => {
    const scheduler = new FakeScheduler();
    const registry = new ContinuationTimerRegistry(scheduler, () => START);
    registry.schedule(firstPlan, vi.fn(), vi.fn());

    expect(registry.schedule(firstPlan, vi.fn(), vi.fn())).toBe(false);
    expect(scheduler.timeouts.size).toBe(1);

    const replacement = { ...firstPlan, key: "604800:1735819200", resetAt: 1_735_819_200 };
    expect(registry.schedule(replacement, vi.fn(), vi.fn())).toBe(true);
    expect(registry.plan).toBe(replacement);
    expect(scheduler.clearedTimeouts).toEqual([1]);
    expect(scheduler.clearedIntervals).toEqual([2]);
  });

  it("UT-4 releases resources before firing continuation and on explicit cleanup", () => {
    const scheduler = new FakeScheduler();
    const registry = new ContinuationTimerRegistry(scheduler, () => START);
    const onFire = vi.fn();
    const onTick = vi.fn();
    registry.schedule(firstPlan, onFire, onTick);

    scheduler.fireTimeout(1);
    expect(registry.plan).toBeUndefined();
    expect(onFire).toHaveBeenCalledWith(firstPlan);
    expect(onTick).toHaveBeenCalledTimes(2);
    expect(scheduler.timeouts.size).toBe(0);
    expect(scheduler.intervals.size).toBe(0);

    registry.schedule(firstPlan, onFire, onTick);
    registry.clear();
    expect(registry.plan).toBeUndefined();
    expect(scheduler.timeouts.size).toBe(0);
    expect(scheduler.intervals.size).toBe(0);
  });

  it("UT-4 keeps Continuation Timer state process-local", () => {
    const firstScheduler = new FakeScheduler();
    const secondScheduler = new FakeScheduler();
    const firstRegistry = new ContinuationTimerRegistry(firstScheduler, () => START);
    const secondRegistry = new ContinuationTimerRegistry(secondScheduler, () => START);
    const secondPlan = { ...firstPlan, key: "604800:1735819200", resetAt: 1_735_819_200 };

    firstRegistry.schedule(firstPlan, vi.fn(), vi.fn());
    secondRegistry.schedule(secondPlan, vi.fn(), vi.fn());
    firstRegistry.clear();

    expect(firstRegistry.plan).toBeUndefined();
    expect(firstScheduler.timeouts.size).toBe(0);
    expect(secondRegistry.plan).toBe(secondPlan);
    expect(secondScheduler.timeouts.size).toBe(1);
    expect(secondScheduler.intervals.size).toBe(1);
  });

  it("UT-4 formats countdown boundaries compactly", () => {
    expect(formatContinuationCountdown(0)).toBe("0m 00s");
    expect(formatContinuationCountdown(60_001)).toBe("1m 01s");
    expect(formatContinuationCountdown(3_661_000)).toBe("1h 1m 1s");
    expect(formatContinuationCountdown(90_061_000)).toBe("1d 1h 1m");
  });
});
