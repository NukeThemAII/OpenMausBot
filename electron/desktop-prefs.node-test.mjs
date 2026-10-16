import assert from "node:assert/strict";
import fs, { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { createDesktopPrefs, DESKTOP_NOTICES, DESKTOP_PORTS, HANDOFF_MS, jsonFile, registerDesktopPrefs } from "./desktop-prefs.mjs";
import { localDay } from "./cloud-trial-notice.mjs";

const require = createRequire(import.meta.url);
const environments = require("./environments.cjs");
const localOrigin = require("./local-origin.cjs");

const POPUP = "cloud-pro-update-2026-10";
const HOUR = 3600_000, NOON = new Date(2026, 9, 16, 12).getTime();
const LOCAL = "http://127.0.0.1:18799", CLOUD = "https://omb-u-1.fly.dev", VPS = "https://bots.example.test";

test("the popup is the one notice a page can record; seen and analytics survive a restart; a broken record never stops the app", () => {
  assert.deepEqual([...DESKTOP_NOTICES], [POPUP]);
  let saved = null;
  const writes = [];
  const prefs = createDesktopPrefs({ read: () => saved, write: value => { writes.push(value); saved = structuredClone(value); }, now: () => NOON });
  assert.deepEqual(prefs.seen(), []); assert.equal(prefs.analytics(), null);
  for (const id of ["other-notice", "__proto__", "", 42]) prefs.markSeen(id);
  assert.equal(writes.length, 0, "nothing a page names outside the list is written");
  prefs.markSeen(POPUP); prefs.markSeen(POPUP);
  assert.deepEqual(prefs.seen(), [POPUP]); assert.equal(writes.length, 1);
  prefs.setAnalytics(false);
  const restarted = createDesktopPrefs({ read: () => saved, write: value => { saved = value; }, now: () => NOON });
  assert.deepEqual(restarted.seen(), [POPUP]); assert.equal(restarted.analytics(), false);
  restarted.setAnalytics("yes"); assert.equal(restarted.analytics(), false, "only true turns it on");
  restarted.setAnalytics(true); assert.equal(restarted.analytics(), true);

  const broken = createDesktopPrefs({ read: () => { throw new Error("unreadable"); }, write: () => { throw new Error("read-only disk"); }, now: () => NOON });
  assert.deepEqual(broken.seen(), []);
  broken.markSeen(POPUP); broken.setAnalytics(false);
  assert.deepEqual(broken.seen(), [POPUP], "kept for this launch when the file cannot be written");
  assert.equal(broken.analytics(), false);
  for (const record of ["nonsense", [POPUP], { seen: "all", shown: [], analytics: "off" }, { seen: [POPUP, "<b>"], shown: { [POPUP]: "today" } }]) {
    const prefs = createDesktopPrefs({ read: () => record, write: () => {}, now: () => NOON });
    assert.equal(prefs.analytics(), null, JSON.stringify(record));
    assert.ok(prefs.seen().every(id => id === POPUP), JSON.stringify(record));
    if (!prefs.seen().length) assert.equal(prefs.shown(POPUP), true, JSON.stringify(record));
  }
});

test("a write that fails leaves the last whole record on disk, analytics opt-out included", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "desktop-prefs-"));
  try {
    const file = path.join(dir, "desktop-prefs.json");
    createDesktopPrefs(jsonFile(file)).setAnalytics(false);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { seen: [], shown: {}, analytics: false });
    // As a full disk or a file-size limit does: the file is opened and emptied, then the write fails.
    const full = { ...fs, writeFileSync: target => { fs.writeFileSync(target, ""); throw Object.assign(new Error("file too large"), { code: "EFBIG" }); } };
    const launch = createDesktopPrefs({ ...jsonFile(file, full), now: () => NOON });
    assert.equal(launch.shown(POPUP), true, "kept for this launch");
    launch.markSeen(POPUP);
    assert.throws(() => jsonFile(file, full).write({ seen: [] }), /file too large/);
    assert.deepEqual(readdirSync(dir), ["desktop-prefs.json"], "no temporary file is left behind");
    const next = createDesktopPrefs(jsonFile(file));
    assert.equal(next.analytics(), false, "the opt-out survives");
    assert.deepEqual(next.seen(), []);
    assert.deepEqual(createDesktopPrefs(jsonFile(path.join(dir, "missing.json"))).seen(), [], "no file yet");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("shown counts once a day on this desktop, whichever page asks, until the popup is seen", () => {
  let now = NOON, saved = null;
  const prefs = createDesktopPrefs({ read: () => saved, write: value => { saved = structuredClone(value); }, now: () => now });
  assert.equal(prefs.shown(POPUP), true);
  assert.equal(prefs.shown(POPUP), false, "a reload the same day");
  assert.equal(createDesktopPrefs({ read: () => saved, write: () => {}, now: () => now }).shown(POPUP), false, "another page, another launch, the same day");
  assert.equal(saved.shown[POPUP], localDay(NOON));
  now += 24 * HOUR;
  assert.equal(prefs.shown(POPUP), true, "the next day, still not seen");
  prefs.markSeen(POPUP); now += 24 * HOUR;
  assert.equal(prefs.shown(POPUP), false);
  assert.equal(prefs.shown("other-notice"), false);
});

