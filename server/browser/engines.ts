// The bots' browser runs on agent-browser or, with browserEngine.engine set to "chrome", on OpenMausBot's own Chrome
// driver. A session's spec says which: the new engine's names the profile it drives. Everything that reaches a browser
// goes through the two routers here, which keep the agent-browser engine's API.
import { existsSync } from "node:fs";
import { join } from "node:path";

import type { BrowserLive } from "../browser-live.ts";
import type { BrowserRuntime, BrowserSpawnSpec } from "../browser-runtime.ts";
import type { StepContext } from "../browser-steps.ts";
import type { FillLoginDeps } from "../login-fill.ts";
import { acceptLanguageFor, LocalBackend } from "./backends.ts";
import { sandboxDisabled } from "./chrome/host-setup.ts";
import type { HostKind } from "./chrome/flags.ts";
import { ChromeLauncher } from "./chrome/launcher.ts";
import { ProcessRegistry, sweep } from "./chrome/processes.ts";
import { browserRoot } from "./chrome/profile.ts";
import { browserLanguage, browserTimeZone } from "./chrome/wrapper.ts";
import { displayScreen } from "./display.ts";
import { BrowserService, type BrowserTarget } from "./service.ts";
import { LiveV1 } from "./viewers/live-v1.ts";

/** A spec's command when the new engine runs the session; its one argument is the profile key. */
export const CHROME_ENGINE = "omb-cdp";

type Spec = Pick<BrowserSpawnSpec, "command" | "env"> & { args?: readonly string[] };

export function chromeTarget(session: string, spec: { command: string; args?: readonly string[] } | undefined): BrowserTarget | null {
  const key = spec?.command === CHROME_ENGINE ? spec.args?.[0] : undefined;
  return key ? { session, key } : null;
}

/** The profile a bot's browser is on the new engine: its own, a shared one, or a temporary one. */
export function profileKey(botId: string, session: string, profile: { guest: boolean; partitionId: string | null }): string {
  if (profile.guest) return `temp:${session}`;
  return profile.partitionId ? `shared:${profile.partitionId}` : `bot:${botId}`;
}

const MAX_RUNNING: Record<HostKind, number> = { desktop: 6, server: 4, container: 2 };
const SWEEP_MS = 60_000;

export interface ChromeEngineOptions {
  dataDir: string;
  host: HostKind;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  egressPort(key: string): Promise<number>;
  idleMs(): number;
  egressNotice(key: string): string | null;
  log?: (line: string) => void;
}

/** The new engine: one Chrome launcher (no agent-browser wrapper), the browser service, its v1 live view and its sweep. */
export class ChromeEngine {
  readonly launcher: ChromeLauncher;
  readonly service: BrowserService;
  readonly live: LiveV1;
  readonly #targets = new Map<string, string>();
  readonly #registry: ProcessRegistry;
  readonly #options: ChromeEngineOptions;
  #timer: ReturnType<typeof setInterval> | null = null;
  #cleared = false;

  constructor(options: ChromeEngineOptions) {
    this.#options = options;
    const env = options.env ?? process.env;
    const platform = options.platform ?? process.platform;
    const sandbox = !sandboxDisabled(env);
    this.launcher = new ChromeLauncher({ dataDir: options.dataDir, env, platform, engine: () => ({ managed: true }), wrapper: false, sandbox, ...(options.log ? { log: options.log } : {}) });
    this.#registry = new ProcessRegistry(browserRoot(options.dataDir));
    let screen: ReturnType<typeof displayScreen> | null = null;
    const locale = browserLanguage(env) ?? null;
    const backend = new LocalBackend({
      dataDir: options.dataDir,
      host: options.host,
      platform,
      binary: async () => {
        const binary = await this.launcher.binary();
        return { path: binary.path, identity: { ...binary.identity, product: binary.product } };
      },
      screen: () => (screen ??= displayScreen(options.host, { platform, env })),
      locale: () => locale,
      acceptLanguages: () => (locale ? acceptLanguageFor(locale).replace(/;q=[\d.]+/gu, "") : "en-US,en"),
      timezone: () => browserTimeZone(env, platform) ?? null,
      egressPort: (key) => options.egressPort(key),
      registry: this.#registry,
      sandbox,
      ...(options.log ? { log: options.log } : {}),
    });
    const maxRunning = Number(env.OMB_BROWSER_MAX_RUNNING) || MAX_RUNNING[options.host];
    this.service = new BrowserService({
      dataDir: options.dataDir,
      backend: () => backend,
      maxRunning,
      idleMs: options.idleMs,
      egressNotice: options.egressNotice,
      ...(options.log ? { log: options.log } : {}),
    });
    this.live = new LiveV1({ service: this.service, target: (session) => this.target(session) });
  }

  /** The spec a session gets on the new engine, remembered so its live view finds the profile. */
  spec(session: string, key: string): { command: string; args: string[]; env: Record<string, string> } {
    this.#targets.set(session, key);
    return { command: CHROME_ENGINE, args: [key], env: {} };
  }

  target(session: string): BrowserTarget | null {
    const key = this.#targets.get(session);
    return key ? { session, key } : null;
  }

