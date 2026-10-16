import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { removeTempDir } from "../../testing/cleanup.ts";
import { BrowserService } from "../service.ts";
import { FakeBackend, FakeChrome, type FakeDocument } from "../testing/fake-chrome.ts";
import { ACK_PACE_MS, MIN_WINDOW_WIDTH, personUrl, requestedSize, SETTLE_MS, UNATTACHED_VIEWPORT, viewportFor, type ViewerOutput } from "./core.ts";

const folders: string[] = [];
const services: BrowserService[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map((service) => service.closeAll())); });
afterAll(async () => { for (const folder of folders) await removeTempDir(folder); });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(read: () => T, check: (value: T) => boolean, timeoutMs = 2_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (check(value)) return value;
    if (Date.now() > deadline) throw new Error(`still ${JSON.stringify(value)} after ${timeoutMs} ms`);
    await sleep(5);
  }
}

const same = (expected: unknown) => (actual: unknown) => JSON.stringify(actual) === JSON.stringify(expected);

const PAGE: FakeDocument = { title: "Page", text: "hello", elements: [{ role: "textbox", name: "Name", selector: "#name", editable: true, box: [10, 10, 200, 30] }] };

type WatchOptions = { size?: { width: number; height: number }; maxWidth?: number; maxHeight?: number; pace?: "hi" | "lo"; ack?: boolean; authPrompts?: boolean; pointer?: boolean };

async function setup({ pageLimit = null, document = PAGE }: { pageLimit?: { width: number; height: number } | null; document?: FakeDocument } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "omb-viewers-"));
  folders.push(dataDir);
  const backend = new FakeBackend(() => new FakeChrome({ documents: () => ({ ...document, elements: document.elements.map((element) => ({ ...element })) }) }), { pageLimit });
  const service = new BrowserService({ dataDir, backend: () => backend, maxRunning: 4, idleMs: () => 600_000, takeoverMs: 200 });
  services.push(service);
  const target = { session: "bot-a", key: "bot:a" };
  const call = (name: string, args: Record<string, unknown> = {}) => service.agentRpc(target, "tools/call", { name, arguments: args }) as Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }>;
  await call("agent_browser_open", { url: "https://example.com/" });
  const watch = async (options: WatchOptions = {}) => {
    const outputs: ViewerOutput[] = [];
    const viewer = await service.attachViewer(target, { owner: "local-owner", canOperate: true, maxWidth: options.maxWidth ?? 3200, maxHeight: options.maxHeight ?? 2000, pace: options.pace ?? "hi", authPrompts: options.authPrompts === true, ...(options.pointer === false ? { pointer: false } : {}), ...(options.size ? { size: options.size } : {}) }, (output) => {
      outputs.push(output);
      if (output.type === "frame" && options.ack !== false) output.ack();
    });
    return { viewer, outputs };
  };
  const chrome = () => backend.chrome;
  const page = () => [...chrome().pages.values()].at(-1)!;
  return { service, target, call, watch, chrome, page };
}

