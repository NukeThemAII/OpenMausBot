import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Duplex } from "node:stream";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { createCloudPowerGate } from "./cloud-power.mjs";
import { createComputerSharing } from "./computer-sharing.mjs";
import { autostartEntry, createOpenAtLogin, HIDDEN_ARG } from "./open-at-login.mjs";
import { createAllWindowsClosedQuit } from "./window-all-closed.mjs";

const ORIGIN = "https://omb-u-fixture.fly.dev";
const env = { id: "my-cloud", name: "My Cloud", origin: ORIGIN };

const until = async (check, what, ms = 5000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await check()) return; await delay(10); }
  assert.fail(`timed out waiting for ${what}`);
};

/** My Cloud's HTTP side, as the poll sees it; `link` says whether it advertises the device link. */
function cloudHome({ link = true } = {}) {
  const json = (value, status = 200) => ({ ok: status < 400, status, headers: { get: () => null }, body: (async function* () { yield Buffer.from(JSON.stringify(value)); })() });
  const state = { environmentId: randomUUID(), sessionId: randomUUID(), connects: [], polls: 0, disconnects: 0 };
  state.fetch = async (url, init) => {
    const route = new URL(url).pathname;
    if (route === "/api/auth/session") return json({ kind: "session", id: state.sessionId, scopes: ["admin", "client"], cloudHome: true });
    if (route === "/.well-known/openmausbot/environment") return json({ environmentId: state.environmentId, capabilities: { sharedComputers: true, lendingDetails: true, ...(link ? { deviceLink: true } : {}) } });
    const body = init?.body ? JSON.parse(init.body) : {};
    if (route === "/api/shared-computers/connect") { state.connects.push(body); return json({ ok: true }); }
    if (route.endsWith("/poll")) {
      state.polls++;
      await delay(100, undefined, { signal: init?.signal }).catch(() => {});
      init?.signal?.throwIfAborted();
      return json({ job: null });
    }
    if (route.endsWith("/disconnect")) { state.disconnects++; return json({ ok: true }); }
    return json({ ok: true });
  };
  return state;
}

/** The device link's WebSocket as the test drives it: every dial is kept, and opens unless told otherwise. */
function fakeSockets() {
  const made = [];
  class FakeSocket {
    constructor(url, init) {
      this.url = url; this.headers = init?.headers ?? {}; this.sent = []; this.closed = false;
      made.push(this);
      setImmediate(() => { if (!this.closed) this.onopen?.(); });
    }
    send(frame) { this.sent.push(frame); }
    close() { this.end(1000, ""); }
    end(code, reason) { if (this.closed) return; this.closed = true; setImmediate(() => this.onclose?.({ code, reason })); }
    deliver(data) { this.onmessage?.({ data }); }
  }
  return { FakeSocket, made, open: () => made.filter((socket) => !socket.closed) };
}

async function fixture(t, { link = true, adminWord = null } = {}) {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "omb-use-my-mac-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const home = cloudHome({ link });
  const sockets = fakeSockets();
  let word = adminWord;
  const power = createCloudPowerGate({ power: () => word, holdMs: 60_000 });
  const summaries = [];
  const connects = [];
  const make = () => createComputerSharing({
    file: path.join(dir, "profile", "computer-sharing.json"), fetch: home.fetch, environments: () => [env], enabled: async () => false,
    cloud: () => ({ status: "connected", accountId: "acct_1", origin: ORIGIN }), home: path.join(dir, "home"), cuaConnection: async () => null,
    power, WebSocket: sockets.FakeSocket, linkHeaders: () => ({ cookie: "omb_session_fixture=token" }), onChange: (summary) => summaries.push(summary),
    egress: {
      interfaces: () => ({}),
      resolve: async (host) => [{ address: host.startsWith("lan.") ? "192.168.1.1" : "93.184.215.14", family: 4 }],
      connect: (options) => { connects.push(options); const socket = new Duplex({ read() {}, write(_chunk, _encoding, done) { done(); } }); setImmediate(() => socket.emit("connect")); return socket; },
    },
  });
  let sharing = make();
  t.after(() => sharing.close());
  return { dir, home, sockets, power, summaries, connects, sharing, setWord: (next) => { word = next; power.changed(); },
    restart: () => { sharing.close(); sharing = make(); return sharing; } };
}

