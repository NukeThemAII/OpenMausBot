export class LocalVmIdleTimer {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastActivityAt = 0;
  private idleMs: number;
  private readonly isBusy: () => boolean;
  private readonly suspend: () => Promise<void>;

  constructor(idleMs: number, isBusy: () => boolean, suspend: () => Promise<void>) {
    this.idleMs = checkedIdleMs(idleMs);
    this.isBusy = isBusy;
    this.suspend = suspend;
  }

  touch(): void {
    this.lastActivityAt = Date.now();
    this.arm(this.idleMs);
  }

  cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  setIdleMs(idleMs: number): void {
    this.idleMs = checkedIdleMs(idleMs);
    if (!this.timer) return;
    this.arm(Math.max(0, this.lastActivityAt + this.idleMs - Date.now()));
  }

  private arm(delayMs: number): void {
    this.cancel();
    this.timer = setTimeout(() => void this.expire(), delayMs);
    this.timer.unref?.();
  }

  private async expire(): Promise<void> {
    this.timer = null;
    if (this.isBusy()) {
      this.touch();
      return;
    }
    try {
      await this.suspend();
    } catch {
      this.touch();
    }
  }
}

function checkedIdleMs(idleMs: number): number {
  if (!Number.isFinite(idleMs) || idleMs <= 0) throw new Error("Local VM idle timeout must be positive");
  return idleMs;
}
