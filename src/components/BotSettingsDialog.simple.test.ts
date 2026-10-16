import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Routine } from "@/lib/routines";
import type { Bot, Message } from "@/state/store";
import type { ManagedSkill } from "./bot-settings/SkillsSection";
import type { BotApps } from "./bot-settings/useBotApps";

// Hook-by-call-order harness: component state survives between renders, effects never run, and handlers are read off
// the element tree.
const fixture = vi.hoisted(() => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
  return {
    advanced: false,
    ownerOrAdmin: false as boolean | null,
    values: [] as unknown[],
    index: 0,
    own: 0,
    dispatch: (() => {}) as (...args: unknown[]) => void,
    storeState: {} as Record<string, unknown>,
    skills: {
      skills: [] as ManagedSkill[],
      loading: false,
      working: "",
      error: "",
      reviewing: null as null | { skill: ManagedSkill; text: string },
      toggle: (() => Promise.resolve()) as (skill: ManagedSkill) => Promise<void>,
    },
    derived: {} as Record<string, unknown>,
    apps: { phase: "ready", apps: [], connectedSlugs: [] } as BotApps,
    places: {} as Record<string, [boolean, boolean, string]>,
  };
});
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = fixture.index++;
    if (!(index in fixture.values)) fixture.values[index] = typeof initial === "function" ? initial() : initial;
    return [fixture.values[index], (next: unknown) => {
      fixture.values[index] = typeof next === "function" ? next(fixture.values[index]) : next;
    }];
  },
  useEffect: () => {},
}));
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => fixture.advanced, setAdvancedMode: () => {} }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => fixture.ownerOrAdmin }));
vi.mock("./bot-settings/useSlackManagement", () => ({ useSlackManagementUrl: () => null }));
vi.mock("./bot-settings/useBotSettingsDerived", () => ({ useBotSettingsDerived: () => fixture.derived }));
vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./DesktopCapabilities")>()),
  useCaptionChrome: () => ({ padClass: "" }),
}));
vi.mock("./Avatar", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./Avatar")>()),
  BotAvatar: () => null,
}));
vi.mock("./bot-settings/SkillsSection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./bot-settings/SkillsSection")>()),
  useManagedSkills: () => ({ ...fixture.skills, setReviewing: () => {}, enableReviewed: () => Promise.resolve() }),
}));
vi.mock("./PlaceChip", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./PlaceChip")>()),
  usePlaceViews: () => Object.fromEntries(Object.entries(fixture.places).map(([place, [policy, reachable, short]]) =>
    [place, { policy, reachable, view: { state: reachable ? "ready" : "blocked", params: {}, short, line: `${short}.`, action: null } }])),
}));
vi.mock("./bot-settings/useBotApps", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./bot-settings/useBotApps")>()),
  useBotApps: () => fixture.apps,
}));
vi.mock("@/state/store", async (importOriginal) => {
  const store = await importOriginal<typeof import("@/state/store")>();
  return {
    ...store,
    useStore: () => ({
      state: { ...store.initialState, ...fixture.storeState },
      dispatch: fixture.dispatch,
      flushBotPatches: () => Promise.resolve(),
    }),
  };
});

const { BotSettingsDialog } = await import("./BotSettingsDialog");
const { SimpleBotPanel, botLibraryItems } = await import("./bot-settings/SimpleBotPanel");
const { SoulField } = await import("./SoulField");
const { LocalComputerAutoWarning } = await import("./LocalComputerAutoWarning");
const { ModelPicker } = await import("./ModelPicker");
const { ThreadModelsLine } = await import("./ThreadModelsLine");
const { ModelSection } = await import("./bot-settings/ModelSection");
const { MemorySection } = await import("./bot-settings/MemorySection");
const { RoutinesSection } = await import("./bot-settings/RoutinesSection");
const { VaultTab } = await import("./bot-settings/VaultTab");
const { PhoneAppDialog } = await import("./PhoneAppDialog");
const { BotProfileAvatarCard } = await import("./BotProfileAvatarCard");
const { Switch } = await import("./SettingsPrimitives");

afterAll(() => vi.unstubAllGlobals());

type Node = ReactElement<Record<string, unknown> & { children?: ReactNode }>;
function nodes(value: ReactNode): Node[] {
  return Children.toArray(value).flatMap((child) => {
    if (!isValidElement(child)) return [];
    const node = child as Node;
    return [node, ...nodes(node.props.children)];
  });
}

function makeBot(extra: Partial<Bot> = {}): Bot {
  return {
    id: "scout", threadId: "thread-scout", name: "Scout", title: "Researcher", description: "", soul: "Be brief.",
    notifications: true, color: "green", unread: false, messages: [],
    modelSelection: { instanceId: "claude", model: "claude-opus-5-5" },
    ...extra,
  };
}

function capture(component: () => ReactNode) {
  fixture.values.length = Math.min(fixture.values.length, fixture.own);
  let tree: ReactNode = null;
  function Capture() {
    fixture.index = 0;
    tree = component();
    fixture.own = fixture.index;
    return tree;
  }
  const html = renderToStaticMarkup(createElement(Capture));
  return { html, nodes: nodes(tree) };
}

const patch = vi.fn();
const panelProps = { onClose: vi.fn(), onAllSettings: vi.fn(), onAddSkill: vi.fn() };
const panel = (bot: Bot) => capture(() => SimpleBotPanel({ bot, derived: fixture.derived as never, ...panelProps }));
const dialog = (bot: Bot) => capture(() => BotSettingsDialog({ bot }));
const find = (rendered: { nodes: Node[] }, attr: string, value: unknown = true) =>
  rendered.nodes.find((node) => node.props[attr] === value)!;
