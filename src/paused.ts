export type PausedAgentRole = "subagent" | "main";

export type ContinuationAdapter = () => void | Promise<void>;

export interface PausedAgentRegistration {
  id: string;
  role: PausedAgentRole;
  isPaused: () => boolean | Promise<boolean>;
  continue: ContinuationAdapter;
  keepAlive?: () => void;
}

interface PausedAgentRecord extends PausedAgentRegistration {
  sequence: number;
}

export interface ContinuationDispatchResult {
  dispatched: string[];
  failed: Array<{ id: string; error: string }>;
}

export class PausedAgentRegistry {
  private readonly records = new Map<string, PausedAgentRecord>();
  private nextSequence = 0;

  get size(): number {
    return this.records.size;
  }

  register(registration: PausedAgentRegistration): void {
    const existing = this.records.get(registration.id);
    this.records.set(registration.id, {
      ...registration,
      sequence: existing?.sequence ?? this.nextSequence++,
    });
  }

  remove(id: string): boolean {
    return this.records.delete(id);
  }

  clear(): void {
    this.records.clear();
  }

  keepAlive(): void {
    for (const record of this.records.values()) {
      try {
        record.keepAlive?.();
      } catch {
        // External Continuation Adapters cannot disrupt timer rendering.
      }
    }
  }

  ordered(): PausedAgentRegistration[] {
    return [...this.records.values()]
      .sort((left, right) => {
        if (left.role !== right.role) return left.role === "subagent" ? -1 : 1;
        return left.sequence - right.sequence;
      })
      .map(({ sequence: _sequence, ...registration }) => registration);
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function dispatchContinuations(registry: PausedAgentRegistry): Promise<ContinuationDispatchResult> {
  const result: ContinuationDispatchResult = { dispatched: [], failed: [] };

  for (const candidate of registry.ordered()) {
    let paused = false;
    try {
      paused = await candidate.isPaused();
    } catch {
      paused = false;
    }
    if (!paused) {
      registry.remove(candidate.id);
      continue;
    }

    registry.remove(candidate.id);
    try {
      await candidate.continue();
      result.dispatched.push(candidate.id);
    } catch (error) {
      result.failed.push({ id: candidate.id, error: errorText(error) });
    }
  }

  return result;
}

export function isQuotaPauseError(error: unknown): boolean {
  if (typeof error !== "string") return false;
  return /(?:usage|rate)[-_ ]limit(?: has been)? (?:reached|exceeded)|quota(?: has been)? (?:reached|exceeded|exhausted)/i.test(error);
}