test("the internet connection alone is lent: it registers with My Cloud and opens the device link with the poll's own sign-in and the grant's secret", async (t) => {
  const { home, sockets, sharing } = await fixture(t);
  const lent = await sharing.saveCloud(env, { folders: [], screen: false, internet: true });
  assert.equal(lent.enabled, true);
  await until(() => sockets.open().length === 1 && sharing.cloudState(env).link === "on", "the device link to open");
  assert.equal(home.connects.length, 1);
  assert.deepEqual({ folders: home.connects[0].folders, computer: home.connects[0].computer, internet: home.connects[0].internet }, { folders: [], computer: false, internet: true });
  const [socket] = sockets.made;
  assert.equal(socket.url, `wss://omb-u-fixture.fly.dev/api/shared-computers/${home.connects[0].id}/link`);
  assert.equal(socket.headers.cookie, "omb_session_fixture=token");
  assert.match(socket.headers["x-omb-computer-secret"], /^[a-f0-9]{64}$/);
  assert.equal(socket.headers["x-omb-background"], "1", "the link never counts as the person using My Cloud");
  assert.equal(socket.headers.origin, ORIGIN);
  assert.deepEqual({ internet: sharing.cloudState(env).internet, link: sharing.cloudState(env).link }, { internet: true, link: "on" });
});

test("a grant without the internet connection, or a Cloud too old for the device link, never dials it", async (t) => {
  const { dir, sockets, sharing, home } = await fixture(t);
  const folder = path.join(dir, "Plans");
  await mkdir(folder);
  await sharing.saveCloud(env, { folders: [{ id: randomUUID(), path: folder, write: false }], screen: false });
  await until(() => sharing.cloudState(env).connected, "lending to connect");
  await delay(150);
  assert.equal(sockets.made.length, 0);
  assert.equal(home.connects[0].internet, false, "My Cloud learns the connection is not lent");
  const old = await fixture(t, { link: false });
  await old.sharing.saveCloud(env, { folders: [], screen: false, internet: true });
  await until(() => old.sharing.cloudState(env).connected, "lending to the old Cloud to connect");
  await delay(150);
  assert.equal(old.sockets.made.length, 0, "an old Cloud is never dialled at a path it does not have");
  assert.equal(Object.hasOwn(old.home.connects[0], "internet"), false, "an old Cloud refuses fields it does not know");
  assert.equal(old.sharing.cloudState(env).link, "unsupported", "and the switch says My Cloud is updating");
});

test("a Cloud going to sleep is never dialled: its asleep close holds the link, and so does the Admin's word, until it wakes", async (t) => {
  const { sockets, sharing, power, setWord } = await fixture(t);
  await sharing.saveCloud(env, { folders: [], screen: false, internet: true });
  await until(() => sockets.open().length === 1, "the device link to open");
  sockets.made[0].end(4001, "asleep");
  await until(() => power.asleep(), "the asleep close to hold My Cloud");
  await delay(400);
  assert.equal(sockets.made.length, 1, "nothing dials a Cloud that said it is going to sleep");
  assert.equal(sharing.cloudState(env).problem, "asleep", "the switch says My Cloud is asleep");
  power.woke();
  await until(() => sockets.open().length === 1 && sockets.made.length === 2, "the link to come back once My Cloud is awake");
  // The Admin says it sleeps: the link that went silent is not dialled again until the Admin says it is awake.
  setWord({ state: "asleep", since: 1, sleeps: true });
  sockets.made[1].end(1006, "");
  await delay(400);
  assert.equal(sockets.made.length, 2, "nothing dials a Cloud the Admin says is asleep");
  setWord({ state: "awake", since: 2, sleeps: true });
  await until(() => sockets.made.length === 3, "the link to come back once the Admin says it is awake");
});