function desktopMain({ offered = true, switches = () => true, page = event => event.page } = {}) {
  const handlers = new Map(), listeners = new Map(), calls = [];
  let saved = null, now = NOON;
  registerDesktopPrefs({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), on: (channel, listener) => listeners.set(channel, listener) },
    read: () => saved, write: value => { saved = structuredClone(value); }, page,
    cloudOffered: async () => { calls.push("offered"); return offered; },
    thisComputer: async () => { calls.push("this-computer"); return switches(); },
    now: () => now,
  });
  const ask = (channel, page, ...args) => handlers.get(channel)({ page }, ...args);
  const read = page => { const event = { page }; listeners.get("desktop-analytics:read")(event); return event.returnValue; };
  return { ask, read, calls, saved: () => saved, later: ms => { now += ms; } };
}

test("every page of this desktop's window reads and records the same notices; nothing else is answered", async () => {
  const main = desktopMain();
  for (const page of ["local", "cloud", "server"]) assert.deepEqual(await main.ask("desktop-notices:state", page), { seen: [], cloud: true });
  assert.equal(await main.ask("desktop-notices:shown", "server", POPUP), true);
  assert.equal(await main.ask("desktop-notices:shown", "local", POPUP), false, "once a day for the desktop, not per page");
  await main.ask("desktop-notices:seen", "server", POPUP);
  assert.deepEqual(await main.ask("desktop-notices:state", "local"), { seen: [POPUP], cloud: true });
  for (const channel of ["desktop-notices:state", "desktop-notices:seen", "desktop-notices:shown", "desktop-notices:this-computer", "desktop-notices:handoff", "desktop-analytics:set"]) {
    assert.throws(() => main.ask(channel, null, POPUP), /only available in this app's window/, channel);
  }
  assert.deepEqual((await desktopMain({ offered: false }).ask("desktop-notices:state", "server")).cloud, false);
});

test("main takes only the popup's own click: Continue on this computer from My Cloud's or a saved server's page, Manage plan from My Cloud's own page alone", async () => {
  const refused = [["server", "manage"], ["server", undefined], ["cloud", undefined], ["cloud", null], ["server", "upgrade"], ["cloud", "Cloud-Pro"],
    ["server", "__proto__"], ["cloud", "constructor"], ["server", { intent: "cloud-pro" }], ["cloud", ["manage"]]];
  for (const [page, intent] of refused) {
    const main = desktopMain(), name = `${page} ${JSON.stringify(intent)}`;
    await assert.rejects(main.ask("desktop-notices:this-computer", page, intent), /cannot hand that click/, name);
    assert.deepEqual(main.calls, [], `${name}: nothing is asked, nothing moves`);
    assert.equal(await main.ask("desktop-notices:handoff", "local"), null, name);
    assert.equal(await main.ask("desktop-notices:this-computer", page, "cloud-pro"), true, `${name}: not the launch's one switch`);
  }
  for (const page of ["local", null, "elsewhere"]) {
    for (const intent of ["cloud-pro", "manage"]) assert.throws(() => desktopMain().ask("desktop-notices:this-computer", page, intent), /only available/, `${page} ${intent}`);
  }
  for (const page of ["cloud", "server", null]) assert.throws(() => desktopMain().ask("desktop-notices:handoff", page), /only available/, "a server's page never takes a click");
});

test("Continue on this computer brings the window to This computer with the click, from a saved server's page or My Cloud's, once a launch while the popup is unseen", async () => {
  for (const page of ["server", "cloud"]) {
    const main = desktopMain(), handed = { intent: "cloud-pro", until: NOON + HANDOFF_MS };
    assert.equal(await main.ask("desktop-notices:this-computer", page, "cloud-pro"), true, page);
    assert.deepEqual(main.calls.filter(call => call === "this-computer"), ["this-computer"]);
    assert.equal(main.saved(), null, "This computer's page marks it seen once it finishes the click");
    assert.deepEqual(await main.ask("desktop-notices:handoff", "local"), handed, page);
    assert.equal(await main.ask("desktop-notices:this-computer", page, "cloud-pro"), false, "once a launch");
    assert.equal(await main.ask("desktop-notices:this-computer", "cloud", "manage"), false);
    assert.deepEqual(await main.ask("desktop-notices:handoff", "local"), handed, "a later ask hands nothing else over");
    assert.deepEqual(main.calls.filter(call => call === "this-computer"), ["this-computer"]);
  }
  const seen = desktopMain();
  await seen.ask("desktop-notices:seen", "local", POPUP);
  assert.equal(await seen.ask("desktop-notices:this-computer", "server", "cloud-pro"), false, "a seen popup switches nothing");
  assert.equal(await seen.ask("desktop-notices:handoff", "local"), null);
  const unsold = desktopMain({ offered: false });
  assert.equal(await unsold.ask("desktop-notices:this-computer", "server", "cloud-pro"), false);
  assert.equal(unsold.calls.includes("this-computer"), false);
  assert.equal(await unsold.ask("desktop-notices:handoff", "local"), null);
});

test("This computer's page finds a handed-over click until the popup is seen, for two minutes from the click", async () => {
  for (const [page, intent] of [["cloud", "manage"], ["cloud", "cloud-pro"], ["server", "cloud-pro"]]) {
    const main = desktopMain(), handed = { intent, until: NOON + HANDOFF_MS }, name = `${page} ${intent}`;
    assert.equal(await main.ask("desktop-notices:this-computer", page, intent), true, name);
    assert.deepEqual(await main.ask("desktop-notices:handoff", "local"), handed, name);
    assert.deepEqual(await main.ask("desktop-notices:handoff", "local"), handed, "a page that reloads before it finishes finds it again");
    await main.ask("desktop-notices:seen", "local", "other-notice");
    main.later(HANDOFF_MS - 1);
    assert.deepEqual(await main.ask("desktop-notices:handoff", "local"), handed, `${name}: still fresh`);
    await main.ask("desktop-notices:seen", "local", POPUP);
    assert.equal(await main.ask("desktop-notices:handoff", "local"), null, `${name}: finished`);

    const late = desktopMain();
    await late.ask("desktop-notices:this-computer", page, intent); late.later(HANDOFF_MS);
    assert.equal(await late.ask("desktop-notices:handoff", "local"), null, `${name}: a stale click is dropped`);
  }
});

test("a switch that fails hands nothing over and marks nothing, so a later click or launch can try again", async () => {
  let switches = false;
  const main = desktopMain({ switches: () => switches });
  for (const [page, intent] of [["cloud", "manage"], ["server", "cloud-pro"]]) {
    assert.equal(await main.ask("desktop-notices:this-computer", page, intent), false);
    assert.equal(await main.ask("desktop-notices:handoff", "local"), null);
  }
  assert.equal(main.saved(), null);
  switches = true;
  assert.equal(await main.ask("desktop-notices:this-computer", "server", "cloud-pro"), true, "not counted as the launch's one switch");
  assert.deepEqual(await main.ask("desktop-notices:handoff", "local"), { intent: "cloud-pro", until: NOON + HANDOFF_MS });
  const both = desktopMain({ switches: async () => { await new Promise(resolve => setTimeout(resolve, 5)); return true; } });
  const [first, second] = await Promise.all([both.ask("desktop-notices:this-computer", "server", "cloud-pro"), both.ask("desktop-notices:this-computer", "cloud", "manage")]);
  assert.deepEqual([first, second], [true, false], "two clicks at once switch once");
  assert.equal((await both.ask("desktop-notices:handoff", "local")).intent, "cloud-pro", "and hand over the first");
});

test("the analytics switch is This computer's page's to set; a server's page in the window is told only that it is off", async () => {
  const main = desktopMain();
  for (const page of ["local", "cloud", "server", null]) assert.equal(main.read(page), null, String(page));
  await main.ask("desktop-analytics:set", "local", false);
  assert.equal(main.read("local"), false);
  assert.equal(main.read("cloud"), false, "My Cloud's page starts with analytics off");
  assert.equal(main.read("server"), false);
  assert.equal(main.read(null), null, "a page outside this desktop's window is told nothing");
  for (const page of ["cloud", "server"]) assert.throws(() => main.ask("desktop-analytics:set", page, true), /only available/);
  assert.equal(main.read("local"), false);
  await main.ask("desktop-analytics:set", "local", true);
  assert.equal(main.read("local"), true);
  assert.equal(main.read("cloud"), null, "a server's page never learns it is on");
  assert.equal(main.read("server"), null);
  const broken = desktopMain({ page: () => { throw new Error("Object has been destroyed"); } });
  assert.equal(broken.read("local"), null);
});

const PRELOAD = readFileSync(new URL("./preload.cjs", import.meta.url), "utf8").replace(/\r\n/g, "\n");
function preload(origin, { activation = false, saved = null } = {}) {
  let bridge;
  const invoked = [], synced = [];
  vm.runInNewContext(PRELOAD, {
    process: { platform: "darwin", argv: [`--omb-local-origin=${LOCAL}`, "--omb-company-desktop=1"] },
    location: { origin }, navigator: { userActivation: { isActive: activation } }, TextEncoder, localStorage: { getItem: () => null },
    require: () => ({ webUtils: {}, contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } },
      ipcRenderer: { on() {}, removeListener() {}, send() {},
        sendSync: channel => { synced.push(channel); return channel === "desktop-analytics:read" ? saved : undefined; },
        invoke: (...args) => { invoked.push(args); return Promise.resolve(true); } } }),
  });
  return { bridge, invoked, synced };
}

