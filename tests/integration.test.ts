import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import {
  PAUSED_AGENT_EVENT,
  SETTLED_AGENT_EVENT,
  createPiOpenAiLimits,
} from "../src/index.js";
import { REFRESH_COOLDOWN_MS } from "../src/snapshot.js";
import type { TimerScheduler } from "../src/timer.js";

const START = Date.UTC(2025, 0, 1, 12, 0, 0);
const payload = {
  rate_limit: {
    primary_window: { used_percent: 20, reset_at: (START + 3_600_000) / 1000, limit_window_seconds: 18_000 },
    secondary_window: { used_percent: 55, reset_at: (START + 604_800_000) / 1000, limit_window_seconds: 604_800 },
  },
};
const exhaustedPayload = {
  rate_limit: {
    primary_window: { used_percent: 100, reset_at: (START + 3_600_000) / 1000, limit_window_seconds: 18_000 },
    secondary_window: { used_percent: 55, reset_at: (START + 604_800_000) / 1000, limit_window_seconds: 604_800 },
  },
};
const currentPayload = {
  rate_limit: {
    primary_window: { used_percent: 4, reset_at: (START + 604_800_000) / 1000, limit_window_seconds: 604_800 },
    secondary_window: null,
  },
};

type Handler = (event: Record<string, unknown>, ctx: FakeContext) => unknown;

type FakeContext = ReturnType<typeof createContext>;