const click = (node: Node) => (node.props.onClick as () => void)();
const isSimple = (rendered: { nodes: Node[] }) => rendered.nodes.some((node) => node.type === SimpleBotPanel);
const rowOpen = (rendered: { nodes: Node[] }, id: string) =>
  (Children.toArray(find(rendered, "data-bot-settings-section", id).props.children)[0] as Node).props["aria-expanded"] === true;

const effortElsewhere = (rendered: { nodes: Node[] }) =>
  String(find(rendered, "data-simple-default-model").props.className).includes("[&_[data-simple-effort]]:hidden");
const skill = (name: string, enabled: boolean): ManagedSkill => ({ name, description: `${name} helper`, enabled, source: "github:x/y", warnings: [] });
const openTab = (bot: Bot, tab: string) => click(find(panel(bot), "data-simple-tab", tab));
const routine = (extra: Partial<Routine> = {}): Routine => ({
  id: "r1", name: "Morning brief", prompt: "Brief me", target: "bot", botId: "scout", runOn: "maus", enabled: true,
  schedule: { type: "daily", time: "09:00", weekdays: [1, 2, 3, 4, 5] }, durationMinutes: 15,
  nextRunAt: Date.UTC(2099, 0, 5, 9), createdAt: 1, updatedAt: 1, ...extra,
});
const app = (slug: string, scope: "read" | "write" | null) => ({
  slug, label: slug[0]!.toUpperCase() + slug.slice(1), blurb: `${slug} things`, card: { logo: null, domain: null, label: slug }, scope,
});

beforeEach(() => {
  fixture.advanced = false;
  fixture.ownerOrAdmin = false;
  fixture.values = [];
  fixture.index = 0;
  fixture.own = 0;
  fixture.dispatch = vi.fn();
  fixture.storeState = { settingsOpen: true, botSettingsSection: "overview", botSettingsExpandAccordion: false };
  fixture.skills = { skills: [], loading: false, working: "", error: "", reviewing: null, toggle: vi.fn(() => Promise.resolve()) };
  patch.mockReset();
  fixture.derived = {
    patch, approvalMode: "ask", engine: { driverKind: "claudeAgent" }, trustedModesAvailable: false, activeState: "idle",
    botRoutines: [],
    canUseConnectedApps: true, connectedAppsConfigured: true, connectedAppsEnabled: true, browserEnabled: true,
  };
  fixture.apps = { phase: "ready", apps: [], connectedSlugs: [] };
  fixture.places = {
    cloud: [true, true, "Cloud computer"], vm: [true, true, "Private desktop"], local: [true, true, "Your screen"], browser: [true, true, "Web pages only"],
  };
  panelProps.onAddSkill.mockReset();
});

