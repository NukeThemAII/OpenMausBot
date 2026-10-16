// People watching and driving a bot's browser. Every viewer gets its own CDP session on the tab in front, with its own
// screencast sized to it, and the page fills the panel: in fill mode the window is resized to the size the latest
// viewer asked for, 1280x800 with nobody watching. Frames come at the screen's real device scale, so they stay sharp.
//
// Adapted from pingdotgg/t3code@00cdceb1 apps/server/src/preview/ServerBrowser.ts (attachViewer,
// dispatchViewerInput, releaseViewerInput, applySetting, withScreencastsPaused), MIT License, Copyright (c) 2026 T3
// Tools Inc. (full text in third_party/t3-code/LICENSE); modified: the CDP driver instead of Playwright, a real window
// resize instead of an emulated viewport, one control for the whole profile, a watching viewer may size the page, and
// input held by a viewer that leaves is released at once.
import { randomUUID } from "node:crypto";

import type { PointerReporter } from "../cdp/actions.ts";
import type { CdpBrowser } from "../cdp/browser.ts";
import type { CdpSession, Params } from "../cdp/connection.ts";
import type { Download } from "../cdp/downloads.ts";
import { valueInWorld } from "../cdp/evaluate.ts";
import { editingCommands, keyDescription, US_KEYBOARD } from "../cdp/keyboard.ts";
import { fitPage } from "../chrome/flags.ts";
import type { ProfileControl, TakeResult } from "../control.ts";
import type { Tab } from "../tabs.ts";

/** Chromium keeps three frames unacknowledged, so acking 100 ms after arrival caps a viewer near 30 fps. */
export const ACK_PACE_MS = { hi: 100, lo: 200 } as const;
export const SETTLE_MS = 200;
/** Only scrolling sends reduced frames; an animation stays sharp. */
const MOTION_FRAMES = 4;
const MOTION_WINDOW_MS = 300;
const MOTION_QUALITY = 50;
export const UNATTACHED_VIEWPORT = { width: 1280, height: 800 } as const;
export const VIEWPORT_LIMITS = { minWidth: 100, minHeight: 100, maxWidth: 3840, maxHeight: 2160 } as const;
/** Chrome keeps a window at least this wide (measured on 153); a narrower page needs emulation. */
export const MIN_WINDOW_WIDTH = 500;
const AGENT_CURSOR_MOVE_MS = 160;
const AGENT_CURSOR_CLICK_LEAD_MS = 40;
const TEXT_LIMIT = 10_000;
const HELD_LIMIT = 64;

/** The viewport sizes a person can pick: fill follows the panel; a preset letterboxes in it. */
export const VIEWPORT_PRESETS = {
  desktop: { width: 1280, height: 800 },
  tablet: { width: 820, height: 1180 },
  phone: { width: 390, height: 844 },
} as const;

export type ViewportSetting =
  | { mode: "fill" }
  | { mode: "preset"; preset: keyof typeof VIEWPORT_PRESETS; landscape?: boolean }
  | { mode: "fixed"; width: number; height: number };

export interface FrameMetadata {
  deviceWidth: number;
  deviceHeight: number;
  offsetTop: number;
  pageScaleFactor: number;
  scrollOffsetX: number;
  scrollOffsetY: number;
  timestamp?: number;
}

export type Controller = "agent" | "you" | "another-viewer" | "unclaimed";

export type ViewerOutput =
  | { type: "frame"; data: Buffer; metadata: FrameMetadata; still: boolean; ack: () => void }
  | { type: "viewport"; width: number; height: number; setting: ViewportSetting }
  | { type: "control"; canOperate: boolean; controller: Controller; held: boolean; owned: boolean; controlling: boolean; stale: boolean; generation: number; dialog: { type: string; message: string; defaultValue: string } | null }
  | { type: "tabs"; tabs: Array<{ tabId: string; title: string; url: string; active: boolean }> }
  | { type: "url"; url: string }
  | { type: "status"; connected: boolean; screencasting: boolean; viewportWidth: number; viewportHeight: number }
  | { type: "clipboard"; text: string }
  | { type: "probe"; x: number; y: number; editable: boolean }
  | { type: "pointer"; phase: "move" | "click"; x: number; y: number; sequence: number }
  | { type: "fileChooser"; id: string; multiple: boolean }
  | { type: "fileChooserClosed"; id: string }
  | { type: "download"; id: string; fileName: string; sizeBytes: number }
  | { type: "popup"; tabId: string }
  | { type: "authPrompt"; origin: string; realm: string }
  | { type: "authPromptClosed" }
  | { type: "starting" }
  | { type: "gone"; reason: string };

