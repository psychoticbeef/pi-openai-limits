import { describe, expect, it, vi } from "vitest";

import {
  PausedAgentRegistry,
  dispatchContinuations,
  isQuotaPauseError,
} from "../src/paused.js";

describe("Paused Agent Registry and Ordering", () => {
  it("UT-5 registers once, updates state, and preserves stable Subagent order", () => {
    const registry = new PausedAgentRegistry();
    const first = vi.fn();
    const updated = vi.fn();
    registry.register({ id: "sub-1", role: "subagent", isPaused: () => true, continue: first });
    registry.register({ id: "main", role: "main", isPaused: () => true, continue: vi.fn() });
    registry.register({ id: "sub-2", role: "subagent", isPaused: () => true, continue: vi.fn() });
    registry.register({ id: "sub-1", role: "subagent", isPaused: () => true, continue: updated });

    expect(registry.size).toBe(3);
    expect(registry.ordered().map((entry) => entry.id)).toEqual(["sub-1", "sub-2", "main"]);
    expect(registry.ordered()[0]?.continue).toBe(updated);
  });

  it("UT-5 removes settled Paused Agent records and clears without persistence", () => {
    const registry = new PausedAgentRegistry();
    registry.register({ id: "sub", role: "subagent", isPaused: () => true, continue: vi.fn() });

    expect(registry.remove("sub")).toBe(true);
    expect(registry.remove("sub")).toBe(false);
    expect(registry.ordered()).toEqual([]);

    registry.register({ id: "main", role: "main", isPaused: () => true, continue: vi.fn() });
    registry.clear();
    expect(registry.size).toBe(0);
  });

  it("UT-5 keeps active Continuation Adapters alive without propagating failures", () => {
    const registry = new PausedAgentRegistry();
    const keepAlive = vi.fn();
    registry.register({ id: "sub", role: "subagent", isPaused: () => true, continue: vi.fn(), keepAlive });
    registry.register({
      id: "main",
      role: "main",
      isPaused: () => true,
      continue: vi.fn(),
      keepAlive: () => { throw new Error("gone"); },
    });

    expect(() => registry.keepAlive()).not.toThrow();
    expect(keepAlive).toHaveBeenCalledOnce();
  });
});

describe("Efficient Continuation Dispatcher", () => {
  it("UT-6 dispatches live Subagents before main Paused Agent with one Continuation Signal each", async () => {
    const calls: string[] = [];
    const registry = new PausedAgentRegistry();
    registry.register({ id: "main", role: "main", isPaused: () => true, continue: () => { calls.push("main"); } });
    registry.register({ id: "sub-1", role: "subagent", isPaused: () => true, continue: () => { calls.push("sub-1"); } });
    registry.register({ id: "sub-2", role: "subagent", isPaused: async () => true, continue: async () => { calls.push("sub-2"); } });

    const result = await dispatchContinuations(registry);

    expect(calls).toEqual(["sub-1", "sub-2", "main"]);
    expect(result).toEqual({ dispatched: ["sub-1", "sub-2", "main"], failed: [] });
    expect(registry.size).toBe(0);
  });

  it("UT-7 starts every Continuation Adapter before collecting stable outcomes", async () => {
    const calls: string[] = [];
    let resolveFirst!: () => void;
    let rejectSecond!: (error: Error) => void;
    let resolveMain!: () => void;
    const registry = new PausedAgentRegistry();
    registry.register({
      id: "main",
      role: "main",
      isPaused: () => true,
      continue: () => new Promise<void>((resolve) => {
        calls.push("main");
        resolveMain = resolve;
      }),
    });
    registry.register({
      id: "sub-1",
      role: "subagent",
      isPaused: () => true,
      continue: () => new Promise<void>((resolve) => {
        calls.push("sub-1");
        resolveFirst = resolve;
      }),
    });
    registry.register({
      id: "sub-2",
      role: "subagent",
      isPaused: () => true,
      continue: () => new Promise<void>((_resolve, reject) => {
        calls.push("sub-2");
        rejectSecond = reject;
      }),
    });

    const dispatch = dispatchContinuations(registry);
    await vi.waitFor(() => expect(calls).toEqual(["sub-1", "sub-2", "main"]));

    resolveMain();
    rejectSecond(new Error("second failed"));
    resolveFirst();

    expect(await dispatch).toEqual({
      dispatched: ["sub-1", "main"],
      failed: [{ id: "sub-2", error: "second failed" }],
    });
    expect(registry.size).toBe(0);
  });

  it("UT-6 revalidates current state, skips settled entries, and performs empty no-op", async () => {
    const registry = new PausedAgentRegistry();
    const settledAdapter = vi.fn();
    registry.register({ id: "settled", role: "subagent", isPaused: () => false, continue: settledAdapter });
    registry.register({
      id: "invalid",
      role: "subagent",
      isPaused: () => { throw new Error("session gone"); },
      continue: settledAdapter,
    });

    expect(await dispatchContinuations(registry)).toEqual({ dispatched: [], failed: [] });
    expect(settledAdapter).not.toHaveBeenCalled();
    expect(await dispatchContinuations(registry)).toEqual({ dispatched: [], failed: [] });
  });

  it("UT-6 isolates Continuation Adapter failures and preserves session-bound closures", async () => {
    const session = { value: "existing work", continue: vi.fn() };
    const registry = new PausedAgentRegistry();
    registry.register({
      id: "broken",
      role: "subagent",
      isPaused: () => true,
      continue: () => { throw new Error("adapter failed"); },
    });
    registry.register({
      id: "bound",
      role: "main",
      isPaused: () => true,
      continue: () => session.continue(session.value),
    });

    const result = await dispatchContinuations(registry);

    expect(session.continue).toHaveBeenCalledWith("existing work");
    expect(result).toEqual({
      dispatched: ["bound"],
      failed: [{ id: "broken", error: "adapter failed" }],
    });
  });

  it("UT-6 recognizes only supported quota pause diagnostics", () => {
    expect(isQuotaPauseError("The usage limit has been reached")).toBe(true);
    expect(isQuotaPauseError("rate_limit exceeded")).toBe(true);
    expect(isQuotaPauseError("quota exhausted")).toBe(true);
    expect(isQuotaPauseError("network unavailable")).toBe(false);
    expect(isQuotaPauseError(new Error("usage limit reached"))).toBe(false);
  });
});