describe("the bot settings panel in Simple mode", () => {
  it("shows the avatar header, six tabs, and one row per fact on Details", () => {
    const { html } = panel(makeBot());
    const tabs = [...html.matchAll(/data-simple-tab="(\w+)"[^>]*>([^<]+)<\/button>/g)].map((match) => [match[1], match[2]]);
    expect(tabs).toEqual([
      ["details", "Details"], ["memory", "Memory"], ["library", "Library"], ["skills", "Skills"], ["routines", "Routines"], ["vault", "Vault"],
    ]);
    expect(html).toContain("Name and job");
    expect(html).toContain("Scout · Researcher");
    expect(html).toContain("Instructions");
    expect(html).toContain("Be brief.");
    expect(html).not.toContain("<textarea");
    expect(html).toContain("Before Scout acts");
    expect(html).toContain("Ask me first");
    expect(html).toContain("Decide for me");
    expect(html).toContain("Full access");
    expect(html).toContain("Where Scout works");
    expect(html).toContain("All settings");
    expect(html).not.toContain("SOUL.md");
    const rows = [...html.matchAll(/data-simple-row="(\w+)"/g)].map((match) => match[1]);
    expect(rows).toEqual(["look", "identity", "soul", "approval", "computer", "uses", "phone", "email"]);
  });

  it("changes the mascot's look in place: color, body, expression or a picture, from its row", () => {
    const bot = makeBot();
    const closed = panel(bot);
    expect(closed.html).toContain("Color, shape, expression or your own picture.");
    expect(closed.nodes.some((node) => node.type === BotProfileAvatarCard)).toBe(false);

    click(find(closed, "data-simple-edit", "look"));
    const open = panel(bot);
    const card = open.nodes.find((node) => node.type === BotProfileAvatarCard)!;
    expect(card.props.bot).toBe(bot);
    expect(card.props.activeState).toBe("idle");
    expect(card.props.onPatch).toBe(patch);
    expect(open.html).toContain("Use blue mascot color");
    expect(open.html).toContain("Use the Blob body");

    click(find(open, "data-simple-edit", "identity"));
    expect(panel(bot).nodes.some((node) => node.type === BotProfileAvatarCard)).toBe(false);
    click(find(panel(bot), "data-simple-edit", "look"));
    click(find(panel(bot), "data-simple-done", "look"));
    expect(panel(bot).nodes.some((node) => node.type === BotProfileAvatarCard)).toBe(false);
  });

  it("opens the look editor from the mascot itself, whichever tab is showing", () => {
    const bot = makeBot();
    openTab(bot, "vault");
    const onVault = panel(bot);
    expect(find(onVault, "data-simple-avatar").props["aria-label"]).toBe("Change how Scout looks");
    click(find(onVault, "data-simple-avatar"));
    const back = panel(bot);
    expect(find(back, "data-simple-tab", "details").props["aria-selected"]).toBe(true);
    expect(back.nodes.some((node) => node.type === BotProfileAvatarCard)).toBe(true);
  });

  it("opens Name and job into its two fields, and Instructions into its box, one at a time", () => {
    const bot = makeBot();
    click(find(panel(bot), "data-simple-edit", "identity"));
    const identity = panel(bot);
    expect(identity.html).toContain(">Name</label>");
    expect(identity.html).toContain(">Job</label>");
    expect(identity.html).toContain("value=\"Scout\"");
    expect(identity.html).toContain("value=\"Researcher\"");
    expect(identity.nodes.some((node) => node.type === SoulField)).toBe(false);

    click(find(identity, "data-simple-edit", "soul"));
    const soul = panel(bot);
    expect(soul.html).toContain(">Instructions</label>");
    expect(soul.html).toContain("<textarea");
    expect(soul.nodes.some((node) => node.props.id === "simple-bot-name-scout")).toBe(false);

    click(find(soul, "data-simple-done", "soul"));
    expect(panel(bot).html).not.toContain("<textarea");
  });

  it("opens the row a link names: the instructions for Read all, the two fields for Edit profile", () => {
    fixture.storeState = { settingsOpen: true, botSettingsSection: "soul", botSettingsExpandAccordion: true };
    const soul = panel(makeBot());
    expect(soul.nodes.some((node) => node.type === SoulField)).toBe(true);
    expect(soul.nodes.some((node) => node.props["data-simple-done"] === "soul")).toBe(true);

    fixture.values = [];
    fixture.own = 0;
    fixture.storeState = { settingsOpen: true, botSettingsSection: "identity", botSettingsExpandAccordion: true };
    expect(panel(makeBot()).nodes.some((node) => node.props.id === "simple-bot-name-scout")).toBe(true);

    fixture.values = [];
    fixture.own = 0;
    fixture.storeState = { settingsOpen: true, botSettingsSection: "soul", botSettingsExpandAccordion: true, botSettingsExpandRemembered: true };
    expect(panel(makeBot()).nodes.some((node) => node.type === SoulField)).toBe(false);
  });

  it("says so when there are no instructions, and opens the box by itself while the file on disk has drifted", () => {
    expect(panel(makeBot({ soul: "" })).html).toContain("No instructions yet.");
    const drifted = panel(makeBot({ soulDrift: true }));
    expect(drifted.nodes.some((node) => node.type === SoulField)).toBe(true);
    expect(drifted.nodes.some((node) => node.props["data-simple-done"] === "soul")).toBe(false);
  });

  it("sets the bot's default model between Instructions and Before acts, in the inline picker", () => {
    const bot = makeBot();
    const rendered = panel(bot);
    const picker = rendered.nodes.find((node) => node.type === ModelPicker)!;
    expect(picker).toBeDefined();
    expect(picker.props.contained).toBe(true);
    expect(picker.props.bot).toBe(bot);
    expect(picker.props.threadId).toBeUndefined();
    const { html } = rendered;
    const at = (text: string) => html.indexOf(text);
    expect(at("Instructions")).toBeGreaterThan(-1);
    expect(at("Instructions")).toBeLessThan(at("Default model"));
    expect(at("Default model")).toBeLessThan(at("Before Scout acts"));
  });

  it("saves name, job and instructions through the same bot patch", () => {
    const bot = makeBot();
    click(find(panel(bot), "data-simple-edit", "identity"));
    const rendered = panel(bot);
    (find(rendered, "id", "simple-bot-name-scout").props.onChange as (e: unknown) => void)({ target: { value: "Nova" } });
    expect(patch).toHaveBeenLastCalledWith({ name: "Nova" });
    (find(rendered, "id", "simple-bot-job-scout").props.onChange as (e: unknown) => void)({ target: { value: "Writer" } });
    expect(patch).toHaveBeenLastCalledWith({ title: "Writer" });
    click(find(rendered, "data-simple-edit", "soul"));
    const soul = panel(bot).nodes.find((node) => node.type === SoulField)!;
    expect(soul.props.onPatch).toBe(patch);
  });

  it("maps the two choices onto Ask and Approve for me", () => {
    const rendered = panel(makeBot());
    expect(find(rendered, "data-approval-choice", "ask").props["aria-pressed"]).toBe(true);
    expect(find(rendered, "data-approval-choice", "auto").props["aria-pressed"]).toBe(false);
    click(find(rendered, "data-approval-choice", "auto"));
    expect(patch).toHaveBeenLastCalledWith({ approvalMode: "auto" });

    fixture.derived.approvalMode = "auto";
    const onAuto = panel(makeBot());
    click(find(onAuto, "data-approval-choice", "ask"));
    expect(patch).toHaveBeenLastCalledWith({ approvalMode: "ask" });
  });

  it("shows legacy Antigravity Auto as Ask without changing the saved mode", () => {
    fixture.derived.engine = { ...fixture.derived.engine!, driverKind: "antigravityAgent" };
    fixture.derived.approvalMode = "auto";
    const rendered = panel(makeBot({ approvalMode: "auto" }));
    expect(find(rendered, "data-approval-choice", "ask").props["aria-pressed"]).toBe(true);
    expect(find(rendered, "data-approval-choice", "auto").props["aria-pressed"]).toBe(false);
    expect(find(rendered, "data-approval-choice", "auto").props.disabled).toBe(true);
    expect(patch).not.toHaveBeenCalled();
  });

  it("warns before Decide for me on this computer, as Permissions does", () => {
    const bot = makeBot({ computer: "local" });
    click(find(panel(bot), "data-approval-choice", "auto"));
    expect(patch).not.toHaveBeenCalled();
    const warning = panel(bot).nodes.find((node) => node.type === LocalComputerAutoWarning)!;
    expect(warning.props.open).toBe(true);
    (warning.props.onConfirm as () => void)();
    expect(fixture.dispatch).toHaveBeenLastCalledWith({
      type: "updateBot", botId: "scout", patch: { approvalMode: "auto", acknowledgeLocalAuto: true },
    });
  });

  it("shows Full access, the default level, as its own choice and applies it to every thread", () => {
    fixture.derived.approvalMode = "full";
    const rendered = panel(makeBot());
    expect(find(rendered, "data-approval-choice", "full").props["aria-pressed"]).toBe(true);
    expect(find(rendered, "data-approval-choice", "ask").props["aria-pressed"]).toBe(false);
    expect(rendered.html).toContain("Acts without checking");
    expect(rendered.html).not.toContain("A custom setting is in use.");
    fixture.derived.approvalMode = "ask";
    click(find(panel(makeBot()), "data-approval-choice", "full"));
    expect(fixture.dispatch).toHaveBeenLastCalledWith({
      type: "updateBot", botId: "scout", patch: { approvalMode: "full", applyToAllThreads: true },
    });
    expect(patch).not.toHaveBeenCalled();
  });

  it("selects no choice and says so when another level is in use", () => {
    fixture.derived.approvalMode = "edits";
    const rendered = panel(makeBot());
    for (const mode of ["ask", "auto", "full"]) expect(find(rendered, "data-approval-choice", mode).props["aria-pressed"]).toBe(false);
    expect(rendered.html).toContain("A custom setting is in use.");
    expect(patch).not.toHaveBeenCalled();
  });

  it("lists skills with the Skills section's on/off switch", () => {
    const off = skill("summarise", false);
    fixture.skills.skills = [skill("triage", true), off];
    const bot = makeBot();
    expect(panel(bot).html).not.toContain("summarise helper");
    openTab(bot, "skills");
    const rendered = panel(bot);
    expect(rendered.html).toContain("triage");
    expect(rendered.html).toContain("summarise helper");
    click(find(rendered, "aria-label", "Use summarise"));
    expect(fixture.skills.toggle).toHaveBeenCalledWith(off);
    click(find(rendered, "data-simple-add-skill"));
    expect(panelProps.onAddSkill).toHaveBeenCalled();
  });

  it("disables every skill switch until a pending toggle settles", async () => {
    const first = skill("triage", true);
    const second = skill("summarise", false);
    fixture.skills.skills = [first, second];
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    fixture.skills.toggle = vi.fn(async (selected) => {
      fixture.skills.working = selected.name;
      await pending;
      fixture.skills.working = "";
    });

    openTab(makeBot(), "skills");
    click(find(panel(makeBot()), "aria-label", "Use triage"));
    const busy = panel(makeBot());
    expect(find(busy, "aria-label", "Use triage").props.disabled).toBe(true);
    expect(find(busy, "aria-label", "Use summarise").props.disabled).toBe(true);

    finish();
    await pending;
    const settled = panel(makeBot());
    expect(find(settled, "aria-label", "Use triage").props.disabled).toBe(false);
    expect(find(settled, "aria-label", "Use summarise").props.disabled).toBe(false);
  });

  it("has a quiet line when there are no skills", () => {
    openTab(makeBot(), "skills");
    expect(panel(makeBot()).html).toContain("No skills yet.");
  });

  it("shows the Library empty state, and what the bot made when there is some", () => {
    const empty = makeBot();
    click(find(panel(empty), "data-simple-tab", "library"));
    expect(panel(empty).html).toContain("Pages, files, and apps Scout makes show up here.");

    const message = {
      id: "m1", role: "bot", kind: "text", at: Date.UTC(2026, 8, 30), text: "Done",
      attachments: [{ path: "/tmp/chart.png", kind: "image" }, { path: "/tmp/report.pdf", kind: "file", name: "report.pdf" }],
    } as Message;
    const made = makeBot({ messages: [message] });
    expect(botLibraryItems(made).map((item) => item.name)).toEqual(["chart.png", "report.pdf"]);
    const rendered = panel(made);
    expect(rendered.html).toContain("report.pdf");
    click(find(rendered, "data-library-item", "m1"));
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "focusMessage", threadId: "thread-scout", messageId: "m1" });
  });

  it("keeps the latest artifact reply and date while preserving each reply's file order", () => {
    const made = makeBot({ messages: [
      { id: "old", role: "bot", kind: "text", at: 100, text: "First draft", attachments: [
        { path: "/tmp/report.pdf", kind: "file", name: "draft.pdf" },
        { path: "/tmp/old-only.pdf", kind: "file", name: "old-only.pdf" },
      ] },
      { id: "latest", role: "bot", kind: "text", at: 200, text: "Updated", attachments: [
        { path: "/tmp/chart.png", kind: "image" },
        { path: "/tmp/report.pdf", kind: "file", name: "report.pdf" },
        { path: "/tmp/notes.md", kind: "file", name: "notes.md" },
      ] },
    ] as Message[] });
    expect(botLibraryItems(made).map(({ name, messageId, at }) => ({ name, messageId, at }))).toEqual([
      { name: "chart.png", messageId: "latest", at: 200 },
      { name: "report.pdf", messageId: "latest", at: 200 },
      { name: "notes.md", messageId: "latest", at: 200 },
      { name: "old-only.pdf", messageId: "old", at: 100 },
    ]);
  });

  it("puts Thinking on its own row with the picker's plain steps, and hides the picker's own copy", () => {
    fixture.derived.engine = { driverKind: "claudeAgent", capabilities: { effortLevels: ["low", "medium", "high", "max"] } };
    const bot = makeBot({ modelSelection: { instanceId: "claude", model: "claude-opus-5-5", effort: "medium" } });
    const rendered = panel(bot);
    const steps = rendered.nodes.filter((node) => node.props["data-thinking-choice"] !== undefined);
    expect(steps.map((node) => [node.props["data-thinking-choice"], node.props.children, node.props["aria-pressed"]])).toEqual([
      ["low", "Quick", false], ["medium", "Balanced", true], ["high", "Deep", false], ["max", "Max", false],
    ]);
    expect(effortElsewhere(rendered)).toBe(true);
    const at = (text: string) => rendered.html.indexOf(text);
    expect(at("Default model")).toBeLessThan(at("Thinking"));
    expect(at("Thinking")).toBeLessThan(at("Before Scout acts"));

    expect(rendered.html).toContain("More thinking is slower and more careful.");
    expect(panel(makeBot()).html).toContain("Left to the model. Pick a step to set it.");

    click(find(rendered, "data-thinking-choice", "high"));
    expect(fixture.dispatch).toHaveBeenLastCalledWith({
      type: "setModel", botId: "scout", selection: { instanceId: "claude", model: "claude-opus-5-5", effort: "high" },
    });
    (fixture.dispatch as ReturnType<typeof vi.fn>).mockClear();
    click(find(rendered, "data-thinking-choice", "medium"));
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  it("holds Thinking while a turn runs, and has no row where the engine has no steps or keeps its own variants", () => {
    fixture.derived.engine = { driverKind: "claudeAgent", capabilities: { effortLevels: ["low", "high"] } };
    const busy = panel(makeBot({ busy: true }));
    expect(find(busy, "data-thinking-choice", "high").props.disabled).toBe(true);
    click(find(busy, "data-thinking-choice", "high"));
    expect(fixture.dispatch).not.toHaveBeenCalled();

    fixture.derived.engine = { driverKind: "claudeAgent" };
    const none = panel(makeBot());
    expect(none.html).not.toContain("data-simple-row=\"thinking\"");
    expect(effortElsewhere(none)).toBe(false);

    fixture.derived.engine = { driverKind: "acp", capabilities: { effortLevels: ["low", "high"], modelVariants: true } };
    const variants = panel(makeBot());
    expect(variants.html).not.toContain("data-simple-row=\"thinking\"");
    expect(effortElsewhere(variants)).toBe(false);
  });

  const places = (rendered: { nodes: Node[] }) => rendered.nodes.filter((node) => node.props["data-place-choice"] !== undefined);
  const placeOf = (rendered: { nodes: Node[] }, value: string) => find(rendered, "data-place-choice", value);

  it("offers three places on the row: Auto, this computer and a cloud computer", () => {
    const rendered = panel(makeBot());
    expect(rendered.html).toContain("Where Scout works");
    expect(places(rendered).map((node) => [node.props["data-place-choice"], node.props["aria-pressed"]])).toEqual([
      ["auto", true], ["local", false], ["cloud", false],
    ]);
    expect(rendered.html).toContain("Picks the right place for each task");
    expect(placeOf(rendered, "cloud").props.children).toBe("Cloud computer");
    expect(placeOf(rendered, "auto").props.children).toBe("Auto");

    click(placeOf(rendered, "cloud"));
    expect(patch).toHaveBeenLastCalledWith({ computer: "cloud" });
    click(placeOf(rendered, "local"));
    expect(patch).toHaveBeenLastCalledWith({ computer: "local" });
    click(placeOf(panel(makeBot({ computer: "cloud" })), "auto"));
    expect(patch).toHaveBeenLastCalledWith({ computer: null });
  });

  it("sends nothing for the place already chosen", () => {
    click(placeOf(panel(makeBot()), "auto"));
    click(placeOf(panel(makeBot({ computer: "local" })), "local"));
    expect(patch).not.toHaveBeenCalled();
  });

  it("holds a place the bot cannot use with the reason on it, and leaves out one never offered here", () => {
    fixture.places.local = [true, false, "Not ready"];
    const blocked = panel(makeBot());
    expect(placeOf(blocked, "local").props.disabled).toBe(true);
    expect(placeOf(blocked, "local").props.title).toBe("Not ready.");
    expect(placeOf(blocked, "cloud").props.title).toBeUndefined();

    fixture.places.local = [false, false, "Not offered"];
    expect(places(panel(makeBot())).map((node) => node.props["data-place-choice"])).toEqual(["auto", "cloud"]);
  });

  it("names a rarer place in effect on the row, with none of the three pressed", () => {
    const rendered = panel(makeBot({ computer: "browser" }));
    expect(places(rendered).every((node) => node.props["aria-pressed"] === false)).toBe(true);
    expect(rendered.html).toContain("Browser: ");
    expect(panel(makeBot({ computer: "cloud" })).html).not.toContain("Cloud computer: ");
  });

  it("warns before this computer for a bot that decides alone, as the Computer panel does", () => {
    fixture.derived.approvalMode = "auto";
    const bot = makeBot({ approvalMode: "auto" });
    click(placeOf(panel(bot), "local"));
    expect(patch).not.toHaveBeenCalled();
    const warning = panel(bot).nodes.find((node) => node.type === LocalComputerAutoWarning)!;
    expect(warning.props.open).toBe(true);
    (warning.props.onConfirm as () => void)();
    expect(fixture.dispatch).toHaveBeenLastCalledWith({
      type: "updateBot", botId: "scout", patch: { computer: "local", acknowledgeLocalAuto: true },
    });
    expect(panel(bot).nodes.find((node) => node.type === LocalComputerAutoWarning)!.props.open).toBe(false);

    fixture.derived.approvalMode = "ask";
    click(placeOf(panel(makeBot()), "local"));
    expect(patch).toHaveBeenLastCalledWith({ computer: "local" });
  });

  it("lists the apps the bot may use on the Uses row, and leads to Vault", () => {
    const bot = makeBot();
    expect(panel(bot).html).toContain("No apps yet.");
    fixture.apps = { phase: "loading", apps: [], connectedSlugs: [] };
    expect(panel(bot).html).toContain("Checking…");

    fixture.apps = {
      phase: "ready", connectedSlugs: ["a", "b", "c", "d", "e", "f"],
      apps: [app("a", "write"), app("b", "read"), app("c", null), app("d", "write"), app("e", "write"), app("f", "write")],
    };
    const rendered = panel(bot);
    expect([...rendered.html.matchAll(/data-simple-uses="(\w+)"/g)].map((match) => match[1])).toEqual(["a", "b", "d", "e"]);
    expect(rendered.html).toContain("+1 more");

    click(find(rendered, "data-simple-open-tab", "vault"));
    const vault = panel(bot).nodes.find((node) => node.type === VaultTab)!;
    expect(vault.props.apps).toBe(fixture.apps);
    expect(vault.props.bot).toBe(bot);
    const setItem = vi.fn();
    vi.stubGlobal("localStorage", { getItem: () => null, setItem });
    (vault.props.onOpenBrowser as () => void)();
    expect(setItem).toHaveBeenCalledWith("omb-computer-panel-view:scout", "browser");
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "toggleComputer", open: true });
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
  });

  it("marks the bot's own number and inbox as on their way", () => {
    const { html } = panel(makeBot());
    expect(html).toContain("Texts and calls. No number yet.");
    expect(html).toContain("Its own inbox. No inbox yet.");
    expect(html.match(/>Soon</g)).toHaveLength(2);
  });

  it("lists the bot's routines on Details with an on/off switch each", () => {
    const morning = routine();
    const paused = routine({ id: "r2", name: "Weekly digest", enabled: false, nextRunAt: null });
    const done = routine({ id: "r3", name: "One-off", enabled: false, nextRunAt: null, schedule: { type: "once", at: 1 } });
    fixture.derived.botRoutines = [paused, done, morning];
    const rendered = panel(makeBot());
    expect(rendered.nodes.filter((node) => node.props["data-simple-routine"] !== undefined).map((node) => node.props["data-simple-routine"]))
      .toEqual(["r1", "r3", "r2"]);
    expect(rendered.html).toContain("Every weekday at");
    expect(rendered.html).toContain("Paused");
    expect(find(rendered, "aria-label", "Run Morning brief on its schedule").props.checked).toBe(true);
    expect(find(rendered, "aria-label", "Run Weekly digest on its schedule").props.checked).toBe(false);
    expect(rendered.nodes.some((node) => node.props["aria-label"] === "Run One-off on its schedule")).toBe(false);

    click(find(rendered, "aria-label", "Run Morning brief on its schedule"));
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "updateRoutine", routineId: "r1", patch: { enabled: false } });
    click(find(rendered, "aria-label", "Run Weekly digest on its schedule"));
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "updateRoutine", routineId: "r2", patch: { enabled: true } });
  });

  it("says how to add a routine when there is none, and opens the Routines tab on the full list", () => {
    const bot = makeBot();
    const rendered = panel(bot);
    expect(rendered.html).toContain("Nothing scheduled yet. Ask Scout in chat, or create a schedule.");
    expect(rendered.nodes.some((node) => node.type === RoutinesSection)).toBe(false);
    click(find(rendered, "data-simple-open-tab", "routines"));
    const section = panel(bot).nodes.find((node) => node.type === RoutinesSection)!;
    expect(section.props.bot).toBe(bot);
    expect(section.props.routines).toBe(fixture.derived.botRoutines);
  });

  it("opens Memory in its own tab and keeps it mounted afterwards, so a draft survives", () => {
    const bot = makeBot();
    expect(panel(bot).nodes.some((node) => node.type === MemorySection)).toBe(false);
    openTab(bot, "memory");
    const memory = panel(bot).nodes.find((node) => node.type === MemorySection)!;
    expect(memory.props.active).toBe(true);
    (memory.props.onToggle as (enabled: boolean) => void)(false);
    expect(patch).toHaveBeenLastCalledWith({ memoryEnabled: false });

    openTab(bot, "details");
    const hidden = panel(bot);
    expect(hidden.nodes.find((node) => node.type === MemorySection)!.props.active).toBe(false);
    expect(hidden.nodes.find((node) => node.props.role === "tabpanel" && node.props.hidden === true)).toBeDefined();
  });

  it("says where the phone apps are, and offers Slack only where the organization has it", () => {
    const bot = makeBot();
    const rendered = panel(bot);
    expect(rendered.html).toContain("Where to find Scout");
    expect(rendered.nodes.some((node) => node.props["data-simple-find"] === "slack")).toBe(false);
    expect(rendered.nodes.find((node) => node.type === PhoneAppDialog)!.props.open).toBe(false);
    click(find(rendered, "data-simple-find", "android"));
    expect(panel(bot).nodes.find((node) => node.type === PhoneAppDialog)!.props.open).toBe(true);

    const withSlack = capture(() => SimpleBotPanel({ bot, derived: fixture.derived as never, slackUrl: "https://admin.example/slack", ...panelProps }));
    expect(find(withSlack, "data-simple-find", "slack").props.href).toBe("https://admin.example/slack");
  });
});