describe("the page fills the panel", () => {
  it("is 1280x800 with nobody watching, the viewer's panel size while one watches, and 1280x800 again when it leaves", async () => {
    const { watch, chrome } = await setup();
    expect(chrome().viewport).toEqual(UNATTACHED_VIEWPORT);
    const { viewer, outputs } = await watch({ size: { width: 1600, height: 1000 } });
    await until(() => chrome().viewport, same({ width: 1600, height: 1000 }));
    await until(() => outputs, (seen) => seen.some((output) => output.type === "viewport" && output.width === 1600 && output.height === 1000));
    await viewer.input({ type: "resize", width: 1200, height: 900 });
    expect(chrome().viewport).toEqual({ width: 1200, height: 900 });
    await viewer.close();
    await until(() => chrome().viewport, same(UNATTACHED_VIEWPORT));
  });

  it("follows the latest request, keeps its size for a collapsed panel, and stops at 3840x2160", async () => {
    const { watch, chrome } = await setup();
    const first = await watch({ size: { width: 1400, height: 900 } });
    const second = await watch({ size: { width: 1000, height: 700 } });
    await until(() => chrome().viewport, same({ width: 1000, height: 700 }));
    await first.viewer.input({ type: "resize", width: 1500, height: 950 });
    expect(chrome().viewport).toEqual({ width: 1500, height: 950 });
    await second.viewer.input({ type: "resize", width: 1800, height: 40 });
    expect(chrome().viewport).toEqual({ width: 1500, height: 950 });
    await second.viewer.input({ type: "resize", width: 9000, height: 9000 });
    expect(chrome().viewport).toEqual({ width: 3840, height: 2160 });
    await second.viewer.close();
    await until(() => chrome().viewport, same({ width: 1500, height: 950 }));
    expect(requestedSize(99, 500)).toBeNull();
    expect(requestedSize(100.4, 100)).toEqual({ width: 100, height: 100 });
  });

  it("waits for the bot's running action before it resizes the page, and lets the viewer in at once", async () => {
    const { watch, chrome, call } = await setup();
    chrome().delay = (method) => (method === "Accessibility.getFullAXTree" ? 800 : 0);
    const snapshot = call("agent_browser_snapshot");
    await sleep(30);
    const started = Date.now();
    const { viewer, outputs } = await watch({ size: { width: 1600, height: 1000 } });
    expect(Date.now() - started).toBeLessThan(500);
    expect(outputs).toContainEqual(expect.objectContaining({ type: "viewport", ...UNATTACHED_VIEWPORT }));
    const resizing = viewer.input({ type: "resize", width: 1200, height: 900 });
    await sleep(100);
    expect(chrome().viewport).toEqual(UNATTACHED_VIEWPORT);
    expect((await snapshot).isError).toBeUndefined();
    await resizing;
    await until(() => chrome().viewport, same({ width: 1200, height: 900 }));
  });

  it("never makes a window larger than its screen: a filled panel keeps its shape, a set size its width", async () => {
    const { watch, chrome, page } = await setup({ pageLimit: { width: 1440, height: 757 } });
    expect(chrome().viewport).toEqual({ width: 1211, height: 757 });
    const { viewer, outputs } = await watch({ size: { width: 1600, height: 1000 } });
    await until(() => chrome().viewport, same({ width: 1211, height: 757 }));
    await viewer.input({ type: "resize", width: 1000, height: 700 });
    expect(chrome().viewport).toEqual({ width: 1000, height: 700 });
    await viewer.input({ type: "resize", width: 2000, height: 800 });
    expect(chrome().viewport).toEqual({ width: 1440, height: 576 });
    await viewer.input({ type: "takeControl" });
    await viewer.input({ type: "viewport", setting: { mode: "preset", preset: "tablet" } });
    expect(chrome().viewport).toEqual({ width: 820, height: 757 });
    await viewer.input({ type: "viewport", setting: { mode: "preset", preset: "phone" } });
    expect(chrome().viewport).toEqual({ width: MIN_WINDOW_WIDTH, height: 757 });
    expect(chrome().sentTo(page())).toContainEqual(expect.objectContaining({ method: "Emulation.setDeviceMetricsOverride", params: expect.objectContaining({ width: 390, height: 757 }) }));
    expect(outputs.filter((output) => output.type === "viewport").at(-1)).toMatchObject({ width: 390, height: 757 });
    expect(chrome().window.height).toBeLessThanOrEqual(757 + 143);
  });

  it("resizes the real window, so a page narrower than any window comes from a preset only, emulated", async () => {
    const { watch, chrome, page } = await setup();
    const { viewer } = await watch({ size: { width: 1600, height: 1000 } });
    expect(chrome().sentTo(page()).some((sent) => sent.method === "Emulation.setDeviceMetricsOverride")).toBe(false);
    await viewer.input({ type: "takeControl" });
    await viewer.input({ type: "viewport", setting: { mode: "preset", preset: "tablet" } });
    expect(chrome().viewport).toEqual({ width: 820, height: 1180 });
    await viewer.input({ type: "viewport", setting: { mode: "preset", preset: "phone" } });
    expect(chrome().viewport).toEqual({ width: MIN_WINDOW_WIDTH, height: 844 });
    expect(chrome().sentTo(page())).toContainEqual(expect.objectContaining({ method: "Emulation.setDeviceMetricsOverride", params: expect.objectContaining({ width: 390, height: 844, deviceScaleFactor: 2, mobile: false }) }));
    await viewer.input({ type: "viewport", setting: { mode: "fill" } });
    expect(chrome().viewport).toEqual({ width: 1600, height: 1000 });
    expect(chrome().sentTo(page()).some((sent) => sent.method === "Emulation.clearDeviceMetricsOverride")).toBe(true);
    expect(viewportFor({ mode: "preset", preset: "phone", landscape: true }, null)).toEqual({ width: 844, height: 390 });
  });

  it("tells viewers the page a window held to its screen leaves a tab with a taller bar", async () => {
    const { watch, chrome, page } = await setup({ pageLimit: { width: 1440, height: 757 } });
    page().bar = 56;
    const { viewer, outputs } = await watch({ size: { width: 1600, height: 1000 } });
    await viewer.input({ type: "resize", width: 1000, height: 900 });
    expect(chrome().window.height).toBe(757 + 143);
    expect(outputs.filter((output) => output.type === "viewport").at(-1)).toMatchObject({ width: 841, height: 701 });
  });

  it("emulates a page narrower than any window on a tab that opens later too", async () => {
    const { watch, chrome, call } = await setup();
    const { viewer } = await watch();
    await viewer.input({ type: "takeControl" });
    await viewer.input({ type: "viewport", setting: { mode: "preset", preset: "phone" } });
    await viewer.input({ type: "releaseControl" });
    expect((await call("agent_browser_tabs", { action: "new" })).isError).toBeUndefined();
    const opened = [...chrome().pages.values()].at(-1)!;
    await until(() => opened.emulated ?? null, same({ width: 390, height: 844 }));
    const resizes = () => chrome().sent.filter((sent) => sent.method === "Browser.setWindowBounds").length;
    const before = resizes();
    expect((await call("agent_browser_tabs", { action: "switch", tab: "t1" })).isError).toBeUndefined();
    expect(resizes()).toBe(before);
    expect(chrome().window.width).toBe(MIN_WINDOW_WIDTH);
  });
});