test("the tray reads In use while My Cloud's browsing goes through this computer, and not otherwise", async (t) => {
  const { sockets, sharing, summaries, connects } = await fixture(t);
  await sharing.saveCloud(env, { folders: [], screen: false, internet: true });
  await until(() => sockets.open().length === 1, "the device link to open");
  assert.equal(summaries.at(-1).busy, null);
  const socket = sockets.made[0];
  socket.deliver(JSON.stringify({ t: "open", id: 1, host: "example.test", port: 443 }));
  await until(() => socket.sent.includes(JSON.stringify({ t: "opened", id: 1 })), "the stream to open");
  assert.equal(connects.length, 1);
  const frame = Buffer.concat([Buffer.from([0, 0, 0, 1]), Buffer.from("GET / HTTP/1.1\r\n\r\n")]);
  socket.deliver(frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.length));
  await until(() => summaries.at(-1)?.busy?.action === "internet", "In use");
  assert.equal(summaries.at(-1).busy.env, env.id);
});

test("each site opened through this computer is in its activity, refused ones too, once per site and outcome every 10 minutes", async (t) => {
  const { sockets, sharing } = await fixture(t);
  await sharing.saveCloud(env, { folders: [], screen: false, internet: true });
  await until(() => sockets.open().length === 1, "the device link to open");
  const socket = sockets.made[0];
  let id = 0;
  const answered = (n) => socket.sent.some((frame) => typeof frame === "string" && JSON.parse(frame).id === n && ["opened", "refused", "failed"].includes(JSON.parse(frame).t));
  for (const host of ["www.instagram.com", "www.instagram.com", "lan.home.test", "lan.home.test", "www.youtube.com"]) {
    const n = ++id;
    socket.deliver(JSON.stringify({ t: "open", id: n, host, port: 443 }));
    await until(() => answered(n), `an answer for ${host}`);
  }
  const browsed = sharing.activity(env.id, 30).filter((entry) => entry.action === "internet").reverse();
  assert.deepEqual(browsed.map((entry) => [entry.detail, entry.ok, entry.error]),
    [["www.instagram.com", true, undefined], ["lan.home.test", false, "home-network"], ["www.youtube.com", true, undefined]]);
  assert.equal(browsed[0].origin, ORIGIN);
});

test("a lent folder deleted since is left out, and the rest, the internet connection with it, keeps working", async (t) => {
  const fixtureState = await fixture(t);
  const { dir, home, sockets } = fixtureState;
  const plans = path.join(dir, "Plans"), notes = path.join(dir, "Notes");
  await mkdir(plans); await mkdir(notes);
  await fixtureState.sharing.saveCloud(env, { folders: [{ id: randomUUID(), path: plans, write: true }, { id: randomUUID(), path: notes, write: false }], screen: false, internet: true });
  await until(() => sockets.open().length === 1, "the device link to open");
  await rm(plans, { recursive: true, force: true });
  const again = fixtureState.restart();
  again.start();
  await until(() => home.connects.length === 2 && sockets.open().length === 1, "lending to come back after the restart");
  assert.deepEqual(home.connects[1].folders.map((folder) => folder.name), ["Notes"], "the deleted folder is no longer offered");
  assert.equal(again.cloudState(env).link, "on");
});

test("the person's own Off survives a restart: lending stays off, the link is never dialled, and why is kept", async (t) => {
  const fixtureState = await fixture(t);
  const { sockets, home } = fixtureState;
  await fixtureState.sharing.saveCloud(env, { folders: [], screen: false, internet: true });
  await until(() => sockets.open().length === 1, "the device link to open");
  fixtureState.sharing.revoke(env);
  await until(() => sockets.open().length === 0, "the link to end with lending");
  const connectsBefore = home.connects.length;
  const again = fixtureState.restart();
  again.start();
  await delay(300);
  assert.equal(home.connects.length, connectsBefore, "a restart lends nothing the person turned off");
  assert.equal(sockets.made.length, 1);
  assert.deepEqual({ enabled: again.cloudState(env).enabled, reason: again.cloudState(env).stopped?.reason, internet: again.cloudState(env).internet }, { enabled: false, reason: "you", internet: true });
});