export interface ViewerOptions {
  /** Who is watching: a session id, or local-owner. */
  owner: string;
  canOperate: boolean;
  /** The largest frame this viewer can use, in device pixels. */
  maxWidth: number;
  maxHeight: number;
  quality?: number;
  pace?: keyof typeof ACK_PACE_MS;
  /** The panel's size in CSS pixels, which the page fills. */
  size?: { width: number; height: number } | null;
  /** The viewer can show a site's HTTP sign-in prompt to its person; the v1 view cannot. */
  authPrompts?: boolean;
  /** The viewer draws the agent's pointer, which the agent's actions wait for; false for the v1 view, which draws none. */
  pointer?: boolean;
}

/** What a hub needs from the browser service. */
export interface HubHost {
  readonly control: ProfileControl<Tab>;
  browser(): CdpBrowser | null;
  active(): Tab | null;
  tabs(): Tab[];
  tab(id: string): Tab | undefined;
  running(): Promise<void>;
  /** The largest page the browser's windows may show on its screen; null when nothing limits it. */
  pageLimit(): { width: number; height: number } | null;
  take(owner: string): Promise<TakeResult>;
  release(owner: string, releaseInput: (tab: Tab) => Promise<boolean>): Promise<void>;
  openTab(url: string | null, owner: string): Promise<Tab>;
  closeTab(tab: Tab): Promise<void>;
  showTab(tab: Tab): Promise<void>;
  download(id: string): Download | undefined;
}

