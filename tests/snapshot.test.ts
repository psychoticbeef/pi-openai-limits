import { describe, expect, it, vi } from "vitest";

import {
  REFRESH_COOLDOWN_MS,
  UsageSnapshotStore,
  formatCompactAge,
  formatUsageStatus,
} from "../src/snapshot.js";

const START = Date.UTC(2025, 0, 1, 12, 0, 0);
const usagePayload = {
  rate_limit: {
    primary_window: {
      used_percent: 25,
      reset_at: (START + 2 * 60 * 60 * 1000) / 1000,
      limit_window_seconds: 18_000,
    },
    secondary_window: {
      used_percent: 60,
      reset_at: (START + 6 * 24 * 60 * 60 * 1000) / 1000,
      limit_window_seconds: 604_800,
    },
  },
};

describe("Usage Snapshot State and Status Formatting", () => {
  it("UT-2 enforces Refresh Cooldown boundaries and refreshes at five minutes", async () => {
    let now = START;
    const transport = vi.fn(async () => usagePayload);
    const store = new UsageSnapshotStore(transport, () => now);

    expect(await store.refresh("token")).toBe(true);
    expect(store.canRefresh()).toBe(false);

    now += REFRESH_COOLDOWN_MS - 1;
    expect(store.canRefresh()).toBe(false);
    now += 1;
    expect(store.canRefresh()).toBe(true);
  });

  it("UT-2 retains failed-refresh Usage Snapshot and marks it stale", async () => {
    let fail = false;
    const transport = vi.fn(async () => {
      if (fail) throw new Error("network failure");
      return usagePayload;
    });
    const store = new UsageSnapshotStore(transport, () => START);

    await store.refresh("token");
    const originalUsage = store.snapshot?.usage;
    fail = true;

    expect(await store.refresh("token")).toBe(false);
    expect(store.snapshot?.usage).toBe(originalUsage);
    expect(store.snapshot?.stale).toBe(true);
  });

  it("UT-2 formats both reset times and compact stale age", async () => {
    const store = new UsageSnapshotStore(async () => usagePayload, () => START);
    await store.refresh("token");
    store.markStale();

    expect(formatUsageStatus(store.snapshot!, START + 5 * 60 * 1000, {
      locale: "en-GB",
      timeZone: "UTC",
    })).toBe("5h 25% resets 14:00 | week 60% resets Tue 12:00 · 5m ago");
    expect(formatCompactAge(59_000)).toBe("59s ago");
    expect(formatCompactAge(2 * 60 * 60 * 1000)).toBe("2h ago");
  });

  it("UT-8 formats available Reset Window from duration", async () => {
    const store = new UsageSnapshotStore(async () => ({
      rate_limit: {
        primary_window: usagePayload.rate_limit.secondary_window,
        secondary_window: null,
      },
    }), () => START);

    expect(await store.refresh("token")).toBe(true);
    expect(formatUsageStatus(store.snapshot!, START, {
      locale: "en-GB",
      timeZone: "UTC",
    })).toBe("week 60% resets Tue 12:00");
  });
});