test("lending on opens the app at login, out of sight; off removes only the login item this app added", async (t) => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "omb-login-item-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const calls = [];
  const fakeApp = (settings = { openAtLogin: false, wasOpenedAtLogin: false }) => ({
    isPackaged: true, settings,
    getLoginItemSettings(options) { calls.push(["get", options]); return { ...settings }; },
    setLoginItemSettings(next) { calls.push(["set", next]); Object.assign(settings, { openAtLogin: next.openAtLogin }); },
  });
  const mac = fakeApp();
  const login = createOpenAtLogin({ app: mac, file: path.join(dir, "mac.json"), platform: "darwin", home: dir });
  login.follow(true);
  assert.equal(mac.settings.openAtLogin, true);
  mac.settings.wasOpenedAtLogin = true;
  assert.equal(login.startedHidden(), true, "a launch from the login item lending added starts hidden");
  login.follow(false);
  assert.equal(mac.settings.openAtLogin, false);
  const theirs = fakeApp({ openAtLogin: true, wasOpenedAtLogin: true });
  const kept = createOpenAtLogin({ app: theirs, file: path.join(dir, "theirs.json"), platform: "darwin", home: dir });
  kept.follow(true);
  kept.follow(false);
  assert.equal(theirs.settings.openAtLogin, true, "a login item the person set up is theirs");
  assert.equal(kept.startedHidden(), false, "and it opens the window as before");
  const windows = fakeApp();
  const win = createOpenAtLogin({ app: windows, file: path.join(dir, "win.json"), platform: "win32", home: dir, argv: ["OpenMausBot.exe", HIDDEN_ARG] });
  win.follow(true);
  assert.deepEqual(calls.filter(([kind]) => kind === "set").at(-1), ["set", { openAtLogin: true, args: [HIDDEN_ARG] }]);
  assert.equal(win.startedHidden(), true);
  assert.equal(createOpenAtLogin({ app: windows, file: path.join(dir, "win.json"), platform: "win32", home: dir, argv: ["OpenMausBot.exe"] }).startedHidden(), false);
  const config = path.join(dir, "config");
  const linux = createOpenAtLogin({ app: fakeApp(), file: path.join(dir, "linux.json"), platform: "linux", home: dir, env: { XDG_CONFIG_HOME: config, APPIMAGE: "/home/me/Apps/Open Maus$Bot.AppImage" } });
  linux.follow(true);
  const entry = path.join(config, "autostart", "openmausbot.desktop");
  assert.equal(await readFile(entry, "utf8"), autostartEntry("/home/me/Apps/Open Maus$Bot.AppImage"));
  assert.match(await readFile(entry, "utf8"), /^Exec="\/home\/me\/Apps\/Open Maus\\\$Bot\.AppImage" --omb-hidden$/m);
  linux.follow(false);
  await assert.rejects(readFile(entry, "utf8"), { code: "ENOENT" });
  await mkdir(path.dirname(entry), { recursive: true });
  await writeFile(entry, "[Desktop Entry]\nExec=openmausbot\n");
  linux.follow(true);
  linux.follow(false);
  assert.equal(await readFile(entry, "utf8"), "[Desktop Entry]\nExec=openmausbot\n", "an autostart entry the person wrote is never replaced or removed");
  const unpackaged = { ...fakeApp(), isPackaged: false };
  createOpenAtLogin({ app: unpackaged, file: path.join(dir, "dev.json"), platform: "darwin", home: dir }).follow(true);
  assert.equal(unpackaged.settings.openAtLogin, false, "a development build never registers itself");
});

test("an app started hidden at login runs with no window until the person opens one, then quits on its last close as before", () => {
  const listeners = new Map();
  const app = { on: (event, listener) => listeners.set(event, listener), quit: () => app.quits++, quits: 0 };
  const windows = [];
  let hidden = true;
  const quit = createAllWindowsClosedQuit({ app, platform: "linux", allWindows: () => windows, stayOpen: () => hidden });
  quit.settleStartup();
  assert.equal(app.quits, 0, "no window at all, and still running for lending");
  hidden = false;
  windows.push({});
  windows.length = 0;
  listeners.get("window-all-closed")();
  assert.equal(app.quits, 1);
});
