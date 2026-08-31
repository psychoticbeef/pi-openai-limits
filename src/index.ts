import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  PausedAgentRegistry,
  dispatchContinuations,
  isQuotaPauseError,
  type PausedAgentRegistration,
} from "./paused.js";
import { planContinuation, isSupportedQuotaFailure } from "./quota.js";
import { type FormatUsageOptions, UsageSnapshotStore, formatUsageStatus } from "./snapshot.js";
import {
  ContinuationTimerRegistry,
  formatContinuationCountdown,
  systemTimerScheduler,
  type TimerScheduler,
} from "./timer.js";
import {
  OPENAI_CODEX_PROVIDER,
  type UsageTransport,
  createOpenAIUsageTransport,
} from "./usage.js";

const STATUS_ID = "openai-usage";
const MAIN_AGENT_ID = "main";
const DEFAULT_CONTINUATION_SIGNAL = "Continue.";
const SUBAGENT_MANAGER_KEY = Symbol.for("pi-subagents:manager");

export const PAUSED_AGENT_EVENT = "openai-limits:paused-agent";
export const SETTLED_AGENT_EVENT = "openai-limits:settled-agent";

export interface OpenAIUsageExtensionOptions extends FormatUsageOptions {
  continuationSignal?: string;
  now?: () => number;
  onContinuation?: (resetAt: number) => void;
  scheduler?: TimerScheduler;
  transport?: UsageTransport;
}

type UsageContext = Pick<ExtensionContext, "mode" | "model" | "modelRegistry" | "ui" | "signal">;

type SubagentRecord = {
  id: string;
  status: string;
  error?: string;
  startedAt: number;
  completedAt?: number;
  session?: { prompt(text: string): Promise<void> };
};

type SubagentManagerRegistry = {
  getRecord(id: string): SubagentRecord | undefined;
};

type SubagentFailureEvent = { id?: unknown; error?: unknown };

function isPausedAgentRegistration(value: unknown): value is PausedAgentRegistration {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PausedAgentRegistration>;
  return typeof candidate.id === "string"
    && (candidate.role === "subagent" || candidate.role === "main")
    && typeof candidate.isPaused === "function"
    && typeof candidate.continue === "function";
}

