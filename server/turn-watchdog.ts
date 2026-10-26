// A turn whose thread emits nothing for stallMs is wedged; waiting on a person or a computer is not a stall.
export interface WatchedTurn {
  threadId: string;
  botId: string;
  startedAt: number;
  lastEventAt: number;
  waitingOnHuman: boolean;
  waitingOnComputer: boolean;
}

const parked = (turn: WatchedTurn): boolean => turn.waitingOnHuman || turn.waitingOnComputer;

export interface TurnWatchdogOptions {
  stallMs: number;
  checkMs: number;
  onStall: (turn: WatchedTurn) => void;
  now?: () => number;
}

export class TurnWatchdog {
  private turns = new Map<string, WatchedTurn>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private opts: TurnWatchdogOptions;

  // No parameter properties: Node's type-stripping cannot transform them.
  constructor(opts: TurnWatchdogOptions) {
    this.opts = opts;
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.sweep(), this.opts.checkMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.turns.clear();
  }

  watch(threadId: string, botId: string): void {
    const at = this.now();
    this.turns.set(threadId, { threadId, botId, startedAt: at, lastEventAt: at, waitingOnHuman: false, waitingOnComputer: false });
  }

  touch(threadId: string): void {
    const turn = this.turns.get(threadId);
    if (turn) turn.lastEventAt = this.now();
  }

  setWaitingOnHuman(threadId: string, waiting: boolean): void {
    const turn = this.turns.get(threadId);
    if (!turn) return;
    turn.waitingOnHuman = waiting;
    turn.lastEventAt = this.now();
  }

  setWaitingOnComputer(threadId: string, waiting: boolean): void {
    const turn = this.turns.get(threadId);
    if (!turn) return;
    turn.waitingOnComputer = waiting;
    turn.lastEventAt = this.now();
  }

  settle(threadId: string): void {
    this.turns.delete(threadId);
  }

  watching(threadId: string): boolean {
    return this.turns.has(threadId);
  }

  waiting(threadId: string): boolean {
    const turn = this.turns.get(threadId);
    return turn !== undefined && parked(turn);
  }

  /** A turn of this bot is answering now: running and not parked on a person or a computer. One that goes silent is
   * stopped by the sweep, so this never holds anything for longer than stallMs without events. */
  answering(botId: string): boolean {
    for (const turn of this.turns.values()) if (turn.botId === botId && !parked(turn)) return true;
    return false;
  }

  sweep(): void {
    const at = this.now();
    for (const turn of this.turns.values()) {
      if (parked(turn)) continue;
      if (at - turn.lastEventAt < this.opts.stallMs) continue;
      this.turns.delete(turn.threadId);
      this.opts.onStall(turn);
    }
  }
}