describe("the Vault tab", () => {
  const vault = (bot: Bot, onOpenBrowser = vi.fn()) =>
    capture(() => VaultTab({ bot, derived: fixture.derived as never, apps: fixture.apps, onOpenBrowser }));

  it("gives each connected app a switch for this bot, and writes the same record as Access", () => {
    fixture.apps = { phase: "ready", connectedSlugs: ["github", "gmail", "slack"], apps: [app("github", "write"), app("gmail", "write"), app("slack", "write")] };
    const rendered = vault(makeBot());
    expect(rendered.html).toContain("What Scout is allowed to use.");
    expect(rendered.html).toContain("github things");
    click(find(rendered, "aria-label", "Scout can use Github"));
    expect(patch).toHaveBeenLastCalledWith({ connectorScopes: { apps: { gmail: "write", slack: "write" } } });

    fixture.apps = { phase: "ready", connectedSlugs: ["github", "gmail", "slack"], apps: [app("github", null), app("gmail", "read"), app("slack", "write")] };
    const scoped = vault(makeBot({ connectorScopes: { apps: { gmail: "read", slack: "write" } } }));
    expect(find(scoped, "aria-label", "Scout can use Github").props.checked).toBe(false);
    expect(scoped.html).toContain("Read only");
    click(find(scoped, "aria-label", "Scout can use Github"));
    expect(patch).toHaveBeenLastCalledWith({ connectorScopes: { apps: { gmail: "read", slack: "write", github: "write" } } });
  });

  it("turns all apps off or on with the bot's own switch, and holds the app switches while it is off", () => {
    fixture.apps = { phase: "ready", connectedSlugs: ["gmail"], apps: [app("gmail", "write")] };
    click(find(vault(makeBot()), "aria-label", "Let Scout use apps"));
    expect(patch).toHaveBeenLastCalledWith({ composio: false });

    fixture.derived.connectedAppsEnabled = false;
    fixture.apps = { phase: "ready", connectedSlugs: ["gmail"], apps: [app("gmail", null)] };
    const off = vault(makeBot({ composio: false }));
    expect(find(off, "aria-label", "Scout can use Gmail").props.disabled).toBe(true);
    click(find(off, "aria-label", "Let Scout use apps"));
    expect(patch).toHaveBeenLastCalledWith({ composio: true });

    fixture.derived.canUseConnectedApps = false;
    const cannot = vault(makeBot({ composio: false }));
    expect(find(cannot, "aria-label", "Let Scout use apps").props.disabled).toBe(true);
    expect(cannot.html).toContain("The model Scout runs on can&#x27;t use apps.");
  });

  it("says what it knows about the list: checking, unreadable, or empty", () => {
    fixture.apps = { phase: "loading", apps: [], connectedSlugs: [] };
    expect(vault(makeBot()).html).toContain("Checking…");
    fixture.apps = { phase: "unknown", apps: [], connectedSlugs: [] };
    expect(vault(makeBot()).html).toContain("Couldn&#x27;t check your apps just now.");
    fixture.apps = { phase: "ready", apps: [], connectedSlugs: [] };
    expect(vault(makeBot()).html).toContain("No apps connected yet.");
  });

  it("opens the app catalog from Add app, and the bot's browser from Add login", () => {
    const onOpenBrowser = vi.fn();
    const rendered = vault(makeBot(), onOpenBrowser);
    click(find(rendered, "data-simple-add-app"));
    expect((fixture.dispatch as ReturnType<typeof vi.fn>).mock.calls).toEqual([
      [{ type: "toggleSettings", open: false }],
      [{ type: "togglePlugins", open: true, surface: "apps" }],
    ]);
    click(find(rendered, "data-simple-add-login"));
    expect(onOpenBrowser).toHaveBeenCalled();
  });

  it("lists the sites the bot's own browser is signed in to, and explains the browsers it cannot list", async () => {
    const { SignedInSites } = await import("./SignedInSites");
    expect(vault(makeBot()).nodes.some((node) => node.type === SignedInSites)).toBe(false);
    fixture.ownerOrAdmin = true;
    const own = vault(makeBot());
    const sites = own.nodes.find((node) => node.type === SignedInSites)!;
    expect(sites.props).toMatchObject({ bare: true, target: { bot: "scout" }, sharedBy: ["Scout"], disabled: false });
    expect(own.html).toContain("Sign in once in Scout&#x27;s browser and it stays signed in.");

    fixture.storeState = {
      ...fixture.storeState,
      config: { browserProfiles: [{ id: "team", name: "Team" }] },
      bots: [makeBot({ browserProfile: "team" }), makeBot({ id: "nova", name: "Nova", browserProfile: "team" })],
    };
    const shared = vault(makeBot({ browserProfile: "team" }));
    expect(shared.nodes.find((node) => node.type === SignedInSites)!.props.sharedBy).toEqual(["Scout", "Nova"]);

    const temporary = vault(makeBot({ browserProfile: "guest" }));
    expect(temporary.nodes.some((node) => node.type === SignedInSites)).toBe(false);
    expect(temporary.html).toContain("Temporary sessions keep logins only while this server is running");

    fixture.derived.browserEnabled = false;
    const off = vault(makeBot());
    expect(off.nodes.some((node) => node.type === SignedInSites)).toBe(false);
    expect(off.html).toContain("Scout&#x27;s browser is off.");
  });

  it("uses the shared switch for every row", () => {
    fixture.apps = { phase: "ready", connectedSlugs: ["gmail"], apps: [app("gmail", "write")] };
    expect(vault(makeBot()).nodes.filter((node) => node.type === Switch)).toHaveLength(2);
  });
});

