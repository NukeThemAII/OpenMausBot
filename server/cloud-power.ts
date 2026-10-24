// A Cloud home's power: whether it is busy, and the sleep handshake with the Admin (docs/cloud-pro.md, "Sleeping
// homes"). The home never stops itself: on a plan that sleeps, the Admin reads `report()` about once a minute through
// its signed `GET /api/cloud/power`, asks `prepareSleep()` through `POST /api/cloud/power/sleep` once the home is idle,
// then suspends the machine (or stops it) and wakes it again before the next scheduled run. On every other plan the Admin
// never asks, and nothing here changes how the home behaves.
//
// Privacy: the report carries fixed codes and times only, like the health report.
import { readFileSync, rmSync } from "node:fs";
import type { IncomingHttpHeaders, ServerResponse } from "node:http";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic.ts";

/** Why a home is not idle, as fixed codes (the Admin keeps the latest one for its operator page). */
export type CloudPowerBusy = "turn" | "run" | "live-call" | "computer" | "maintenance" | "recent-activity" | "recent-work" | "just-woke" | "due-soon" | "team";

export interface CloudPowerReport {
  v: 1; at: number; bootedAt: number; wokeAt: number;
  idle: boolean; busy: CloudPowerBusy[];
  lastActivityAt: number | null; lastWorkAt: number | null;
  /** The earliest scheduled run (an enabled routine's next run or a queued run's retry), null when none: the Admin
   * starts a sleeping home a minute before it. */
  nextDueAt: number | null;
  /** The home said yes to a sleep request and has not been used or woken since. */
  sleeping: boolean;
}

export interface CloudPowerProbes {
  /** A turn runs anywhere: a bot, a room, delegated work. */
  turn(): boolean;
  /** A routine run is queued to start now, starting or running. One waiting for a person's answer is not: the answer wakes the home. */
  run(): boolean;
  liveCall(): boolean;
  /** A cloud computer is on, starting or within its own idle window: its idle timer lives in this process. */
  computer(): boolean;
  /** Backup or restore, Move to Cloud, an engine or browser install, a provider sign-in. */
  maintenance(): boolean;
  nextDueAt(): number | null;
}

/** No user activity for this long (the Admin may ask for another window in its sleep request). */
export const CLOUD_IDLE_ACTIVITY_MS = 10 * 60_000;
/** Work finished this long ago, so follow-ups and delegated work get going first. */
export const CLOUD_IDLE_WORK_MS = 2 * 60_000;
/** Awake at least this long, so a wake is never undone before the request that caused it is served. */
export const CLOUD_IDLE_AWAKE_MS = 2 * 60_000;
/** The next run at least this far away: the Admin wakes a home a minute early, so a shorter sleep isn't worth it. */
export const CLOUD_IDLE_DUE_MS = 5 * 60_000;
/** A sleep the Admin asked for but never carried out (the suspend failed, the Admin restarted) ends by itself. */
export const CLOUD_SLEEP_PENDING_MS = 120_000;
/** The clock tick that notices a resume: a jump this much larger than the tick means the machine was suspended. */
const TICK_MS = 5_000, RESUME_JUMP_MS = 15_000;
/** Paths that never count as someone using the home: the event stream, the public probe, Files and lending loops,
 * and the Admin's own power reads. */
const BACKGROUND = [/^\/api\/events$/, /^\/api\/health$/, /^\/api\/sync(\/|$)/, /^\/api\/shared-computers(\/|$)/, /^\/api\/cloud\/power(\/|$)/];
export const CLOUD_POWER_PATH = "/api/cloud/power";
export const CLOUD_POWER_SLEEP_PATH = "/api/cloud/power/sleep";
export const CLOUD_BACKGROUND_HEADER = "x-omb-background";
export const CLOUD_POWER_HEADER = "x-omb-cloud-power";
const MARKER = "cloud-sleep.json";
/** Long-polls and streams that stay open by design: never "in flight" work. */
const HELD = [/^\/api\/events$/, /^\/api\/sync\/changes$/, /^\/api\/shared-computers\/[\w-]+\/(?:poll|link)$/];

/** The answer a held poll (Files sync, lending) gets once the home agreed to sleep: the desktop pauses until it wakes. */
export function answerAsleep(res: ServerResponse, json: (res: ServerResponse, status: number, body: unknown) => void) {
  res.setHeader(CLOUD_POWER_HEADER, "asleep");
  json(res, 503, { error: "asleep" });
}

/** A request counts as someone using the home unless it is a background path or the client marked it as background. */
export function countsAsActivity(path: string, headers: Record<string, string | string[] | undefined>): boolean {
  if (BACKGROUND.some((pattern) => pattern.test(path))) return false;
  const marked = headers[CLOUD_BACKGROUND_HEADER];
  return !(marked === "1" || (Array.isArray(marked) && marked.includes("1")));
}

/**
 * Whether this boot follows a sleep the machine was stopped for (its marker on the volume): then waking is not a startup,
 * and the routines' "run on startup" option does not fire. Reads and removes the marker. Any other boot: false, as before.
 */
export function wokeFromSleep(dataDir: string): boolean {
  const path = join(dataDir, MARKER);
  try {
    readFileSync(path, "utf8");
  } catch { return false; }
  rmSync(path, { force: true });
  return true;
}

