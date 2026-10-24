// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ManagedDesktopBridge } from "../../../../electron/managed-desktop.mjs";
import { setLocale } from "@/lib/i18n";
import type { InstanceInfo } from "@/state/store";

const f = vi.hoisted(() => ({ instances: [] as InstanceInfo[], dispatch: vi.fn(), row: null as null | { bridge: unknown; onOpenSettings: () => void } }));
vi.mock("@/state/store", () => ({ api: async () => ({ instances: f.instances }), useStore: () => ({ state: { instances: f.instances }, dispatch: f.dispatch }) }));
vi.mock("@/components/EngineSetup", async () => {
  const { createElement: h } = await import("react");
  return { EngineSetup: ({ instance, intent, description }: { instance: InstanceInfo; intent: string; description?: string }) =>
    h("div", { "data-engine-setup": instance.instanceId, "data-intent": intent, "data-description": description }) };
});
// The row has its own tests; here only whether the step offers it.
vi.mock("./OrganisationRow", () => ({ OrganisationRow: (props: NonNullable<typeof f.row>) => { f.row = props; return null; } }));
const { EnginesBeat } = await import("./EnginesBeat");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const engine = (instanceId: string, driverKind: string, displayName: string, ready: boolean): InstanceInfo => ({
  instanceId, driverKind, displayName, install: { docsUrl: "https://example.test" },
  snapshot: { state: ready ? "available" : "unavailable", authenticated: ready }, models: { default: "m", options: [] },
});
const bridge = { onState: vi.fn(), state: vi.fn() } as unknown as ManagedDesktopBridge;
const props = { onNext: vi.fn(), onSkip: vi.fn(), setMascot: vi.fn(), bump: vi.fn() };
let host: HTMLDivElement, root: Root;
const text = () => host.textContent ?? "";
const show = async (extra: { hosted?: boolean; onOpenOrganisation?: () => void } = {}) => {
  await act(async () => { root.render(createElement(EnginesBeat, { ...props, ...extra })); });
};
const otherWays = async () => {
  const toggle = [...host.querySelectorAll("button")].find((button) => button.textContent === "Other ways")!;
  await act(async () => { toggle.click(); });
};

beforeEach(() => {
  setLocale("en");
  f.instances = [engine("grok", "grokAgent", "Grok", false), engine("claude", "claudeAgent", "Claude", false), engine("codex", "codex", "Codex", false)];
  f.dispatch.mockReset();
  f.row = null;
  vi.stubGlobal("ogb", undefined);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("the welcome's Connect an AI step", () => {
  it("leads with one recommended way and folds every other way, with no status list and no engine talk", async () => {
    await show();
    expect([...host.querySelectorAll("[data-engine-setup]")].map((node) => node.getAttribute("data-engine-setup"))).toEqual(["claude"]);
    expect(host.querySelector("[data-ai-recommended]")?.getAttribute("data-ai-recommended")).toBe("claude");
    expect(text()).not.toContain("Grok");
    await otherWays();
    expect(text()).toContain("Grok");
    expect(text()).toContain("Codex");
    for (const word of [/\bengines?\b/i, /\bReady\b/, /Needs setup/i, /to set up/i, /provider/i]) expect(text()).not.toMatch(word);
  });

  it("says one plain line on a sign-in at the provider's website, and leaves a step finished in Terminal and a local-model setup their own words", async () => {
    const signsIn = (instance: InstanceInfo, method?: "paste-code" | "device-code"): InstanceInfo =>
      ({ ...instance, snapshot: { state: "available", authenticated: false }, ...(method ? { authentication: { method } } : {}) });
    f.instances = [
      signsIn(engine("claude", "claudeAgent", "Claude", false), "paste-code"),
      signsIn(engine("grok", "grokAgent", "Grok", false), "device-code"),
      signsIn(engine("kimi", "kimiAgent", "Kimi", false)),
      engine("codex", "codex", "Codex", false),
      { ...engine("droid", "droidAgent", "Droid", false), install: { docsUrl: "https://example.test", server: { package: "droid" } } },
      { ...engine("local", "openai-compat", "Local models", false), access: "custom" },
    ];
    const setup = (id: string) => host.querySelector(`[data-engine-setup="${id}"]`);
    const plain = (name: string) => `Use the ${name} account you already have. You sign in on their own website, so your password stays with them.`;
    await show();
    expect(setup("claude")?.getAttribute("data-description")).toBe(plain("Claude"));
    await otherWays();
    const openRow = async (name: string) => {
      const row = [...host.querySelectorAll<HTMLButtonElement>("button[aria-expanded]")].find((button) => button.textContent?.includes(name))!;
      await act(async () => { row.click(); });
    };
    await openRow("Grok");
    expect(setup("grok")?.getAttribute("data-description")).toBe(plain("Grok"));
    await openRow("Droid");
    expect(setup("droid")?.getAttribute("data-description"), "the app installs it, then the sign-in follows").toBe(plain("Droid"));
    for (const [id, name] of [["kimi", "Kimi"], ["codex", "Codex"]]) {
      await openRow(name);
      expect(setup(id)?.hasAttribute("data-description"), `${name} is finished in Terminal: its setup keeps its own instructions`).toBe(false);
    }
    await openRow("Local models");
    expect(setup("local")?.getAttribute("data-intent")).toBe("inject");
    expect(setup("local")?.hasAttribute("data-description")).toBe(false);
  });

  it("says which AI is connected once one is, and recommends nothing more", async () => {
    f.instances = [engine("claude", "claudeAgent", "Claude", true), engine("codex", "codex", "Codex", false)];
    await show();
    expect(host.querySelector("[data-ai-connected]")?.textContent).toContain("Claude");
    expect(host.querySelector("[data-ai-recommended]")).toBeNull();
  });

  it("offers the organization sign-in under Other ways on this computer's own window only", async () => {
    await show();
    await otherWays();
    expect(f.row).toBeNull();
    vi.stubGlobal("ogb", { organization: bridge });
    window.ogb = { organization: bridge } as unknown as typeof window.ogb;
    await show({ hosted: true });
    expect(f.row).toBeNull();
    await show();
    expect(f.row?.bridge).toBe(bridge);
    f.row!.onOpenSettings();
    expect(f.dispatch).toHaveBeenCalledWith({ type: "toggleAppSettings", open: true, section: "organization" });
    const resume = vi.fn();
    await show({ onOpenOrganisation: resume });
    f.row!.onOpenSettings();
    expect(resume).toHaveBeenCalledOnce();
    delete window.ogb;
  });
});
