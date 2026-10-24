// A Cloud home on a plan that sleeps tells its pages it is going to sleep (a `power` frame on the event stream, or an
// "asleep" answer). From then on the page sends nothing in the background: any request reaching the Cloud would wake it.
// The next thing the person does (a click, a key, the window regaining focus) wakes it again, which takes about a second.
// On every other Cloud, and on a computer's own server, nothing here ever changes state.

/** Background requests (polls nobody asked for just now) carry this header, so the home doesn't count them as someone
 * using it (server/cloud-power.ts `countsAsActivity`). */
export const BACKGROUND_HEADER = "x-omb-background";
export const CLOUD_POWER_HEADER = "x-omb-cloud-power";
const WAKE_PATH = "/api/auth/session";

type Listener = (asleep: boolean) => void;
const listeners = new Set<Listener>();
let asleep = false;
let detach: (() => void) | null = null;

export function cloudAsleep(): boolean {
  return asleep;
}

export function onCloudPower(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function set(next: boolean) {
  if (asleep === next) return;
  asleep = next;
  for (const listener of listeners) listener(next);
}

/** The person is back: wake the Cloud by using it. One request the home counts as someone using it (the event stream
 * reconnecting is not one) also ends a sleep it agreed to but has not carried out, so its held polls stop answering
 * "asleep". */
export function markCloudAwake(): void {
  if (!asleep) return;
  void fetch(WAKE_PATH).catch(() => {});
  detach?.();
  detach = null;
  set(false);
}

/** The home agreed to sleep: stay quiet until the person does something. */
export function markCloudAsleep(target: Pick<Window, "addEventListener" | "removeEventListener"> | undefined = globalThis.window): void {
  if (asleep) return;
  set(true);
  if (!target) return;
  const wake = () => markCloudAwake();
  const events = ["pointerdown", "keydown", "focus", "touchstart"] as const;
  for (const name of events) target.addEventListener(name, wake, { capture: true });
  detach = () => { for (const name of events) target.removeEventListener(name, wake, { capture: true }); };
}

/** An "asleep" answer from the home (held polls and refused background requests carry it). */
export function asleepAnswer(response: Pick<Response, "status" | "headers">): boolean {
  return response.status === 503 && response.headers.get(CLOUD_POWER_HEADER) === "asleep";
}

/** The event stream's frame for it. */
export function sleepingFrame(frame: { kind: string; state?: unknown }): boolean {
  return frame.kind === "power" && frame.state === "sleeping";
}

/** Tests only. */
export function resetCloudPowerForTests(): void {
  detach?.();
  detach = null;
  asleep = false;
  listeners.clear();
}