describe("the bot settings dialog", () => {
  it("opens on the Simple panel and reaches every section through All settings", () => {
    const bot = makeBot();
    const simple = dialog(bot);
    expect(isSimple(simple)).toBe(true);
    expect(simple.html).not.toContain("Search settings");

    const panelNode = simple.nodes.find((node) => node.type === SimpleBotPanel)!;
    (panelNode.props.onAllSettings as () => void)();
    const full = dialog(bot);
    expect(isSimple(full)).toBe(false);
    expect(full.html).toContain("Search settings");
    for (const label of ["Overview", "Identity", "Soul", "Skills", "Memory", "Routines", "Access", "Model", "Permissions", "Voice &amp; alerts", "History", "Usage"]) {
      expect(full.html).toContain(`>${label}</span>`);
    }

    click(find(full, "data-bot-settings-back"));
    expect(isSimple(dialog(bot))).toBe(true);
  });

  it("opens the full Skills row from Add skill", () => {
    const bot = makeBot();
    const panelNode = dialog(bot).nodes.find((node) => node.type === SimpleBotPanel)!;
    (panelNode.props.onAddSkill as () => void)();
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "toggleSettings", open: true, section: "skills" });
    expect(isSimple(dialog(bot))).toBe(false);
  });

  it("follows a deep link to a section the Simple panel does not cover", () => {
    fixture.storeState = { settingsOpen: true, botSettingsSection: "model", botSettingsExpandAccordion: true };
    expect(isSimple(dialog(makeBot()))).toBe(false);
  });

  it("keeps Edit profile on the Simple panel", () => {
    fixture.storeState = { settingsOpen: true, botSettingsSection: "identity", botSettingsExpandAccordion: true };
    expect(isSimple(dialog(makeBot()))).toBe(true);
  });

  it("a stored section opens expanded in the full view", () => {
    fixture.advanced = true;
    fixture.storeState = {
      settingsOpen: true, botSettingsSection: "model", botSettingsExpandAccordion: true,
      botSettingsSectionStored: true, botSettingsExpandRemembered: true,
    };
    const rendered = dialog(makeBot());
    expect(isSimple(rendered)).toBe(false);
    expect(rowOpen(rendered, "model")).toBe(true);
  });

  it("a stored section never forces the full view in simple mode", () => {
    fixture.storeState = {
      settingsOpen: true, botSettingsSection: "model", botSettingsExpandAccordion: true,
      botSettingsSectionStored: true, botSettingsExpandRemembered: true,
    };
    expect(isSimple(dialog(makeBot()))).toBe(true);
  });

  it("a deep link wins over the stored section", () => {
    fixture.storeState = {
      settingsOpen: true, botSettingsSection: "skills", botSettingsExpandAccordion: true,
      botSettingsSectionStored: true,
    };
    const rendered = dialog(makeBot());
    expect(isSimple(rendered)).toBe(false);
    expect(rowOpen(rendered, "skills")).toBe(true);
  });

  it("searching collapses a remembered-expanded row like a deep-linked one", () => {
    fixture.advanced = true;
    fixture.storeState = {
      settingsOpen: true, botSettingsSection: "model", botSettingsExpandAccordion: true,
      botSettingsSectionStored: true, botSettingsExpandRemembered: true,
    };
    expect(rowOpen(dialog(makeBot()), "model")).toBe(true);
    const search = dialog(makeBot()).nodes.find((node) => node.props["aria-label"] === "Search settings")!;
    (search.props.onChange as (e: unknown) => void)({ target: { value: "model" } });
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "toggleSettings", open: true });
    // the reducer answers that bare open with the rail collapsed
    fixture.storeState = { ...fixture.storeState, botSettingsExpandAccordion: false, botSettingsExpandRemembered: false };
    expect(rowOpen(dialog(makeBot()), "model")).toBe(false);
  });

  it("one click on a remembered-expanded row collapses it", () => {
    fixture.advanced = true;
    fixture.storeState = {
      settingsOpen: true, botSettingsSection: "model", botSettingsExpandAccordion: true,
      botSettingsSectionStored: true, botSettingsExpandRemembered: true,
    };
    expect(rowOpen(dialog(makeBot()), "model")).toBe(true);
    const row = find(dialog(makeBot()), "data-bot-settings-section", "model");
    click(Children.toArray(row.props.children)[0] as Node);
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "toggleSettings", open: true });
    // the reducer answers that click with the rail collapsed
    fixture.storeState = { ...fixture.storeState, botSettingsExpandAccordion: false, botSettingsExpandRemembered: false };
    expect(rowOpen(dialog(makeBot()), "model")).toBe(false);
  });

  it("leaves Advanced mode on today's panel", () => {
    fixture.advanced = true;
    const rendered = dialog(makeBot());
    expect(isSimple(rendered)).toBe(false);
    expect(rendered.html).toContain("Search settings");
    expect(rendered.nodes.some((node) => node.props["data-bot-settings-back"])).toBe(false);
  });
});