test("the preload gives every page of the window the notices and the switch's state, and only This computer's page a way to set it", async () => {
  for (const origin of [CLOUD, VPS]) {
    const page = preload(origin, { saved: false });
    assert.equal(typeof page.bridge.desktopNotices.state, "function", origin);
    assert.equal(page.bridge.cloudAccount, undefined, origin);
    const asked = () => page.synced.filter(channel => channel.startsWith("desktop-"));
    assert.deepEqual(asked(), [], "nothing is asked until analytics asks");
    assert.equal(page.bridge.desktopAnalytics.enabled(), false, "turned off on this desktop");
    assert.deepEqual(asked(), ["desktop-analytics:read"]);
    assert.equal(page.bridge.desktopAnalytics.set, undefined, "a server's page cannot change the desktop's switch");
    await page.bridge.desktopNotices.state(); await page.bridge.desktopNotices.seen({ toString: () => POPUP }); await page.bridge.desktopNotices.shown(POPUP);
    await page.bridge.desktopNotices.handoff();
    assert.deepEqual(page.invoked, [["desktop-notices:state"], ["desktop-notices:seen", POPUP], ["desktop-notices:shown", POPUP], ["desktop-notices:handoff"]]);
    await assert.rejects(page.bridge.desktopNotices.thisComputer("cloud-pro"), /Choose Continue on this computer/, "only on a click");
    const clicked = preload(origin, { activation: true });
    await clicked.bridge.desktopNotices.thisComputer("cloud-pro"); await clicked.bridge.desktopNotices.thisComputer("manage");
    for (const intent of [undefined, null, "", "upgrade", "MANAGE", { toString: () => "manage" }, ["cloud-pro"], new String("cloud-pro")]) {
      await assert.rejects(clicked.bridge.desktopNotices.thisComputer(intent), /only its own click/, String(intent));
    }
    assert.deepEqual(clicked.invoked, [["desktop-notices:this-computer", "cloud-pro"], ["desktop-notices:this-computer", "manage"]], "nothing else reaches main");
  }
  const local = preload(LOCAL, { activation: true, saved: false });
  assert.equal(typeof local.bridge.desktopNotices.state, "function");
  await assert.rejects(local.bridge.desktopNotices.thisComputer("cloud-pro"), /Choose Continue/, "This computer's page has nothing to switch to");
  assert.deepEqual(local.synced, [], "nothing is asked until analytics asks");
  assert.equal(local.bridge.desktopAnalytics.enabled(), false, "answered at once, before anything loads");
  assert.equal(local.bridge.desktopAnalytics.enabled(), false);
  assert.deepEqual(local.synced, ["desktop-analytics:read"], "asked once a page");
  await local.bridge.desktopAnalytics.set(true);
  assert.equal(local.bridge.desktopAnalytics.enabled(), true);
  assert.deepEqual(local.invoked, [["desktop-analytics:set", true]]);
  const unsaved = preload(LOCAL);
  for (let i = 0; i < 3; i++) assert.equal(unsaved.bridge.desktopAnalytics.enabled(), null);
  assert.deepEqual(unsaved.synced, ["desktop-analytics:read"], "no choice saved yet is asked once too");
  assert.equal(preload(LOCAL, { saved: "off" }).bridge.desktopAnalytics.enabled(), null);
  const safe = PRELOAD.match(/const REMOTE_SAFE = new Set\(\[([^\]]*)\]\)/)[1];
  assert.ok(safe.includes('"desktopNotices"')); assert.ok(safe.includes('"desktopAnalytics"'));
});

