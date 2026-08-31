import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { createPiOpenAiLimits } from "../src/index.js";
import { REFRESH_COOLDOWN_MS } from "../src/snapshot.js";

const START = Date.UTC(2025, 0, 1, 12, 0, 0);
const payload = {
  rate_limit: {
    primary_window: { used_percent: 20, reset_at: (START + 3_600_000) / 1000, limit_window_seconds: 18_000 },
    secondary_window: { used_percent: 55, reset_at: (START + 604_800_000) / 1000, limit_window_seconds: 604_800 },
  },
};

type Handler = (event: Record<string, unknown>, ctx: FakeContext) => unknown;

type FakeContext = ReturnType<typeof createContext>;

function createHarness(factory: ReturnType<typeof createPiOpenAiLimits>) {
  const handlers = new Map<string, Handler[]>();
  const pi = {
    on(name: string, handler: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
  };
  factory(pi as unknown as ExtensionAPI);
  return {
    async emit(name: string, ctx: FakeContext) {
      for (const handler of handlers.get(name) ?? []) await handler({}, ctx);
    },
  };
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