describe("Switch them too beside the bot's model", () => {
  const opus = { instanceId: "claude", model: "claude-opus-5-5" };
  const onOwn = (count: number): Partial<Bot> => ({ tasks: [
    { threadId: "thread-scout", title: "Follows", createdAt: 1, modelSelection: opus, followsBotModel: true },
    ...Array.from({ length: count }, (_, index) => ({
      threadId: `own-${index}`, title: `Own ${index}`, createdAt: 1, modelSelection: { instanceId: "codex", model: "gpt-5.6" }, followsBotModel: false,
    })),
  ] });

  it("shows the line and its button under the Simple panel's model only while a thread runs on its own model", () => {
    expect(panel(makeBot(onOwn(0))).html).not.toContain("use their own model");
    const { html } = panel(makeBot(onOwn(1)));
    expect(html).toContain("1 thread uses its own model.");
    expect(html).toContain("Switch it too");
    expect(html.indexOf("Default model")).toBeLessThan(html.indexOf("1 thread uses its own model."));
    expect(html.indexOf("1 thread uses its own model.")).toBeLessThan(html.indexOf("Before Scout acts"));
  });

  it("shows it in the full Model section too, and its button switches them", () => {
    fixture.storeState = { settingsOpen: true, botSettingsSection: "model", botSettingsExpandAccordion: true };
    expect(dialog(makeBot(onOwn(0))).html).not.toContain("data-thread-models");
    const rendered = dialog(makeBot(onOwn(3)));
    expect(rendered.html).toContain("3 threads use their own model.");
    expect(rendered.html).toContain("Switch them too");
    fixture.values = [];
    fixture.own = 0;
    const section = capture(() => ModelSection({ bot: makeBot(onOwn(3)) }));
    const line = section.nodes.find((node) => node.type === ThreadModelsLine)!;
    click(capture(() => ThreadModelsLine(line.props as never)).nodes.find((node) => node.props["data-switch-them-too"] !== undefined)!);
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "followBotModel", botId: "scout" });
  });
});
