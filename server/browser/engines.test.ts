import { describe, expect, it, vi } from "vitest";

import type { BrowserLive } from "../browser-live.ts";
import type { BrowserRuntime } from "../browser-runtime.ts";
import { CHROME_ENGINE, chromeTarget, LiveRouter, profileKey, RuntimeRouter, type ChromeEngine } from "./engines.ts";

const AGENT_BROWSER = { command: "/opt/agent-browser", args: ["--session", "s"], env: { AGENT_BROWSER_SESSION: "s" } };
const CHROME = { command: CHROME_ENGINE, args: ["bot:a"], env: {} };

function engines() {
  const old = {
    agentRpc: vi.fn(async () => "agent-browser"),
    previewFrame: vi.fn(async (_session: string, capture: () => Promise<unknown>) => capture()),
    withSecretInput: vi.fn(async (_session: string, _spec: unknown, fn: () => Promise<unknown>) => fn()),
    heldBy: vi.fn(() => "person"),
    interrupted: vi.fn(() => false),
    interruptedCount: vi.fn(() => 1),
    closeIfIdle: vi.fn(async () => true),
    close: vi.fn(async () => undefined),
    closeAll: vi.fn(async () => undefined),
  };
  const oldLive = { open: vi.fn(async () => undefined), action: vi.fn(async () => "agent-browser"), handBack: vi.fn(), closeForSession: vi.fn(), closeForOwner: vi.fn(), closeForBot: vi.fn(), closeAll: vi.fn() };
  const chrome = {
    service: {
      agentRpc: vi.fn(async () => "chrome"),
      previewFrame: vi.fn(async () => ({ png: "frame", format: "jpeg" })),
      withSecretInput: vi.fn(async (_target: unknown, fn: () => Promise<unknown>) => fn()),
      heldBy: vi.fn((): string | null => null),
      interrupted: vi.fn(() => true),
      interruptedCount: vi.fn(() => 2),
      close: vi.fn(async () => undefined),
    },
    live: { open: vi.fn(async () => undefined), action: vi.fn(async () => "chrome"), has: vi.fn((viewerId: string) => viewerId === "v-chrome"), handBack: vi.fn(), closeForSession: vi.fn(), closeForOwner: vi.fn(), closeForBot: vi.fn(), closeAll: vi.fn() },
    close: vi.fn(async () => undefined),
  };
  const runtime = new RuntimeRouter(old as unknown as BrowserRuntime, chrome as unknown as ChromeEngine);
  const live = new LiveRouter(oldLive as unknown as BrowserLive, chrome as unknown as ChromeEngine);
  return { old, oldLive, chrome, runtime, live };
}

describe("which engine runs a session", () => {
  it("is the new engine only for a spec that names a profile key", () => {
    expect(chromeTarget("s", CHROME)).toEqual({ session: "s", key: "bot:a" });
    expect(chromeTarget("s", AGENT_BROWSER)).toBeNull();
    expect(chromeTarget("s", { command: CHROME_ENGINE, args: [] })).toBeNull();
    expect(chromeTarget("s", undefined)).toBeNull();
  });

  it("gives a bot its own profile, a shared profile's bots one profile, and a temporary browser its session's", () => {
    expect(profileKey("a", "omb-a", { guest: false, partitionId: null })).toBe("bot:a");
    expect(profileKey("a", "omb-p", { guest: false, partitionId: "p1" })).toBe("shared:p1");
    expect(profileKey("a", "omb-a-guest-1", { guest: true, partitionId: null })).toBe("temp:omb-a-guest-1");
  });
});

describe("the runtime router", () => {
  it("sends a new-engine session's calls to the browser service and every other to agent-browser", async () => {
    const { old, chrome, runtime } = engines();
    await expect(runtime.agentRpc("s", CHROME, "tools/call", { name: "agent_browser_open" })).resolves.toBe("chrome");
    expect(chrome.service.agentRpc).toHaveBeenCalledWith({ session: "s", key: "bot:a" }, "tools/call", { name: "agent_browser_open" }, undefined);
    await expect(runtime.agentRpc("s", AGENT_BROWSER, "tools/list", {})).resolves.toBe("agent-browser");
    expect(old.agentRpc).toHaveBeenCalledOnce();
    expect(chrome.service.agentRpc).toHaveBeenCalledOnce();
  });

  it("takes a preview frame from the engine the spec names", async () => {
    const { old, chrome, runtime } = engines();
    await expect(runtime.previewFrame("s", async () => "relayed", CHROME)).resolves.toEqual({ png: "frame", format: "jpeg" });
    await expect(runtime.previewFrame("s", async () => "relayed", AGENT_BROWSER)).resolves.toBe("relayed");
    expect(chrome.service.previewFrame).toHaveBeenCalledOnce();
    expect(old.previewFrame).toHaveBeenCalledOnce();
  });

  it("leaves idle closing of new-engine browsers to the service", async () => {
    const { old, runtime } = engines();
    await expect(runtime.closeIfIdle("s", 1000, CHROME)).resolves.toBe(false);
    expect(old.closeIfIdle).not.toHaveBeenCalled();
    await expect(runtime.closeIfIdle("s", 1000, AGENT_BROWSER)).resolves.toBe(true);
    expect(old.closeIfIdle).toHaveBeenCalledWith("s", 1000, AGENT_BROWSER);
  });

  it("answers who holds a session and what was interrupted across both engines", () => {
    const { chrome, runtime } = engines();
    expect(runtime.heldBy("s")).toBe("person");
    chrome.service.heldBy.mockReturnValue("viewer-1");
    expect(runtime.heldBy("s")).toBe("viewer-1");
    expect(runtime.interrupted("s")).toBe(true);
    expect(runtime.interruptedCount()).toBe(3);
  });
});

describe("the live view router", () => {
  it("opens a new-engine session's viewer on the v1 adapter, without the spec, and any other on agent-browser's", async () => {
    const { oldLive, chrome, live } = engines();
    const res = {} as never;
    const isCurrent = () => true;
    await live.open({ botId: "a", session: "s", spec: CHROME, owner: "o", isCurrent, res });
    expect(chrome.live.open).toHaveBeenCalledWith({ botId: "a", session: "s", owner: "o", isCurrent, res });
    await live.open({ botId: "a", session: "s", spec: AGENT_BROWSER, owner: "o", isCurrent, res });
    expect(oldLive.open).toHaveBeenCalledOnce();
  });

  it("sends an action to the engine whose viewer sent it", async () => {
    const { oldLive, live } = engines();
    await expect(live.action({ viewerId: "v-chrome", botId: "a", owner: "o", body: { type: "take" } })).resolves.toBe("chrome");
    await expect(live.action({ viewerId: "v-old", botId: "a", owner: "o", body: { type: "take" } })).resolves.toBe("agent-browser");
    expect(oldLive.action).toHaveBeenCalledOnce();
  });

  it("closes viewers on both engines", () => {
    const { oldLive, chrome, live } = engines();
    live.closeForSession("s");
    live.closeAll();
    expect(chrome.live.closeForSession).toHaveBeenCalledWith("s");
    expect(oldLive.closeForSession).toHaveBeenCalledWith("s");
    expect(chrome.live.closeAll).toHaveBeenCalledOnce();
    expect(oldLive.closeAll).toHaveBeenCalledOnce();
  });
});