describe("a viewer's screencast", () => {
  it("is JPEG at quality 70, as large as the viewer can show, from its own session", async () => {
    const { watch, chrome } = await setup();
    const { outputs } = await watch({ maxWidth: 3200, maxHeight: 2000 });
    const started = chrome().sent.filter((sent) => sent.method === "Page.startScreencast");
    expect(started.at(-1)).toMatchObject({ params: { format: "jpeg", quality: 70, maxWidth: 3200, maxHeight: 2000 } });
    expect(started.at(-1)!.sessionId).toMatch(/^V/);
    await sleep(20);
    expect(outputs.some((output) => output.type === "frame")).toBe(true);
  });

  it("acks each frame no sooner than its pace after it arrived, and not before the viewer acked it", async () => {
    const { watch, chrome, page } = await setup();
    const { outputs } = await watch({ ack: false });
    await sleep(20);
    const frame = outputs.find((output): output is Extract<ViewerOutput, { type: "frame" }> => output.type === "frame" && !output.still)!;
    await sleep(ACK_PACE_MS.hi + 20);
    const acks = () => chrome().sent.filter((sent) => sent.method === "Page.screencastFrameAck").length;
    expect(acks()).toBe(0);
    const acked = Date.now();
    frame.ack();
    await sleep(10);
    expect(acks()).toBe(1);
    expect(Date.now() - acked).toBeLessThan(ACK_PACE_MS.hi);
    expect(page().screencasts.size).toBe(1);
  });

  it("drops to half size at quality 50 while the person scrolls, then sends a sharp still once it settles", async () => {
    const { watch, chrome, page } = await setup();
    const { viewer, outputs } = await watch();
    await viewer.input({ type: "takeControl" });
    const stillsBefore = outputs.filter((output) => output.type === "frame" && output.still).length;
    await viewer.input({ type: "wheel", x: 100, y: 100, deltaX: 0, deltaY: 300 });
    for (let i = 0; i < 4; i++) {
      chrome().paint(page());
      await sleep(15);
    }
    const restarts = chrome().sent.filter((sent) => sent.method === "Page.startScreencast").map((sent) => sent.params);
    expect(restarts).toContainEqual(expect.objectContaining({ quality: 50, maxWidth: 1600, maxHeight: 1000 }));
    await sleep(SETTLE_MS + 100);
    expect(chrome().sent.filter((sent) => sent.method === "Page.startScreencast").at(-1)?.params).toMatchObject({ quality: 70, maxWidth: 3200 });
    expect(outputs.filter((output) => output.type === "frame" && output.still).length).toBe(stillsBefore + 1);
  });

  it("stops every screencast on the tab while the bot takes a screenshot, then starts them again", async () => {
    const { service, target, watch, chrome } = await setup();
    await watch();
    const before = chrome().sent.length;
    await service.agentRpc(target, "tools/call", { name: "agent_browser_screenshot", arguments: {} });
    const order = chrome().sent.slice(before).map((sent) => sent.method).filter((method) => ["Page.stopScreencast", "Page.captureScreenshot", "Page.startScreencast"].includes(method));
    expect(order.indexOf("Page.stopScreencast")).toBeLessThan(order.indexOf("Page.captureScreenshot"));
    expect(order.lastIndexOf("Page.startScreencast")).toBeGreaterThan(order.indexOf("Page.captureScreenshot"));
  });
});