function createHarness(factory: ReturnType<typeof createPiOpenAiLimits>) {
  const handlers = new Map<string, Handler[]>();
  const busHandlers = new Map<string, Array<(data: unknown) => void>>();
  const emitted: Array<{ name: string; data: unknown }> = [];
  const pi = {
    events: {
      emit(name: string, data: unknown) {
        emitted.push({ name, data });
        for (const handler of busHandlers.get(name) ?? []) handler(data);
      },
      on(name: string, handler: (data: unknown) => void) {
        busHandlers.set(name, [...(busHandlers.get(name) ?? []), handler]);
        return () => {
          busHandlers.set(name, (busHandlers.get(name) ?? []).filter((candidate) => candidate !== handler));
        };
      },
    },
    sendUserMessage: vi.fn(),
    on(name: string, handler: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
  };
  factory(pi as unknown as ExtensionAPI);
  return {
    emitted,
    sendUserMessage: pi.sendUserMessage,
    busEmit(name: string, data: unknown) {
      pi.events.emit(name, data);
    },
    async emit(name: string, ctx: FakeContext, event: Record<string, unknown> = {}) {
      for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
    },
  };
}

class FakeScheduler implements TimerScheduler {
  nextId = 1;
  timeouts = new Map<number, { callback: () => void; delayMs: number }>();
  intervals = new Map<number, () => void>();

  setTimeout(callback: () => void, delayMs: number): number {
    const id = this.nextId++;
    this.timeouts.set(id, { callback, delayMs });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timeouts.delete(handle as number);
  }

  setInterval(callback: () => void): number {
    const id = this.nextId++;
    this.intervals.set(id, callback);
    return id;
  }

  clearInterval(handle: unknown): void {
    this.intervals.delete(handle as number);
  }

  fireTimeout(): void {
    this.timeouts.values().next().value?.callback();
  }
}

function createContext(options: {
  mode?: "tui" | "rpc" | "json" | "print";
  provider?: string;
  oauth?: boolean;
  access?: string;
} = {}) {
  const statuses = new Map<string, string>();
  const setStatus = vi.fn((id: string, value: string | undefined) => {
    if (value === undefined) statuses.delete(id);
    else statuses.set(id, value);
  });
  const provider = options.provider ?? "openai-codex";
  const oauth = options.oauth ?? true;
  const access = options.access ?? "pi-oauth-access";

  return {
    mode: options.mode ?? "tui",
    model: { provider, id: "gpt-test" },
    signal: undefined,
    ui: { setStatus, theme: { fg: (_color: string, text: string) => text } },
    modelRegistry: {
      isUsingOAuth: vi.fn(() => oauth),
      getProviderAuth: vi.fn(async () => oauth ? { auth: { apiKey: access }, source: "OAuth" } : undefined),
    },
    statuses,
  };
}

describe("Pi Lifecycle, Authentication, and Status Integration", () => {
  it("AT-1 fetches and renders both OpenAI Usage windows for eligible TUI startup", async () => {
    const transport = vi.fn(async () => payload);
    const ctx = createContext();
    const harness = createHarness(createPiOpenAiLimits({ transport, now: () => START, timeZone: "UTC", locale: "en-GB" }));

    await harness.emit("session_start", ctx);

    expect(transport).toHaveBeenCalledWith("pi-oauth-access", undefined);
    expect(ctx.statuses.get("openai-usage")).toBe(
      "5h 20% resets 13:00 | week 55% resets Wed 12:00",
    );
  });

  it("AT-8 IT-5 renders available OpenAI Usage when another Reset Window is absent", async () => {
    const transport = vi.fn(async () => currentPayload);
    const ctx = createContext();
    const harness = createHarness(createPiOpenAiLimits({
      transport,
      now: () => START,
      timeZone: "UTC",
      locale: "en-GB",
    }));

    await expect(harness.emit("session_start", ctx)).resolves.toBeUndefined();

    expect(ctx.statuses.get("openai-usage")).toBe("week 4% resets Wed 12:00");
  });

  it.each([
    ["missing Pi OAuth Access", createContext({ oauth: false })],
    ["non-OpenAI provider", createContext({ provider: "anthropic" })],
    ["non-TUI mode", createContext({ mode: "rpc" })],
  ])("AT-1 stays inactive for %s", async (_case, ctx) => {
    const transport = vi.fn(async () => payload);
    const harness = createHarness(createPiOpenAiLimits({ transport, now: () => START }));

    await harness.emit("session_start", ctx);

    expect(transport).not.toHaveBeenCalled();
    expect(ctx.statuses.has("openai-usage")).toBe(false);
  });

  it("AT-2 keeps cached Usage Snapshot stale during Refresh Cooldown then refreshes after Agent Handoff", async () => {
    let now = START;
    const transport = vi.fn(async () => payload);
    const ctx = createContext();
    const harness = createHarness(createPiOpenAiLimits({ transport, now: () => now, timeZone: "UTC", locale: "en-GB" }));

    await harness.emit("session_start", ctx);
    now += 60_000;
    await harness.emit("before_agent_start", ctx);
    expect(ctx.statuses.get("openai-usage")).toContain("1m ago");

    await harness.emit("agent_settled", ctx);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(ctx.statuses.get("openai-usage")).toContain("1m ago");

    now = START + REFRESH_COOLDOWN_MS;
    await harness.emit("agent_settled", ctx);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(ctx.statuses.get("openai-usage")).not.toContain("ago");
  });

  it("AT-3 bypasses Refresh Cooldown and schedules reset-plus-five-minute Continuation Timer", async () => {
    const scheduler = new FakeScheduler();
    const transport = vi.fn(async () => exhaustedPayload);
    const onContinuation = vi.fn();
    const ctx = createContext();
    const harness = createHarness(createPiOpenAiLimits({
      transport,
      scheduler,
      onContinuation,
      now: () => START,
      timeZone: "UTC",
      locale: "en-GB",
    }));

    await harness.emit("session_start", ctx);
    await harness.emit("after_provider_response", ctx, { status: 429, headers: {} });
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(scheduler.timeouts.size).toBe(1));

    expect(scheduler.timeouts.size).toBe(1);
    expect([...scheduler.timeouts.values()][0]?.delayMs).toBe(3_900_000);
    expect(ctx.statuses.get("openai-usage")).toContain("continue in 1h 5m 0s");

    scheduler.fireTimeout();
    await vi.waitFor(() => expect(onContinuation).toHaveBeenCalledWith((START + 3_600_000) / 1000));
    expect(harness.sendUserMessage).toHaveBeenCalledWith("Continue.", { deliverAs: "followUp" });
    expect(harness.emitted).toEqual([{
      name: "openai-limits:continuation",
      data: {
        resetAt: (START + 3_600_000) / 1000,
        dispatched: ["main"],
        failed: [],
      },
    }]);
  });

  it("AT-4 deduplicates Continuation Timer and keeps live countdown alongside Usage Snapshot", async () => {
    let now = START;
    const scheduler = new FakeScheduler();
    const transport = vi.fn(async () => exhaustedPayload);
    const ctx = createContext();
    const harness = createHarness(createPiOpenAiLimits({ transport, scheduler, now: () => now }));

    await harness.emit("session_start", ctx);
    await harness.emit("after_provider_response", ctx, { status: 429, headers: {} });
    await vi.waitFor(() => expect(scheduler.timeouts.size).toBe(1));
    await harness.emit("after_provider_response", ctx, { status: 429, headers: {} });
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(3));

    expect(scheduler.timeouts.size).toBe(1);
    expect(scheduler.intervals.size).toBe(1);
    expect(ctx.statuses.get("openai-usage")).toMatch(/5h 100%.*continue in 1h 5m 0s/);

    now += 1000;
    scheduler.intervals.values().next().value?.();
    expect(ctx.statuses.get("openai-usage")).toContain("continue in 1h 4m 59s");
  });

  it("AT-3 schedules from known Usage Snapshot when immediate refresh fails", async () => {
    let requests = 0;
    const scheduler = new FakeScheduler();
    const transport = vi.fn(async () => {
      requests++;
      if (requests === 2) throw new Error("temporary OpenAI Usage failure");
      return exhaustedPayload;
    });
    const ctx = createContext();
    const harness = createHarness(createPiOpenAiLimits({ transport, scheduler, now: () => START }));

    await harness.emit("session_start", ctx);
    await harness.emit("after_provider_response", ctx, { status: 429, headers: {} });
    await vi.waitFor(() => expect(scheduler.timeouts.size).toBe(1));

    expect(transport).toHaveBeenCalledTimes(2);
    expect(ctx.statuses.get("openai-usage")).toContain("ago");
    expect(ctx.statuses.get("openai-usage")).toContain("continue in");
  });

  it("IT-2 starts quota recovery without blocking provider response handling", async () => {
    let resolveRefresh!: (value: typeof exhaustedPayload) => void;
    const deferredRefresh = new Promise<typeof exhaustedPayload>((resolve) => {
      resolveRefresh = resolve;
    });
    const scheduler = new FakeScheduler();
    const transport = vi.fn()
      .mockResolvedValueOnce(exhaustedPayload)
      .mockImplementationOnce(async () => deferredRefresh);
    const ctx = createContext();
    const harness = createHarness(createPiOpenAiLimits({ transport, scheduler, now: () => START }));

    await harness.emit("session_start", ctx);
    await harness.emit("after_provider_response", ctx, { status: 429, headers: {} });

    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(2));
    expect(scheduler.timeouts.size).toBe(0);
    resolveRefresh(exhaustedPayload);
    await vi.waitFor(() => expect(scheduler.timeouts.size).toBe(1));
  });

  it("IT-2 preserves active Continuation Timer across eligible model changes and Reset Window grace", async () => {
    let now = START;
    const scheduler = new FakeScheduler();
    const transport = vi.fn(async () => exhaustedPayload);
    const ctx = createContext();
    const harness = createHarness(createPiOpenAiLimits({ transport, scheduler, now: () => now }));

    await harness.emit("session_start", ctx);
    await harness.emit("after_provider_response", ctx, { status: 429, headers: {} });
    await vi.waitFor(() => expect(scheduler.timeouts.size).toBe(1));

    ctx.model.id = "gpt-other";
    await harness.emit("model_select", ctx);
    expect(scheduler.timeouts.size).toBe(1);

    now = START + 3_660_000;
    await harness.emit("after_provider_response", ctx, { status: 429, headers: {} });
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(4));
    await vi.waitFor(() => expect(ctx.statuses.get("openai-usage")).toContain("continue in 4m 00s"));
    expect(scheduler.timeouts.size).toBe(1);
  });

  it("IT-2 leaves unrelated provider failures untouched and cleans Continuation Timer on shutdown", async () => {
    const scheduler = new FakeScheduler();
    const transport = vi.fn(async () => exhaustedPayload);
    const ctx = createContext();
    const harness = createHarness(createPiOpenAiLimits({ transport, scheduler, now: () => START }));

    await harness.emit("session_start", ctx);
    await harness.emit("after_provider_response", ctx, { status: 500, headers: {} });
    expect(transport).toHaveBeenCalledOnce();
    expect(scheduler.timeouts.size).toBe(0);

    await harness.emit("after_provider_response", ctx, { status: 429, headers: {} });
    await vi.waitFor(() => expect(scheduler.timeouts.size).toBe(1));
    await harness.emit("session_shutdown", ctx);
    expect(scheduler.timeouts.size).toBe(0);
    expect(scheduler.intervals.size).toBe(0);
  });

  it("AT-5 dispatches Continuation Signals to Subagents before main Paused Agent with context reuse", async () => {
    const calls: string[] = [];
    const scheduler = new FakeScheduler();
    const transport = vi.fn(async () => exhaustedPayload);
    const ctx = createContext();
    const harness = createHarness(createPiOpenAiLimits({ transport, scheduler, now: () => START }));
    const subagentContext = { work: "subagent-session" };
    const mainContext = { work: "main-session" };

    await harness.emit("session_start", ctx);
    harness.busEmit(PAUSED_AGENT_EVENT, {
      id: "sub-2",
      role: "subagent",
      isPaused: () => true,
      continue: () => { calls.push(`sub-2:${subagentContext.work}`); },
    });
    harness.busEmit(PAUSED_AGENT_EVENT, {
      id: "sub-1",
      role: "subagent",
      isPaused: () => true,
      continue: () => { calls.push(`sub-1:${subagentContext.work}`); },
    });
    harness.busEmit(PAUSED_AGENT_EVENT, {
      id: "main-custom",
      role: "main",
      isPaused: () => true,
      continue: () => { calls.push(`main:${mainContext.work}`); },
    });
    await harness.emit("after_provider_response", ctx, { status: 429, headers: {} });
    await vi.waitFor(() => expect(scheduler.timeouts.size).toBe(1));
    await harness.emit("message_end", ctx, { message: { role: "assistant", stopReason: "stop" } });

    scheduler.fireTimeout();
    await vi.waitFor(() => expect(calls).toHaveLength(3));

    expect(calls).toEqual([
      "sub-2:subagent-session",
      "sub-1:subagent-session",
      "main:main-session",
    ]);
    expect(harness.sendUserMessage).not.toHaveBeenCalled();
  });

  it("AT-6 performs no Continuation Signal or model request after Paused Agent state changes", async () => {
    const adapter = vi.fn();
    const scheduler = new FakeScheduler();
    const transport = vi.fn(async () => exhaustedPayload);
    const ctx = createContext();
    const harness = createHarness(createPiOpenAiLimits({ transport, scheduler, now: () => START }));

    await harness.emit("session_start", ctx);
    harness.busEmit(PAUSED_AGENT_EVENT, {
      id: "sub",
      role: "subagent",
      isPaused: () => true,
      continue: adapter,
    });
    await harness.emit("after_provider_response", ctx, { status: 429, headers: {} });
    await vi.waitFor(() => expect(scheduler.timeouts.size).toBe(1));
    harness.busEmit(SETTLED_AGENT_EVENT, { id: "sub" });
    await harness.emit("message_end", ctx, { message: { role: "assistant", stopReason: "stop" } });

    scheduler.fireTimeout();
    await vi.waitFor(() => expect(harness.emitted.some((entry) => entry.name === "openai-limits:continuation")).toBe(true));

    expect(adapter).not.toHaveBeenCalled();
    expect(harness.sendUserMessage).not.toHaveBeenCalled();
    expect(harness.emitted.at(-1)?.data).toMatchObject({ dispatched: [], failed: [] });
  });

  it("IT-3 bridges quota-failed Subagent session into ordered continuation", async () => {
    const managerKey = Symbol.for("pi-subagents:manager");
    const previous = (globalThis as Record<PropertyKey, unknown>)[managerKey];
    const scheduler = new FakeScheduler();
    const session = { prompt: vi.fn(async () => {}) };
    const record = {
      id: "subagent-1",
      status: "error",
      error: "The usage limit has been reached",
      startedAt: START - 1000,
      completedAt: START - 500,
      session,
    };
    (globalThis as Record<PropertyKey, unknown>)[managerKey] = {
      getRecord: (id: string) => id === record.id ? record : undefined,
    };

    try {
      const transport = vi.fn(async () => exhaustedPayload);
      const ctx = createContext();
      const harness = createHarness(createPiOpenAiLimits({ transport, scheduler, now: () => START }));
      await harness.emit("session_start", ctx);

      harness.busEmit("subagents:failed", { id: record.id, error: record.error });
      await vi.waitFor(() => expect(scheduler.timeouts.size).toBe(1));
      expect(record.completedAt).toBe(START);

      scheduler.fireTimeout();
      await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledWith("Continue."));
      expect(record.status).toBe("completed");
    } finally {
      if (previous === undefined) delete (globalThis as Record<PropertyKey, unknown>)[managerKey];
      else (globalThis as Record<PropertyKey, unknown>)[managerKey] = previous;
    }
  });

  it("AT-7 IT-4 starts all quota-paused sessions before any resumed session settles", async () => {
    const managerKey = Symbol.for("pi-subagents:manager");
    const previous = (globalThis as Record<PropertyKey, unknown>)[managerKey];
    const scheduler = new FakeScheduler();
    const starts: string[] = [];
    let resolveFirst!: () => void;
    let rejectSecond!: (error: Error) => void;
    const firstSession = {
      prompt: vi.fn(() => new Promise<void>((resolve) => {
        starts.push("subagent-1");
        resolveFirst = resolve;
      })),
    };
    const secondSession = {
      prompt: vi.fn(() => new Promise<void>((_resolve, reject) => {
        starts.push("subagent-2");
        rejectSecond = reject;
      })),
    };
    const records = [
      {
        id: "subagent-1",
        status: "error",
        error: "The usage limit has been reached" as string | undefined,
        startedAt: START - 2000,
        completedAt: START - 1000 as number | undefined,
        session: firstSession,
      },
      {
        id: "subagent-2",
        status: "error",
        error: "The usage limit has been reached" as string | undefined,
        startedAt: START - 1500,
        completedAt: START - 500 as number | undefined,
        session: secondSession,
      },
    ];
    (globalThis as Record<PropertyKey, unknown>)[managerKey] = {
      getRecord: (id: string) => records.find((record) => record.id === id),
    };

    try {
      const transport = vi.fn(async () => exhaustedPayload);
      const ctx = createContext();
      const harness = createHarness(createPiOpenAiLimits({ transport, scheduler, now: () => START }));
      harness.sendUserMessage.mockImplementation(() => { starts.push("main"); });
      await harness.emit("session_start", ctx);

      for (const record of records) {
        harness.busEmit("subagents:failed", { id: record.id, error: record.error });
      }
      await harness.emit("after_provider_response", ctx, { status: 429, headers: {} });
      await vi.waitFor(() => expect(scheduler.timeouts.size).toBe(1));

      scheduler.fireTimeout();
      await vi.waitFor(() => expect(starts).toEqual(["subagent-1", "subagent-2", "main"]));
      expect(firstSession.prompt).toHaveBeenCalledWith("Continue.");
      expect(secondSession.prompt).toHaveBeenCalledWith("Continue.");
      expect(harness.sendUserMessage).toHaveBeenCalledWith("Continue.", { deliverAs: "followUp" });
      expect(records.map((record) => record.status)).toEqual(["running", "running"]);

      rejectSecond(new Error("second resume failed"));
      resolveFirst();
      await vi.waitFor(() => expect(harness.emitted.at(-1)).toMatchObject({
        name: "openai-limits:continuation",
        data: {
          dispatched: ["subagent-1", "main"],
          failed: [{ id: "subagent-2", error: "second resume failed" }],
        },
      }));
    } finally {
      if (previous === undefined) delete (globalThis as Record<PropertyKey, unknown>)[managerKey];
      else (globalThis as Record<PropertyKey, unknown>)[managerKey] = previous;
    }
  });

  it("IT-1 discards delayed Pi OAuth Access resolution after provider deactivation", async () => {
    let resolveAuth!: (value: { auth: { apiKey: string }; source: string }) => void;
    const deferredAuth = new Promise<{ auth: { apiKey: string }; source: string }>((resolve) => {
      resolveAuth = resolve;
    });
    const transport = vi.fn(async () => payload);
    const ctx = createContext();
    ctx.modelRegistry.getProviderAuth.mockImplementationOnce(async () => deferredAuth);
    const harness = createHarness(createPiOpenAiLimits({ transport, now: () => START }));

    const startup = harness.emit("session_start", ctx);
    await vi.waitFor(() => expect(ctx.modelRegistry.getProviderAuth).toHaveBeenCalledOnce());

    ctx.model.provider = "anthropic";
    await harness.emit("model_select", ctx);
    resolveAuth({ auth: { apiKey: "old-pi-oauth-access" }, source: "OAuth" });
    await startup;

    expect(transport).not.toHaveBeenCalled();
    expect(ctx.statuses.has("openai-usage")).toBe(false);
  });

  it("IT-1 discards an in-flight refresh after provider deactivation", async () => {
    let resolveTransport!: (value: typeof payload) => void;
    const deferred = new Promise<typeof payload>((resolve) => {
      resolveTransport = resolve;
    });
    const transport = vi.fn(async () => deferred);
    const ctx = createContext();
    const harness = createHarness(createPiOpenAiLimits({ transport, now: () => START }));

    const startup = harness.emit("session_start", ctx);
    await vi.waitFor(() => expect(transport).toHaveBeenCalledOnce());

    ctx.model.provider = "anthropic";
    await harness.emit("model_select", ctx);
    resolveTransport(payload);
    await startup;
    await harness.emit("before_agent_start", ctx);

    expect(ctx.statuses.has("openai-usage")).toBe(false);
  });

  it("IT-1 retains stale Usage Snapshot when Pi OAuth Access refresh throws", async () => {
    let now = START;
    const transport = vi.fn(async () => payload);
    const ctx = createContext();
    const harness = createHarness(createPiOpenAiLimits({ transport, now: () => now }));

    await harness.emit("session_start", ctx);
    now += 60_000;
    ctx.modelRegistry.getProviderAuth.mockRejectedValueOnce(new Error("temporary OAuth refresh failure"));
    await expect(harness.emit("model_select", ctx)).resolves.toBeUndefined();

    expect(transport).toHaveBeenCalledOnce();
    expect(ctx.statuses.get("openai-usage")).toContain("1m ago");
  });

  it("IT-1 handles model changes, failed refreshes, and shutdown without disrupting agent", async () => {
    let fail = false;
    const transport = vi.fn(async () => {
      if (fail) throw new Error("network unavailable");
      return payload;
    });
    const ctx = createContext();
    const harness = createHarness(createPiOpenAiLimits({ transport, now: () => START }));

    await harness.emit("session_start", ctx);
    fail = true;
    await expect(harness.emit("model_select", ctx)).resolves.toBeUndefined();
    expect(ctx.statuses.get("openai-usage")).toContain("ago");

    ctx.model.provider = "anthropic";
    await harness.emit("model_select", ctx);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(ctx.statuses.has("openai-usage")).toBe(false);

    await harness.emit("session_shutdown", ctx);
    expect(ctx.statuses.has("openai-usage")).toBe(false);
  });
});
