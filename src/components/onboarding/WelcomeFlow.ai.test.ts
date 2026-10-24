// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import type { Bot, InstanceInfo } from "@/state/store";

const f = vi.hoisted(() => ({ state: {} as { instances: InstanceInfo[]; config: object; cloudAdd: null; bots: Bot[] }, dispatch: vi.fn() }));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: f.state, dispatch: f.dispatch }), api: async () => ({ instances: f.state.instances }) }));
vi.mock("@/lib/analytics", () => ({ track: vi.fn(), setEmailGateDone: vi.fn() }));
vi.mock("@/components/Avatar", () => ({ MausAvatar: () => null }));
vi.mock("@/components/DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false } } }) }));
vi.mock("@/components/EngineSetup", async () => {
  const { createElement: h } = await import("react");
  return { EngineSetup: ({ instance }: { instance: InstanceInfo }) => h("div", { "data-engine-setup": instance.instanceId }) };
});
const { WelcomeFlow } = await import("./WelcomeFlow");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const claude = (ready: boolean): InstanceInfo => ({
  instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude", install: { docsUrl: "https://example.test" },
  snapshot: { state: ready ? "available" : "unavailable", authenticated: ready }, models: { default: "m", options: [] },
});
const chief: Bot = {
  id: "chief", threadId: "t", name: "Pip", title: "", description: "", notifications: true, color: "green", unread: false,
  modelSelection: { instanceId: "claude", model: "m" }, messages: [], chiefOfStaff: true,
};
let host: HTMLDivElement, root: Root;
const text = () => host.textContent ?? "";
const flow = (extra: Record<string, unknown> = {}) => createElement(WelcomeFlow, { bot: chief, onDone: vi.fn(), reel: false, dictation: false, cloudOffer: null, setupImport: null, ...extra });
const show = async (extra: Record<string, unknown> = {}) => { await act(async () => { root.render(flow(extra)); }); };
const press = async (label: string) => {
  const button = [...host.querySelectorAll("button")].find((node) => node.textContent === label)!;
  await act(async () => { button.click(); });
};

beforeEach(() => {
  setLocale("en");
  f.state = { instances: [claude(false)], config: {}, cloudAdd: null, bots: [chief] };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

it("asks for no AI when one already works, and goes from hello to the next step", async () => {
  f.state.instances = [claude(true)];
  await show();
  expect(text()).toContain("Step 1 of 3");
  await press("Maybe later");
  expect(text()).not.toContain("Connect an AI");
  expect(text()).toContain("Step 2 of 3");
});

it("asks to connect an AI when none works, and keeps the step once it is shown, even after one connects", async () => {
  await show();
  expect(text()).toContain("Step 1 of 4");
  await press("Maybe later");
  expect(text()).toContain("Connect an AI");
  expect(host.querySelector('[data-engine-setup="claude"]')).not.toBeNull();
  f.state = { ...f.state, instances: [claude(true)] };
  await show();
  expect(text()).toContain("Claude is connected. Your bots can start now.");
  expect(text()).toContain("Step 2 of 4");
});

it("introduces the Chief as the person's assistant on the last step", async () => {
  f.state.instances = [claude(true)];
  await show({ initialBeat: "bot" });
  expect(text()).toContain("Meet your assistant");
  expect(text()).toContain("brings in specialists when a job needs them");
  await show({ initialBeat: "bot", bot: { ...chief, chiefOfStaff: false } });
  expect(text()).toContain("Meet your first bot");
});