describe("viewers of one browser", () => {
  it("shows a viewer that does not hold the browser no frames, tabs or address while another holds it, and ignores its sizes", async () => {
    const { watch, chrome } = await setup();
    const holder = await watch({ size: { width: 1400, height: 900 } });
    const other = await watch({ size: { width: 1000, height: 700 } });
    const beforeTake = other.outputs.length;
    await holder.viewer.input({ type: "takeControl" });
    expect(other.outputs.slice(beforeTake)).toContainEqual(expect.objectContaining({ type: "control", controller: "another-viewer", held: true, owned: false }));
    const seen = other.outputs.length;
    await other.viewer.input({ type: "resize", width: 1100, height: 800 });
    expect(chrome().viewport).toEqual({ width: 1000, height: 700 });
    await holder.viewer.input({ type: "navigate", url: "example.org/next" });
    await sleep(30);
    const later = other.outputs.slice(seen);
    expect(later.filter((output) => ["frame", "tabs", "url"].includes(output.type))).toEqual([]);
    await holder.viewer.input({ type: "releaseControl" });
    await sleep(30);
    expect(other.outputs.slice(seen).some((output) => output.type === "frame")).toBe(true);
  });

  it("asks the person holding the browser for an HTTP sign-in, and answers the page with what they typed", async () => {
    const { service, target, watch, chrome, page } = await setup();
    const { viewer, outputs } = await watch({ authPrompts: true });
    await viewer.input({ type: "takeControl" });
    const session = chrome().sent.find((sent) => sent.method === "Fetch.enable")?.sessionId;
    expect(session).toBeTruthy();
    chrome().event("Fetch.authRequired", { requestId: "auth-1", authChallenge: { source: "Server", origin: "https://intranet.example", scheme: "basic", realm: "Staff" } }, session!);
    await sleep(10);
    expect(outputs).toContainEqual({ type: "authPrompt", origin: "https://intranet.example", realm: "Staff" });
    await viewer.input({ type: "authAnswer", username: "ada", password: "secret" });
    expect(chrome().sentTo(page())).toContainEqual(expect.objectContaining({ method: "Fetch.continueWithAuth", params: { requestId: "auth-1", authChallengeResponse: { response: "ProvideCredentials", username: "ada", password: "secret" } } }));
    expect(service.heldBy(target.session)).toBe(viewer.id);
  });

  it("cancels an HTTP sign-in at once when no one watching can answer it, so the site's refusal shows", async () => {
    const { watch, chrome, page } = await setup();
    const { outputs } = await watch();
    const session = chrome().sent.find((sent) => sent.method === "Fetch.enable")?.sessionId;
    chrome().event("Fetch.authRequired", { requestId: "auth-2", authChallenge: { source: "Server", origin: "https://intranet.example", scheme: "basic", realm: "Staff" } }, session!);
    await sleep(10);
    expect(outputs.some((output) => output.type === "authPrompt")).toBe(false);
    expect(chrome().sentTo(page())).toContainEqual(expect.objectContaining({ method: "Fetch.continueWithAuth", params: { requestId: "auth-2", authChallengeResponse: { response: "CancelAuth" } } }));
  });

  it("takes only web addresses from a person, never credentials or other schemes", () => {
    expect(personUrl("example.com")).toBe("https://example.com/");
    expect(personUrl("localhost:5173/app")).toBe("http://localhost:5173/app");
    for (const refused of ["javascript:alert(1)", "file:///etc/passwd", "https://a:b@example.com", "data:text/html,x", "https://example.com/\nx"]) expect(personUrl(refused)).toBeNull();
  });
});