export function createCloudPower(options: {
  dataDir: string; probes: CloudPowerProbes;
  /** A Team Cloud: the Admin never sleeps a team plan, and a sleep request is refused as busy with `team`. */
  team?: boolean;
  /** Tells connected clients the home is going to sleep (`{ kind: "power", state: "sleeping" }`). */
  broadcast(payload: Record<string, unknown>): void;
  now?: () => number;
  log?: (line: string) => void;
}) {
  const now = options.now ?? Date.now;
  const bootedAt = now();
  let wokeAt = bootedAt, lastActivityAt: number | null = null, lastWorkAt: number | null = null;
  let sleepingSince: number | null = null, inFlight = 0;
  let sleepAbort = new AbortController();
  let lastTick = now();

  const clearMarker = () => { try { rmSync(join(options.dataDir, MARKER), { force: true }); } catch {} };
  const endSleep = () => {
    if (sleepingSince === null) return;
    sleepingSince = null;
    sleepAbort = new AbortController();
    clearMarker();
  };
  const sleeping = () => {
    if (sleepingSince !== null && now() - sleepingSince >= CLOUD_SLEEP_PENDING_MS) endSleep();
    return sleepingSince !== null;
  };
  const working = (): CloudPowerBusy[] => {
    const busy: CloudPowerBusy[] = [];
    const { probes } = options;
    if (probes.turn()) busy.push("turn");
    if (probes.run()) busy.push("run");
    if (probes.liveCall()) busy.push("live-call");
    if (probes.computer()) busy.push("computer");
    if (probes.maintenance() || inFlight > 0) busy.push("maintenance");
    return busy;
  };
  /** Samples work (so "finished two minutes ago" needs no hook in every kind of work) and notices a resume. */
  const tick = () => {
    const at = now();
    if (at - lastTick > TICK_MS + RESUME_JUMP_MS) {
      wokeAt = at;
      endSleep();
    }
    lastTick = at;
    if (working().length) lastWorkAt = at;
  };
  const timer = setInterval(tick, TICK_MS);
  timer.unref?.();

  const busyNow = (activityMs: number): CloudPowerBusy[] => {
    tick();
    const at = now(), busy = working(), workingNow = busy.length > 0;
    if (lastActivityAt !== null && at - lastActivityAt < activityMs) busy.push("recent-activity");
    if (!workingNow && lastWorkAt !== null && at - lastWorkAt < CLOUD_IDLE_WORK_MS) busy.push("recent-work");
    if (at - wokeAt < CLOUD_IDLE_AWAKE_MS) busy.push("just-woke");
    const due = options.probes.nextDueAt();
    if (due !== null && due - at < CLOUD_IDLE_DUE_MS) busy.push("due-soon");
    return busy;
  };

  /** Someone used the home (see `countsAsActivity`): a pending sleep is off. */
  const noteActivity = () => {
    lastActivityAt = now();
    endSleep();
  };
  /** An authenticated request in progress (an upload, a download) keeps the home awake until it ends; held polls and
   * the event stream don't. Returns the release. */
  const begin = (path: string): (() => void) => {
    if (HELD.some((pattern) => pattern.test(path))) return () => {};
    inFlight += 1;
    let released = false;
    return () => { if (!released) { released = true; inFlight -= 1; } };
  };

  return {
    noteActivity,
    begin,
    /** An authenticated request: someone using the home (`countsAsActivity`), and work in progress until it ends. */
    request(path: string, headers: IncomingHttpHeaders, res: Pick<ServerResponse, "once">) {
      if (countsAsActivity(path, headers)) noteActivity();
      res.once("close", begin(path));
    },
    report(activityMs = CLOUD_IDLE_ACTIVITY_MS): CloudPowerReport {
      const busy = busyNow(activityMs);
      return { v: 1, at: now(), bootedAt, wokeAt, idle: busy.length === 0, busy, lastActivityAt, lastWorkAt, nextDueAt: options.probes.nextDueAt(), sleeping: sleeping() };
    },
    /** The Admin is about to suspend or stop this machine: yes only when idle now. From here until a resume, someone's
     * use or CLOUD_SLEEP_PENDING_MS, held polls answer "asleep" and new ones are refused (`sleeping`). */
    prepareSleep(activityMs = CLOUD_IDLE_ACTIVITY_MS): { ok: true; nextDueAt: number | null } | { ok: false; busy: CloudPowerBusy[] } {
      const busy = options.team ? ["team" as const, ...busyNow(activityMs)] : busyNow(activityMs);
      if (busy.length) return { ok: false, busy };
      sleepingSince = now();
      try { writeFileAtomic(join(options.dataDir, MARKER), JSON.stringify({ at: sleepingSince })); }
      catch (error) { options.log?.(`cloud power: could not write the sleep marker: ${error instanceof Error ? error.message : String(error)}`); }
      sleepAbort.abort();
      options.broadcast({ kind: "power", state: "sleeping" });
      return { ok: true, nextDueAt: options.probes.nextDueAt() };
    },
    sleeping,
    /** Aborted the moment the home agrees to sleep: held long-polls end with it and answer "asleep". */
    sleepSignal: () => sleepAbort.signal,
    /** Tests: the clock tick, without waiting for the timer. */
    tick,
    close() { clearInterval(timer); },
  };
}

export type CloudPower = ReturnType<typeof createCloudPower>;

/** The running home's power, for route modules built before it (Files sync); null on any server that is not a Cloud home. */
let registered: Pick<CloudPower, "sleeping" | "sleepSignal"> | null = null;
export function registerCloudPower(power: Pick<CloudPower, "sleeping" | "sleepSignal"> | null) { registered = power; }
export const cloudPowerNow = () => registered;