export function createPiOpenAiLimits(options: OpenAIUsageExtensionOptions = {}) {
  return function piOpenAiLimits(pi: ExtensionAPI): void {
    const now = options.now ?? Date.now;
    const continuationSignal = options.continuationSignal ?? DEFAULT_CONTINUATION_SIGNAL;
    const store = new UsageSnapshotStore(options.transport ?? createOpenAIUsageTransport(), now);
    const timers = new ContinuationTimerRegistry(options.scheduler ?? systemTimerScheduler, now);
    const pausedAgents = new PausedAgentRegistry();
    let activeCtx: UsageContext | undefined;
    let busUnsubscribers: Array<() => void> = [];
    let generation = 0;
    let mainPaused = false;
    let refreshInFlight: { generation: number; promise: Promise<boolean> } | undefined;

    const render = (ctx: UsageContext): void => {
      const snapshot = store.snapshot;
      const remainingMs = timers.remainingMs;
      const usageStatus = snapshot
        ? formatUsageStatus(snapshot, now(), { locale: options.locale, timeZone: options.timeZone })
        : undefined;
      const countdown = remainingMs === undefined
        ? undefined
        : `continue in ${formatContinuationCountdown(remainingMs)}`;
      ctx.ui.setStatus(STATUS_ID, [usageStatus, countdown].filter(Boolean).join(" | ") || undefined);
    };

    const resolveAccess = async (ctx: UsageContext): Promise<string | undefined> => {
      const model = ctx.model;
      if (ctx.mode !== "tui" || !model || model.provider !== OPENAI_CODEX_PROVIDER) return undefined;
      if (!ctx.modelRegistry.isUsingOAuth(model)) return undefined;

      const resolved = await ctx.modelRegistry.getProviderAuth(OPENAI_CODEX_PROVIDER);
      return resolved?.auth.apiKey;
    };

    const deactivate = (ctx: UsageContext): void => {
      generation++;
      mainPaused = false;
      pausedAgents.clear();
      timers.clear();
      store.clear();
      ctx.ui.setStatus(STATUS_ID, undefined);
    };

    const refresh = async (ctx: UsageContext, force: boolean): Promise<boolean> => {
      const requestedGeneration = generation;
      let access: string | undefined;
      try {
        access = await resolveAccess(ctx);
      } catch {
        if (requestedGeneration === generation) {
          if (store.snapshot) {
            store.markStale();
            render(ctx);
          } else {
            deactivate(ctx);
          }
        }
        return false;
      }

      if (requestedGeneration !== generation) return false;
      if (!access) {
        deactivate(ctx);
        return false;
      }
      if (!force && !store.canRefresh()) {
        render(ctx);
        return false;
      }
      if (refreshInFlight?.generation === generation) return refreshInFlight.promise;

      const refreshGeneration = requestedGeneration;
      const promise = (async () => {
        const refreshed = await store.refresh(access, ctx.signal, () => refreshGeneration === generation);
        if (refreshGeneration === generation) render(ctx);
        return refreshed;
      })().finally(() => {
        if (refreshInFlight?.promise === promise) refreshInFlight = undefined;
      });
      refreshInFlight = { generation: refreshGeneration, promise };
      return promise;
    };

    const registerMainPause = (): void => {
      mainPaused = true;
      pausedAgents.register({
        id: MAIN_AGENT_ID,
        role: "main",
        isPaused: () => mainPaused,
        continue: () => pi.sendUserMessage(continuationSignal, { deliverAs: "followUp" }),
      });
    };

    const registerSubagentPause = (event: SubagentFailureEvent): boolean => {
      if (typeof event.id !== "string" || !isQuotaPauseError(event.error)) return false;
      const manager = (globalThis as unknown as { [key: symbol]: SubagentManagerRegistry | undefined })[
        SUBAGENT_MANAGER_KEY
      ];
      const record = manager?.getRecord(event.id);
      const session = record?.session;
      if (!record || !session) return false;

      pausedAgents.register({
        id: record.id,
        role: "subagent",
        isPaused: () => record.status === "error" && isQuotaPauseError(record.error),
        keepAlive: () => {
          if (record.status === "error") record.completedAt = now();
        },
        continue: async () => {
          record.status = "running";
          record.startedAt = now();
          record.completedAt = undefined;
          record.error = undefined;
          try {
            await session.prompt(continuationSignal);
            record.status = "completed";
            record.completedAt = now();
          } catch (error) {
            record.status = "error";
            record.error = error instanceof Error ? error.message : String(error);
            record.completedAt = now();
            throw error;
          }
        },
      });
      return true;
    };

    const unbindBus = (): void => {
      for (const unsubscribe of busUnsubscribers) unsubscribe();
      busUnsubscribers = [];
    };

    const bindBus = (): void => {
      unbindBus();
      busUnsubscribers = [
        pi.events.on(PAUSED_AGENT_EVENT, (event) => {
          if (isPausedAgentRegistration(event)) pausedAgents.register(event);
        }),
        pi.events.on(SETTLED_AGENT_EVENT, (event) => {
          const id = event && typeof event === "object" ? (event as { id?: unknown }).id : undefined;
          if (typeof id === "string") pausedAgents.remove(id);
        }),
        pi.events.on("subagents:started", (event) => {
          const id = event && typeof event === "object" ? (event as { id?: unknown }).id : undefined;
          if (typeof id === "string") pausedAgents.remove(id);
        }),
        pi.events.on("subagents:completed", (event) => {
          const id = event && typeof event === "object" ? (event as { id?: unknown }).id : undefined;
          if (typeof id === "string") pausedAgents.remove(id);
        }),
        pi.events.on("subagents:failed", (event) => {
          if (!registerSubagentPause(event as SubagentFailureEvent) || !activeCtx) return;
          const requestedGeneration = generation;
          void handleQuotaFailure(activeCtx, requestedGeneration).catch(() => {});
        }),
      ];
    };

    pi.on("session_start", async (_event, ctx) => {
      activeCtx = ctx;
      unbindBus();
      deactivate(ctx);
      bindBus();
      await refresh(ctx, true);
    });

    pi.on("model_select", async (_event, ctx) => {
      generation++;
      store.markStale();
      await refresh(ctx, true);
    });

    pi.on("before_agent_start", (_event, ctx) => {
      mainPaused = false;
      pausedAgents.remove(MAIN_AGENT_ID);
      store.markStale();
      render(ctx);
    });

    pi.on("message_end", (event) => {
      if (event.message.role !== "assistant") return;
      if (event.message.stopReason === "error" || event.message.stopReason === "aborted") return;
      mainPaused = false;
      pausedAgents.remove(MAIN_AGENT_ID);
    });

    pi.on("agent_settled", async (_event, ctx) => {
      await refresh(ctx, false);
    });

    const handleQuotaFailure = async (ctx: UsageContext, requestedGeneration: number): Promise<void> => {
      const refreshed = await refresh(ctx, true);
      if (requestedGeneration !== generation) return;

      const snapshot = store.snapshot;
      const plan = snapshot ? planContinuation(snapshot.usage, now()) : undefined;
      if (!plan) {
        const active = timers.plan;
        if (refreshed && active && now() < active.resetAt * 1000) {
          timers.clear();
          render(ctx);
        }
        return;
      }

      timers.schedule(
        plan,
        (fired) => {
          void dispatchContinuations(pausedAgents).then((dispatch) => {
            try {
              options.onContinuation?.(fired.resetAt);
            } catch {
              // Continuation observers must not break dispatch.
            }
            try {
              pi.events.emit("openai-limits:continuation", { resetAt: fired.resetAt, ...dispatch });
            } catch {
              // Inter-extension observers must not break dispatch.
            }
          }).catch(() => {});
        },
        () => {
          pausedAgents.keepAlive();
          render(ctx);
        },
      );
    };

    pi.on("after_provider_response", (event, ctx) => {
      if (!isSupportedQuotaFailure(event.status, ctx.model?.provider) || ctx.mode !== "tui") return;
      registerMainPause();
      const requestedGeneration = generation;
      void handleQuotaFailure(ctx, requestedGeneration).catch(() => {});
    });

    pi.on("session_shutdown", (_event, ctx) => {
      activeCtx = undefined;
      unbindBus();
      deactivate(ctx);
    });
  };
}

export default createPiOpenAiLimits();

export {
  PausedAgentRegistry,
  dispatchContinuations,
  isQuotaPauseError,
} from "./paused.js";
export type {
  ContinuationAdapter,
  ContinuationDispatchResult,
  PausedAgentRegistration,
  PausedAgentRole,
} from "./paused.js";
export { CONTINUATION_GRACE_MS, MAX_TIMER_DELAY_MS, isSupportedQuotaFailure, planContinuation } from "./quota.js";
export { formatCompactAge, formatUsageStatus, REFRESH_COOLDOWN_MS, UsageSnapshotStore } from "./snapshot.js";
export { ContinuationTimerRegistry, formatContinuationCountdown, systemTimerScheduler } from "./timer.js";
export type { TimerScheduler } from "./timer.js";
export {
  createOpenAIUsageTransport,
  normalizeOpenAIUsage,
  OPENAI_CODEX_PROVIDER,
  OPENAI_USAGE_URL,
} from "./usage.js";
export type { OpenAIUsage, UsageTransport, UsageWindow } from "./usage.js";