test("production wiring: main answers this computer's page, My Cloud's own page and the active saved server's own page, and no other", async () => {
  const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  assert.match(main, /for \(const port of DESKTOP_PORTS\)/, "main tries the ports this module names, in order");
  assert.deepEqual([...DESKTOP_PORTS], [8799, 18799, 28799]);
  const start = main.indexOf("  registerDesktopPrefs({"), end = main.indexOf("\n", main.indexOf("thisComputer:", start));
  assert.ok(start >= 0 && end > start, "main.mjs registers the desktop prefs");
  let options = null;
  const localFrame = { url: `${LOCAL}/` }, serverFrame = { url: `${VPS}/` };
  const contents = { mainFrame: serverFrame };
  const calls = [];
  localOrigin.setLocalOrigin(LOCAL);
  let switched = async id => { calls.push(["switch", id]); };
  const context = vm.createContext({
    registerDesktopPrefs: value => { options = value; }, jsonFile: file => ({ read: () => file, write: () => {} }), ipcMain: {},
    path: { join: (...parts) => parts.join("/") }, app: { getPath: () => "/user-data" },
    senderIsLocal: localOrigin.isLocalSender, workspaceSenderAllowed: environments.workspaceSenderAllowed,
    mainWindow: { webContents: contents }, environmentsState: { environments: [{ id: "vps", name: "VPS", origin: VPS }], activeId: "vps" },
    rendererOrigin: () => LOCAL, cloudAccountRestored: async () => calls.push("restored"), cloudOffersReady: async () => { calls.push("offers"); return true; },
    cloudPageAsking: event => event.verifiedCloud ? "cloud" : null,
    serverReady: true, LOCAL_ID: "local", switchEnvironment: id => switched(id),
    // main's own: a failed switch shows its dialog and resolves.
    workspaceMenuAction: async action => { try { await action(); } catch { calls.push("dialog"); } },
  });
  vm.runInContext(main.slice(start, end), context);
  assert.equal(options.read(), "/user-data/desktop-prefs.json");
  assert.equal(options.page({ sender: { mainFrame: localFrame }, senderFrame: localFrame }), "local");
  assert.equal(options.page({ sender: contents, senderFrame: serverFrame }), "server");
  assert.equal(options.page({ sender: contents, senderFrame: serverFrame, verifiedCloud: true }), "cloud", "My Cloud's page as main verifies it");
  assert.equal(options.page({ sender: contents, senderFrame: { url: `${VPS}/` } }), null, "a frame inside the server's page");
  assert.equal(options.page({ sender: {}, senderFrame: serverFrame }), null, "another window");
  const evil = { url: "https://evil.example.test/" };
  assert.equal(options.page({ sender: { mainFrame: evil }, senderFrame: evil }), null, "a page that is not the active server");
  const [offered, done] = await Promise.all([options.cloudOffered(), options.thisComputer()]);
  assert.equal(offered, true); assert.equal(done, true);
  assert.deepEqual(calls, ["restored", ["switch", "local"], "offers"]);
  switched = async () => { throw new Error("could not save the servers list"); };
  assert.equal(await options.thisComputer(), false, "a switch that threw");
  assert.equal(calls.at(-1), "dialog", "still shows main's dialog");
  switched = async () => ({ ok: false, error: "switch-failed" });
  assert.equal(await options.thisComputer(), false, "a local environment switch that failed");
  switched = async () => ({ ok: true });
  assert.equal(await options.thisComputer(), true);
  context.serverReady = false;
  assert.equal(await options.thisComputer(), false, "no server to switch to");
});