const num = (value: unknown, fallback = 0) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);
const record = (value: unknown): Record<string, unknown> | null => (value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null);
const modifiersOf = (message: Record<string, unknown>) => {
  const value = num(message.modifiers);
  return Number.isInteger(value) && value >= 0 && value < 16 ? value : 0;
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Touch viewers raise the keyboard for editable targets, frames included. Read in the isolated world.
const EDITABLE_AT_POINT = `((x, y) => {
  let element = document.elementFromPoint(x, y);
  while (element && element.shadowRoot) {
    const inner = element.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === element) break;
    element = inner;
  }
  if (element && element.tagName === "LABEL" && element.control) element = element.control;
  if (!element) return false;
  if (element.tagName === "IFRAME" || element.tagName === "FRAME") return true;
  if (element.isContentEditable) return true;
  if (element.tagName === "TEXTAREA") return !element.disabled && !element.readOnly;
  if (element.tagName !== "INPUT") return false;
  const nonText = ["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"];
  return !nonText.includes(element.type) && !element.disabled && !element.readOnly;
})`;

/**
 * The CSS size `setting` gives the page, `requested` being the panel size of the viewer that asked last, within `limit`,
 * the largest page the screen fits: a filled panel gets a page of its own shape, which the viewer scales to fill it; a
 * set size is cut to fit.
 */
export function viewportFor(setting: ViewportSetting, requested: { width: number; height: number } | null, limit: { width: number; height: number } | null = null): { width: number; height: number } {
  if (setting.mode === "fill") return fitPage(requested ?? { ...UNATTACHED_VIEWPORT }, limit);
  const size = setting.mode === "fixed" ? { width: setting.width, height: setting.height } : presetSize(setting);
  if (!limit) return size;
  return { width: size.width < MIN_WINDOW_WIDTH ? size.width : Math.min(size.width, limit.width), height: Math.min(size.height, limit.height) };
}

function presetSize(setting: Extract<ViewportSetting, { mode: "preset" }>): { width: number; height: number } {
  const preset = VIEWPORT_PRESETS[setting.preset];
  return setting.landscape ? { width: preset.height, height: preset.width } : { ...preset };
}

const appliedKey = (size: { width: number; height: number }) => `${size.width}x${size.height}${size.width < MIN_WINDOW_WIDTH ? "e" : ""}`;

/** A viewer's resize request, or null when it is out of range (a collapsed panel, say) and the page keeps its size. */
export function requestedSize(width: unknown, height: unknown): { width: number; height: number } | null {
  const w = Math.min(Math.round(num(width)), VIEWPORT_LIMITS.maxWidth);
  const h = Math.min(Math.round(num(height)), VIEWPORT_LIMITS.maxHeight);
  return w >= VIEWPORT_LIMITS.minWidth && h >= VIEWPORT_LIMITS.minHeight ? { width: w, height: h } : null;
}

export class Viewer {
  readonly id = randomUUID();
  readonly options: Required<Omit<ViewerOptions, "size">>;
  readonly #hub: ViewerHub;
  readonly #push: (output: ViewerOutput) => void;
  requested: { width: number; height: number; order: number } | null = null;
  tab: Tab | null = null;
  #session: CdpSession | null = null;
  #binding: Promise<void> = Promise.resolve();
  #params: Promise<void> = Promise.resolve();
  #scale = 1;
  #framesInFlight = 0;
  #mayHaveDropped = false;
  #motion = false;
  #recent: number[] = [];
  #settle: ReturnType<typeof setTimeout> | null = null;
  #frameSeen = false;
  #paused = 0;
  #hidden = false;
  scrolledAt = 0;
  readonly pressedKeys = new Map<string, { key: string; code: string }>();
  readonly pressedButtons = new Map<"left" | "middle" | "right", { x: number; y: number }>();
  closed = false;

  constructor(hub: ViewerHub, options: ViewerOptions, push: (output: ViewerOutput) => void) {
    this.#hub = hub;
    this.#push = push;
    this.options = {
      owner: options.owner,
      canOperate: options.canOperate,
      maxWidth: Math.max(1, Math.round(options.maxWidth)),
      maxHeight: Math.max(1, Math.round(options.maxHeight)),
      quality: Math.min(100, Math.max(1, Math.round(options.quality ?? 70))),
      pace: options.pace ?? "hi",
      authPrompts: options.authPrompts === true,
      pointer: options.pointer !== false,
    };
  }

  push(output: ViewerOutput): void {
    if (this.closed) {
      if (output.type === "frame") output.ack();
      return;
    }
    try { this.#push(output); } catch {}
  }

  get session(): CdpSession | null {
    return this.#session;
  }

  /** Follows the tab in front: a new session and screencast for it, the old ones let go. */
  bind(tab: Tab | null): Promise<void> {
    this.#binding = this.#binding.then(() => this.#bind(tab), () => this.#bind(tab));
    return this.#binding;
  }

  async #bind(tab: Tab | null): Promise<void> {
    if (this.closed || this.tab === tab && this.#session && !this.#session.detached) return;
    await this.#unbind();
    this.tab = tab;
    const browser = this.#hub.host.browser();
    if (!tab || !browser || tab.page.closed) return;
    let session: CdpSession;
    try {
      session = await browser.attachSession(tab.page);
    } catch {
      return;
    }
    if (this.closed || this.tab !== tab) {
      await browser.detachSession(session);
      return;
    }
    this.#session = session;
    this.#frameSeen = false;
    session.on("Page.screencastFrame", (params) => this.#frame(session, params));
    if (this.#hidden) return;
    await this.#start(1);
    // An idle page does not repaint for a new screencast, so the viewer starts from a still unless a live frame beat it.
    if (!this.#frameSeen) await this.pushStill();
  }

  async #unbind(): Promise<void> {
    const session = this.#session;
    this.#session = null;
    if (this.#settle) clearTimeout(this.#settle);
    this.#settle = null;
    this.#motion = false;
    this.#recent = [];
    if (!session || session.detached) return;
    await session.send("Page.stopScreencast").catch(() => {});
    await this.#hub.host.browser()?.detachSession(session);
  }

  #start(scale: number): Promise<void> {
    this.#scale = scale;
    const session = this.#session;
    this.#params = this.#params.then(async () => {
      if (!session || session !== this.#session || session.detached || this.#paused > 0 || this.#hidden || this.closed) return;
      await session.send("Page.stopScreencast").catch(() => {});
      await session.send("Page.startScreencast", {
        format: "jpeg",
        quality: scale < 1 ? Math.min(this.options.quality, MOTION_QUALITY) : this.options.quality,
        maxWidth: Math.max(1, Math.round(this.options.maxWidth * scale)),
        maxHeight: Math.max(1, Math.round(this.options.maxHeight * scale)),
      }).catch(() => {});
    });
    return this.#params;
  }

  /** Stops the screencast while a scaled capture renders: it would show up in it. */
  pause(): Promise<void> {
    this.#paused++;
    const session = this.#session;
    this.#params = this.#params.then(() => session?.send("Page.stopScreencast").then(() => undefined, () => undefined));
    return this.#params;
  }

  resume(): Promise<void> {
    this.#paused = Math.max(0, this.#paused - 1);
    return this.#paused === 0 ? this.#start(this.#scale) : Promise.resolve();
  }

  /** Another viewer holds the browser: this one sees no frames until it is released. */
  async hide(hidden: boolean): Promise<void> {
    if (hidden === this.#hidden) return;
    this.#hidden = hidden;
    if (hidden) {
      const session = this.#session;
      this.#params = this.#params.then(() => session?.send("Page.stopScreencast").then(() => undefined, () => undefined));
      await this.#params;
      return;
    }
    await this.#start(1);
    await this.pushStill();
  }

  #frame(session: CdpSession, params: Params): void {
    if (session !== this.#session) {
      void session.send("Page.screencastFrameAck", { sessionId: params.sessionId }).catch(() => {});
      return;
    }
    this.#frameSeen = true;
    if (this.#framesInFlight > 0) this.#mayHaveDropped = true;
    this.#framesInFlight++;
    const arrivedAt = Date.now();
    this.#recent.push(arrivedAt);
    while (this.#recent[0]! < arrivedAt - MOTION_WINDOW_MS) this.#recent.shift();
    if (!this.#motion && this.#recent.length >= MOTION_FRAMES && arrivedAt - this.scrolledAt < MOTION_WINDOW_MS) {
      this.#motion = true;
      void this.#start(0.5);
    } else if (this.#motion && arrivedAt - this.scrolledAt > SETTLE_MS) {
      // The page keeps animating after the scroll; its own frames are sharp again.
      this.#motion = false;
      this.#recent = [];
      void this.#start(1);
    }
    if (this.#settle) clearTimeout(this.#settle);
    this.#settle = setTimeout(() => {
      this.#settle = null;
      if (!this.#motion && !this.#mayHaveDropped) return;
      this.#mayHaveDropped = false;
      if (this.#motion) {
        this.#motion = false;
        this.#recent = [];
        void this.#start(1);
      }
      void this.pushStill();
    }, SETTLE_MS);
    let acked = false;
    const ack = () => {
      if (acked) return;
      acked = true;
      setTimeout(() => {
        this.#framesInFlight = Math.max(0, this.#framesInFlight - 1);
        void session.send("Page.screencastFrameAck", { sessionId: params.sessionId }).catch(() => {});
      }, Math.max(0, arrivedAt + ACK_PACE_MS[this.options.pace] - Date.now()));
    };
    this.push({ type: "frame", data: Buffer.from(String(params.data ?? ""), "base64"), metadata: params.metadata as FrameMetadata, still: false, ack });
  }

  /** A picture of the page as it is now, at this viewer's size; a scaled one pauses every viewer of the tab. */
  async pushStill(): Promise<void> {
    const tab = this.tab;
    const session = this.#session;
    if (!tab || !session || session.detached || this.#hidden || this.closed) return;
    try {
      const metrics = await session.send<{ cssVisualViewport: { pageX: number; pageY: number; clientWidth: number; clientHeight: number; scale?: number } }>("Page.getLayoutMetrics");
      const view = metrics.cssVisualViewport;
      const ratio = await tab.page.devicePixelRatio();
      const scale = Math.min(1, this.options.maxWidth / Math.max(1, view.clientWidth * ratio), this.options.maxHeight / Math.max(1, view.clientHeight * ratio));
      const capture = () => session.send<{ data: string }>("Page.captureScreenshot", {
        format: "jpeg",
        quality: this.options.quality,
        ...(scale < 1 ? { clip: { x: view.pageX, y: view.pageY, width: view.clientWidth, height: view.clientHeight, scale } } : {}),
      });
      const { data } = scale < 1 ? await this.#hub.paused(tab, capture) : await capture();
      if (this.closed || session !== this.#session) return;
      this.push({
        type: "frame",
        data: Buffer.from(data, "base64"),
        metadata: { deviceWidth: view.clientWidth, deviceHeight: view.clientHeight, offsetTop: 0, pageScaleFactor: view.scale ?? 1, scrollOffsetX: view.pageX, scrollOffsetY: view.pageY, timestamp: Date.now() / 1000 },
        still: true,
        ack: () => {},
      });
    } catch {}
  }

  /** keyUp and mouseUp for everything this viewer still holds, on the session it pressed them on. */
  async releaseInput(): Promise<boolean> {
    const session = this.#session;
    let clean = true;
    for (const { key, code } of this.pressedKeys.values()) {
      if (!session || session.detached) { clean = false; break; }
      await session.send("Input.dispatchKeyEvent", { type: "keyUp", key, code }).catch(() => { clean = false; });
    }
    this.pressedKeys.clear();
    for (const [button, point] of this.pressedButtons) {
      if (!session || session.detached) { clean = false; break; }
      await session.send("Input.dispatchMouseEvent", { type: "mouseReleased", button, ...point, buttons: 0, clickCount: 1 }).catch(() => { clean = false; });
    }
    this.pressedButtons.clear();
    return clean;
  }

  /** One message from the viewer. Input runs only while this viewer controls the browser; anything else is dropped. */
  async input(raw: unknown): Promise<void> {
    if (this.closed || !this.options.canOperate) return;
    const message = record(raw);
    if (!message) return;
    try {
      await this.#hub.input(this, message);
    } catch {
      this.#hub.broadcastControl();
    }
  }

  /** The tabs as they are now, as agent-browser's stream sent them after every change of the page. */
  pushTabs(): void {
    this.#hub.pushTabs(this);
  }

  /** Everything a viewer that just started listening needs: who controls, the size, the tabs, and a picture. */
  async refresh(): Promise<void> {
    this.push(this.#hub.statusFor());
    this.push(this.#hub.controlFor(this));
    this.#hub.pushTabs(this);
    await this.pushStill();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.#hub.detach(this);
  }

  async teardown(): Promise<void> {
    this.closed = true;
    await this.#unbind();
  }
}

/** A profile's viewers: their sizes, their screencasts, and what they may do. */
export class ViewerHub {
  readonly host: HubHost;
  readonly viewers = new Set<Viewer>();
  setting: ViewportSetting = { mode: "fill" };
  #order = 0;
  #pointerSequence = 0;
  #capturing = new Map<Tab, number>();
  #applied: string | null = null;
  /** The page size last applied, which viewers map their input with. */
  #shown: { width: number; height: number } | null = null;
  #emulated = false;
  #applying: Promise<void> = Promise.resolve();

  constructor(host: HubHost) {
    this.host = host;
  }

  get size(): number {
    return this.viewers.size;
  }

  /** Someone watching could answer a site's HTTP sign-in. */
  answersAuth(): boolean {
    return [...this.viewers].some((viewer) => viewer.options.canOperate && viewer.options.authPrompts);
  }

  /** The page size now: the setting's, or in fill mode the size the latest viewer still watching asked for, within the screen. */
  viewport(): { width: number; height: number } {
    const latest = [...this.viewers].map((viewer) => viewer.requested).filter((size) => size !== null).sort((a, b) => b.order - a.order)[0] ?? null;
    return viewportFor(this.setting, latest ? { width: latest.width, height: latest.height } : null, this.host.pageLimit());
  }

  /** Resizes the real window; only a preset narrower than any Chrome window is emulated, as DevTools' device mode does. */
  applyViewport(): Promise<void> {
    this.#applying = this.#applying.then(() => this.#apply(), () => this.#apply());
    return this.#applying;
  }

  async #apply(): Promise<void> {
    const browser = this.host.browser();
    if (!browser) return;
    const size = this.viewport();
    const emulated = size.width < MIN_WINDOW_WIDTH;
    const key = appliedKey(size);
    const active = this.host.active();
    if (this.#applied === key && browser.viewport?.width === Math.max(size.width, MIN_WINDOW_WIDTH)) return;
    this.#applied = key;
    // The window is fitted by measuring the page, which an emulated size would misreport.
    if (this.#emulated) {
      for (const tab of this.host.tabs()) await tab.page.emulateSize(null).catch(() => {});
      this.#emulated = false;
    }
    const fitted = await browser.setViewport({ width: Math.max(size.width, MIN_WINDOW_WIDTH), height: size.height }).catch(() => null);
    if (emulated) {
      for (const tab of this.host.tabs()) await tab.page.emulateSize(size).catch(() => {});
      this.#emulated = true;
    }
    // Chrome's first tab carries a bar the others lack, so a window held to its screen can give it a shorter page.
    const shown = emulated || !fitted ? size : fitted;
    this.#shown = shown;
    if (active) this.broadcast({ type: "viewport", ...shown, setting: this.setting });
    this.broadcastStatus();
  }

  /** A size a viewer asks for waits for the action running on the tab in front: a bot's click aims at the page as it was laid out. */
  #resizeForViewers(): Promise<void> {
    const tab = this.host.active();
    if (!tab || this.#applied === appliedKey(this.viewport())) return this.applyViewport();
    return Promise.resolve().then(() => tab.control.system(() => this.applyViewport())).catch(() => this.applyViewport());
  }

  /** A tab came to the front or opened: its window takes the current size. */
  async fit(): Promise<void> {
    this.#applied = null;
    await this.applyViewport();
  }

  async attach(options: ViewerOptions, push: (output: ViewerOutput) => void): Promise<Viewer> {
    const viewer = new Viewer(this, options, push);
    const size = options.size ? requestedSize(options.size.width, options.size.height) : null;
    if (size && options.canOperate) viewer.requested = { ...size, order: ++this.#order };
    this.viewers.add(viewer);
    try {
      viewer.push({ type: "starting" });
      await this.host.running();
      if (viewer.closed) return viewer;
      const owner = this.host.control.owner;
      await viewer.hide(owner !== null && owner !== viewer.id);
      void this.#resizeForViewers().catch(() => undefined);
      viewer.push(this.controlFor(viewer));
      viewer.push({ type: "viewport", ...(this.#shown ?? this.viewport()), setting: this.setting });
      this.pushTabs(viewer);
      viewer.push(this.statusFor());
      await viewer.bind(this.host.active());
      return viewer;
    } catch (error) {
      await this.detach(viewer);
      throw error;
    }
  }

  async detach(viewer: Viewer): Promise<void> {
    if (!this.viewers.has(viewer)) return;
    this.viewers.delete(viewer);
    if (this.host.control.owner === viewer.id) await this.host.release(viewer.id, () => viewer.releaseInput()).catch(() => {});
    else await viewer.releaseInput();
    await viewer.teardown();
    this.broadcastControl();
    if (viewer.requested) void this.#resizeForViewers().catch(() => undefined);
  }

  broadcast(output: ViewerOutput, { holderOnly = false }: { holderOnly?: boolean } = {}): void {
    const owner = this.host.control.owner;
    for (const viewer of this.viewers) {
      if (holderOnly && owner !== viewer.id) continue;
      if (!holderOnly && owner !== null && owner !== viewer.id && (output.type === "tabs" || output.type === "url" || output.type === "pointer")) continue;
      viewer.push(output);
    }
  }

  controlFor(viewer: Viewer): ViewerOutput {
    const control = this.host.control;
    const owner = control.owner;
    const dialog = this.host.active()?.page.dialogs.pending ?? null;
    return {
      type: "control",
      canOperate: viewer.options.canOperate,
      controller: owner === viewer.id ? "you" : owner !== null ? "another-viewer" : control.agents > 0 ? "agent" : "unclaimed",
      held: owner !== null,
      owned: owner === viewer.id,
      controlling: control.canControl(viewer.id),
      stale: control.stale,
      generation: this.host.active()?.control.generation ?? 0,
      dialog: dialog ? { type: dialog.type, message: dialog.message, defaultValue: dialog.defaultPrompt } : null,
    };
  }

  broadcastControl(): void {
    const owner = this.host.control.owner;
    for (const viewer of this.viewers) {
      void viewer.hide(owner !== null && owner !== viewer.id);
      viewer.push(this.controlFor(viewer));
    }
  }

  tabsMessage(): ViewerOutput {
    const active = this.host.active();
    return { type: "tabs", tabs: this.host.tabs().slice(0, 100).map((tab) => ({ tabId: tab.id, title: tab.page.title().slice(0, 512), url: tab.page.url(), active: tab === active })) };
  }

  pushTabs(viewer: Viewer): void {
    const owner = this.host.control.owner;
    if (owner !== null && owner !== viewer.id) return;
    viewer.push(this.tabsMessage());
    const active = this.host.active();
    if (active) viewer.push({ type: "url", url: active.page.url() });
  }

  statusFor(): ViewerOutput {
    const browser = this.host.browser();
    const size = browser?.viewport ?? this.viewport();
    return { type: "status", connected: browser !== null && browser.connected, screencasting: this.viewers.size > 0, viewportWidth: size.width, viewportHeight: size.height };
  }

  broadcastStatus(): void {
    this.broadcast(this.statusFor());
  }

  /** The tab in front, or the tabs, changed. A page narrower than any window is emulated on every tab, new ones too. */
  tabsChanged(): void {
    const active = this.host.active();
    this.broadcast(this.tabsMessage());
    if (active) this.broadcast({ type: "url", url: active.page.url() });
    for (const viewer of this.viewers) void viewer.bind(active);
    if (this.#emulated) void this.fit().catch(() => undefined);
  }

  titlesChanged(): void {
    this.broadcast(this.tabsMessage());
  }

  urlChanged(tab: Tab): void {
    if (tab !== this.host.active()) return;
    this.broadcast({ type: "url", url: tab.page.url() });
    this.broadcast(this.tabsMessage());
  }

  started(): void {
    this.#applied = null;
    void this.applyViewport().then(() => this.tabsChanged()).catch(() => undefined);
  }

  stopped(reason: string): void {
    this.#applied = null;
    for (const viewer of this.viewers) {
      void viewer.bind(null);
      viewer.push({ type: "gone", reason });
    }
  }

  downloaded(download: Download): void {
    if (download.state !== "completed") return;
    this.broadcast({ type: "download", id: download.id, fileName: download.fileName, sizeBytes: download.receivedBytes }, { holderOnly: true });
  }

  popup(tab: Tab): void {
    this.broadcast({ type: "popup", tabId: tab.id }, { holderOnly: true });
  }

  /** The agent's pointer glides to where it acts and pulses before a press, for people watching the tab who can see it. */
  pointer(tab: Tab): PointerReporter | undefined {
    const drawing = () => [...this.viewers].filter((viewer) => viewer.tab === tab && viewer.options.pointer);
    if (drawing().length === 0) return undefined;
    return async ({ x, y }, phase) => {
      const show = (next: "move" | "click") => {
        const sequence = ++this.#pointerSequence;
        for (const viewer of drawing()) viewer.push({ type: "pointer", phase: next, x, y, sequence });
      };
      show("move");
      await sleep(AGENT_CURSOR_MOVE_MS);
      if (phase !== "click") return;
      show("click");
      await sleep(AGENT_CURSOR_CLICK_LEAD_MS);
    };
  }

  /** Scaled captures repaint every screencast of the tab, so those pause until it is done. */
  async paused<T>(tab: Tab, work: () => Promise<T>): Promise<T> {
    const watching = [...this.viewers].filter((viewer) => viewer.tab === tab);
    this.#capturing.set(tab, (this.#capturing.get(tab) ?? 0) + 1);
    await Promise.all(watching.map((viewer) => viewer.pause()));
    try {
      return await work();
    } finally {
      this.#capturing.set(tab, (this.#capturing.get(tab) ?? 1) - 1);
      await Promise.all(watching.map((viewer) => viewer.resume()));
    }
  }

  async input(viewer: Viewer, message: Record<string, unknown>): Promise<void> {
    const control = this.host.control;
    switch (message.type) {
      case "takeControl": {
        const taking = this.host.take(viewer.id);
        this.broadcastControl();
        await taking.finally(() => this.broadcastControl());
        return;
      }
      case "releaseControl": {
        const releasing = this.host.release(viewer.id, () => viewer.releaseInput());
        this.broadcastControl();
        await releasing.finally(() => this.broadcastControl());
        return;
      }
      case "resize": {
        const size = requestedSize(message.width, message.height);
        if (!size || (control.owner !== null && control.owner !== viewer.id)) return;
        viewer.requested = { ...size, order: ++this.#order };
        if (this.setting.mode === "fill") await this.#resizeForViewers();
        return;
      }
      case "viewport": {
        if (!control.canControl(viewer.id)) return;
        const setting = parseSetting(message.setting);
        if (!setting) return;
        this.setting = setting;
        await this.#resizeForViewers();
        return;
      }
    }
    const tab = this.host.active();
    if (!tab || !control.canControl(viewer.id)) {
      this.broadcastControl();
      return;
    }
    switch (message.type) {
      case "dialog":
        if (typeof message.accept === "boolean") await tab.page.answerDialog({ accept: message.accept, ...(typeof message.promptText === "string" ? { promptText: message.promptText.slice(0, 4_000) } : {}) });
        this.broadcastControl();
        return;
      case "authAnswer":
        if (typeof message.username === "string" && typeof message.password === "string") await tab.page.auth.answer({ username: message.username.slice(0, 1_024), password: message.password.slice(0, 1_024) });
        else await tab.page.auth.answer(null);
        return;
      case "tabSelect": {
        const next = typeof message.tabId === "string" ? this.host.tab(message.tabId) : undefined;
        if (next) await control.human(viewer.id, next, () => this.host.showTab(next));
        return;
      }
      case "tabNew":
        await this.host.openTab(typeof message.url === "string" ? message.url : null, viewer.id);
        return;
      case "tabClose": {
        const closing = typeof message.tabId === "string" ? this.host.tab(message.tabId) : undefined;
        if (closing) await this.host.closeTab(closing);
        return;
      }
    }
    await control.human(viewer.id, tab, () => this.#dispatch(viewer, tab, message));
  }

  async #dispatch(viewer: Viewer, tab: Tab, message: Record<string, unknown>): Promise<void> {
    const session = viewer.session;
    if (!session || session.detached || viewer.tab !== tab) return;
    const modifiers = modifiersOf(message);
    switch (message.type) {
      case "mouse": {
        const action = message.action;
        const type = action === "down" ? "mousePressed" : action === "up" ? "mouseReleased" : "mouseMoved";
        const button = (["none", "left", "middle", "right"] as const).find((candidate) => candidate === message.button) ?? "none";
        const x = num(message.x);
        const y = num(message.y);
        if (type === "mousePressed" && button !== "none" && viewer.pressedButtons.size >= HELD_LIMIT) return;
        await session.send("Input.dispatchMouseEvent", {
          type, x, y, button,
          buttons: num(message.buttons, [...viewer.pressedButtons.keys()].reduce((bits, held) => bits | (held === "left" ? 1 : held === "right" ? 2 : 4), 0)),
          clickCount: num(message.clickCount, type === "mouseMoved" ? 0 : 1),
          modifiers,
        });
        if (button !== "none") {
          if (action === "down") viewer.pressedButtons.set(button, { x, y });
          else if (action === "up") viewer.pressedButtons.delete(button);
        }
        return;
      }
      case "wheel":
        viewer.scrolledAt = Date.now();
        await session.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: num(message.x), y: num(message.y), deltaX: num(message.deltaX), deltaY: num(message.deltaY), modifiers });
        return;
      case "key": {
        const key = typeof message.key === "string" ? message.key.slice(0, 64) : "";
        const code = typeof message.code === "string" ? message.code.slice(0, 64) : "";
        if (!key && !code) return;
        if (message.action === "up") {
          await session.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, modifiers });
          viewer.pressedKeys.delete(code || key);
          return;
        }
        if (viewer.pressedKeys.size >= HELD_LIMIT && !viewer.pressedKeys.has(code || key)) return;
        const named = US_KEYBOARD[code] ?? US_KEYBOARD[key];
        const layout = named ? keyDescription(US_KEYBOARD[code] ? code : key, modifiers) : null;
        const text = typeof message.text === "string" ? message.text.slice(0, 16) : layout?.text || undefined;
        const commands = editingCommands(key, modifiers, this.host.browser()?.mac ?? process.platform === "darwin");
        const copying = commands[0] === "copy" || commands[0] === "cut";
        if (copying) await tab.page.takeCopiedText();
        await session.send("Input.dispatchKeyEvent", {
          type: text ? "keyDown" : "rawKeyDown",
          key, code, modifiers,
          ...(text ? { text, unmodifiedText: text } : {}),
          ...(commands.length ? { commands } : {}),
          windowsVirtualKeyCode: num(message.keyCode, layout?.keyCode ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0)),
        });
        viewer.pressedKeys.set(code || key, { key, code });
        if (copying) {
          const copied = await tab.page.takeCopiedText();
          if (copied) viewer.push({ type: "clipboard", text: copied });
        }
        return;
      }
      case "text":
        if (typeof message.text === "string" && message.text.length > 0) await session.send("Input.insertText", { text: message.text.slice(0, TEXT_LIMIT) });
        return;
      case "navigate": {
        const url = typeof message.url === "string" ? personUrl(message.url) : null;
        if (url) await tab.page.navigate(url, { readiness: "none", timeoutMs: 15_000 });
        return;
      }
      case "history":
        await (num(message.delta) < 0 ? tab.page.back({ readiness: "none" }) : tab.page.forward({ readiness: "none" }));
        return;
      case "reload":
        if (message.ignoreCache === true) await tab.page.session.send("Page.reload", { ignoreCache: true });
        else await tab.page.reload({ readiness: "none" });
        return;
      case "probe": {
        const x = num(message.x);
        const y = num(message.y);
        const editable = await valueInWorld<boolean>(tab.page.frames, tab.page.frames.mainFrameId, `${EDITABLE_AT_POINT}(${x}, ${y})`).catch(() => false);
        viewer.push({ type: "probe", x, y, editable: editable === true });
        return;
      }
    }
  }
}

/** An address a person typed: a bare host means https, loopback http; never credentials or another scheme. */
export function personUrl(raw: string): string | null {
  const text = raw.trim().slice(0, 8_192);
  if (!text || [...text].some((char) => char <= " " || char === "\u007f" || char === "\\")) return null;
  const candidate = /^[a-z][a-z\d+.-]*:\/\//iu.test(text) ? text : `${/^(?:localhost|127\.0\.0\.1|\[::1\])(?:[:/]|$)/iu.test(text) ? "http" : "https"}://${text}`;
  try {
    const url = new URL(candidate);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

function parseSetting(value: unknown): ViewportSetting | null {
  const setting = record(value);
  if (!setting) return null;
  if (setting.mode === "fill") return { mode: "fill" };
  if (setting.mode === "preset" && typeof setting.preset === "string" && setting.preset in VIEWPORT_PRESETS) {
    return { mode: "preset", preset: setting.preset as keyof typeof VIEWPORT_PRESETS, ...(setting.landscape === true ? { landscape: true } : {}) };
  }
  if (setting.mode === "fixed") {
    const size = requestedSize(setting.width, setting.height);
    return size ? { mode: "fixed", ...size } : null;
  }
  return null;
}