  /**
   * In use, it prepares Chrome before a bot needs it and closes idle browsers and stray processes every minute. Not in
   * use, it only clears, once, what an earlier run of the engine left behind, so a server that never turned it on
   * lists no processes.
   */
  start({ inUse, prepare }: { inUse: boolean; prepare: boolean }): void {
    const root = browserRoot(this.#options.dataDir);
    const tick = () => {
      void this.service.closeIdle().catch(() => undefined);
      void sweep({ root, registry: this.#registry }).catch(() => undefined);
    };
    if (!inUse) {
      if (this.#timer) clearInterval(this.#timer);
      this.#timer = null;
      if (!this.#cleared && this.#everUsed()) tick();
      this.#cleared = true;
      return;
    }
    this.#cleared = true;
    if (prepare && this.launcher.plan().kind !== "legacy") void this.launcher.prepare();
    if (this.#timer) return;
    tick();
    this.#timer = setInterval(tick, SWEEP_MS);
    this.#timer.unref?.();
  }

  /** Whether this engine ever made a profile in this data folder. */
  #everUsed(): boolean {
    const root = browserRoot(this.#options.dataDir);
    return existsSync(join(root, "profiles")) || existsSync(join(root, "temp"));
  }

  async close(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.live.closeAll();
    await this.service.closeAll();
  }

  /** A deleted bot's or profile's browser: stopped, and its folder, downloads and screenshots gone. */
  async erase(request: { kind: "bot" | "profile"; id: string; partitionId: string }): Promise<boolean> {
    const key = request.kind === "bot" ? `bot:${request.id}` : `shared:${request.partitionId}`;
    if (!this.#everUsed()) return true;
    try {
      await this.service.erase(key);
      return true;
    } catch (error) {
      this.#options.log?.(`browser cleanup: could not erase ${key}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  /** For the browser status: what the new engine will run here. */
  summary(): { kind: "engine"; version: string; chrome: string } | { kind: "unavailable"; reason: string } {
    const plan = this.launcher.plan();
    if (plan.kind === "legacy") return { kind: "unavailable", reason: `Chrome is needed for the new browser: ${plan.reason}` };
    return { kind: "engine", version: "omb-cdp", chrome: this.launcher.describe() };
  }

  /** fill_login's reads and typing on the new engine. */
  loginDeps(session: string): Pick<FillLoginDeps, "engine" | "insertText" | "press" | "click"> | null {
    const target = this.target(session);
    return target ? this.service.loginDeps(target) : null;
  }
}

/** BrowserRuntime's API, each call going to the engine its session runs on. */
export class RuntimeRouter {
  readonly #old: BrowserRuntime;
  readonly #chrome: ChromeEngine;

  constructor(old: BrowserRuntime, chrome: ChromeEngine) {
    this.#old = old;
    this.#chrome = chrome;
  }

  agentRpc(session: string, spec: BrowserSpawnSpec, method: "tools/list" | "tools/call", params: unknown, beforeDispatch?: () => void, ctx?: StepContext): Promise<unknown> {
    const target = chromeTarget(session, spec);
    return target ? this.#chrome.service.agentRpc(target, method, params, beforeDispatch) : this.#old.agentRpc(session, spec, method, params, beforeDispatch, ctx);
  }

  previewFrame<T>(session: string, capture: () => Promise<T>, spec: { command: string; args?: readonly string[] }): Promise<T | { png: string; format: "jpeg" }> {
    return chromeTarget(session, spec) ? this.#chrome.service.previewFrame(session) : this.#old.previewFrame(session, capture);
  }

  withSecretInput<T extends { ok: boolean; text: string; held?: { url: string; ms: number } }>(session: string, spec: Spec, fn: () => Promise<T>, ctx?: StepContext): Promise<T> {
    const target = chromeTarget(session, spec);
    return target ? this.#chrome.service.withSecretInput(target, fn) : this.#old.withSecretInput(session, spec, fn, ctx);
  }

  heldBy(session: string): string | null {
    return this.#chrome.service.heldBy(session) ?? this.#old.heldBy(session);
  }

  interrupted(session: string): boolean {
    return this.#chrome.service.interrupted(session) || this.#old.interrupted(session);
  }

  interruptedCount(): number {
    return this.#chrome.service.interruptedCount() + this.#old.interruptedCount();
  }

  /** The new engine closes its own idle browsers. */
  closeIfIdle(session: string, idleMs: number, spec?: Spec & { args?: readonly string[] }): Promise<boolean> {
    if (chromeTarget(session, spec)) return Promise.resolve(false);
    return this.#old.closeIfIdle(session, idleMs, spec ? { command: spec.command, args: spec.args ?? [], env: spec.env } : undefined);
  }

  async close(session: string): Promise<void> {
    await Promise.all([this.#chrome.service.close(session), this.#old.close(session)]);
  }

  async closeAll(): Promise<void> {
    await Promise.all([this.#chrome.close(), this.#old.closeAll()]);
  }
}

type OpenOptions = Parameters<BrowserLive["open"]>[0];

/** BrowserLive's API: a viewer of a new-engine session gets the v1 adapter, every other the agent-browser one. */
export class LiveRouter {
  readonly #old: BrowserLive;
  readonly #chrome: ChromeEngine;

  constructor(old: BrowserLive, chrome: ChromeEngine) {
    this.#old = old;
    this.#chrome = chrome;
  }

  open(options: OpenOptions): Promise<void> {
    if (chromeTarget(options.session, options.spec)) {
      const { spec: _spec, ...rest } = options;
      return this.#chrome.live.open(rest);
    }
    return this.#old.open(options);
  }

  action(options: { viewerId: string; botId: string; owner: string; body: unknown }): Promise<unknown> {
    return this.#chrome.live.has(options.viewerId) ? this.#chrome.live.action(options) : this.#old.action(options);
  }

  handBack(session: string): void { this.#chrome.live.handBack(session); this.#old.handBack(session); }
  closeForSession(session: string): void { this.#chrome.live.closeForSession(session); this.#old.closeForSession(session); }
  closeForOwner(owner: string): void { this.#chrome.live.closeForOwner(owner); this.#old.closeForOwner(owner); }
  closeForBot(botId: string): void { this.#chrome.live.closeForBot(botId); this.#old.closeForBot(botId); }
  closeAll(): void { this.#chrome.live.closeAll(); this.#old.closeAll(); }
}
