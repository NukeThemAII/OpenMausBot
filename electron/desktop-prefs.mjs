// What this desktop keeps whatever page its window shows, whichever port its own page is served on: the notices it
// has shown, and its usage-analytics switch.
import fs from "node:fs";
import { localDay } from "./cloud-trial-notice.mjs";

export { DESKTOP_PORTS } from "./desktop-ports.mjs";
/** The only notices a page may record, so no page can write anything else into the file. */
export const DESKTOP_NOTICES = Object.freeze(["cloud-pro-update-2026-10"]);
const CLOUD_PRO = DESKTOP_NOTICES[0];
export const HANDOFF_MS = 2 * 60_000;
const HANDOFF_PAGES = new Map([["cloud-pro", ["cloud", "server"]], ["manage", ["cloud"]]]);
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Security: a write that fails (a full disk, a kill mid-write) leaves the last whole record, analytics opt-out included. */
export function jsonFile(file, files = fs) {
  return {
    read: () => JSON.parse(files.readFileSync(file, "utf8")),
    write: value => {
      const temporary = `${file}.${process.pid}.tmp`;
      try {
        files.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
        files.renameSync(temporary, file);
      } catch (error) {
        try { files.rmSync(temporary, { force: true }); } catch {}
        throw error;
      }
    },
  };
}

function parse(raw) {
  const record = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const seen = Array.isArray(record.seen) ? DESKTOP_NOTICES.filter(id => record.seen.includes(id)) : [];
  const shown = Object.fromEntries(DESKTOP_NOTICES.flatMap(id => {
    const day = record.shown && typeof record.shown === "object" ? record.shown[id] : undefined;
    return typeof day === "string" && DAY.test(day) ? [[id, day]] : [];
  }));
  return { seen, shown, ...(typeof record.analytics === "boolean" ? { analytics: record.analytics } : {}) };
}

/** A record that cannot be written is still kept for this launch. */
export function createDesktopPrefs({ read, write, now = Date.now }) {
  let record = null;
  const current = () => {
    if (record) return record;
    let raw = null;
    try { raw = read(); } catch {}
    return (record = parse(raw));
  };
  const save = next => { record = next; try { write(next); } catch {} };
  return {
    seen: () => [...current().seen],
    markSeen(id) {
      const saved = current();
      if (DESKTOP_NOTICES.includes(id) && !saved.seen.includes(id)) save({ ...saved, seen: [...saved.seen, id] });
    },
    /** True the first time a notice not yet seen counts as shown on a calendar day. */
    shown(id) {
      const saved = current(), day = localDay(now());
      if (!DESKTOP_NOTICES.includes(id) || saved.seen.includes(id) || saved.shown[id] === day) return false;
      save({ ...saved, shown: { ...saved.shown, [id]: day } });
      return true;
    },
    /** null until a choice is saved. */
    analytics: () => current().analytics ?? null,
    setAnalytics(enabled) { save({ ...current(), analytics: enabled === true }); },
  };
}

/**
 * `page(event)`: "local" for this computer's page, "cloud" for My Cloud's own page as main verifies it, "server" for
 * another saved server open in this desktop's window, null for anything else. `cloudOffered()`: this desktop sells
 * MausBot Cloud, asked once its Cloud sign-in is restored. `thisComputer()`: switches the window to This computer,
 * false when it cannot.
 */
export function registerDesktopPrefs({ ipcMain, read, write, page, cloudOffered, thisComputer, now = Date.now }) {
  let prefs = null;
  const store = () => prefs ??= createDesktopPrefs({ read, write, now });
  let switched = false, handoff = null;
  const from = (channel, pages, handler) => (event, ...args) => {
    const asking = page(event);
    if (!pages.includes(asking)) throw new Error(`${channel} is only available in this app's window`);
    return handler(asking, ...args);
  };
  const ANY = ["local", "cloud", "server"];
  ipcMain.handle("desktop-notices:state", from("desktop-notices:state", ANY, async () => ({ seen: store().seen(), cloud: await cloudOffered() })));
  ipcMain.handle("desktop-notices:seen", from("desktop-notices:seen", ANY, (_, id) => { store().markSeen(id); if (id === CLOUD_PRO) handoff = null; }));
  ipcMain.handle("desktop-notices:shown", from("desktop-notices:shown", ANY, (_, id) => store().shown(id)));
  // Security: a server's page brings the window to This computer only once a launch while the popup is unseen, and hands
  // This computer's page only the popup's own click: Continue on this computer, which that page finishes from the plan it
  // knows itself; only My Cloud's own page hands over Manage plan.
  ipcMain.handle("desktop-notices:this-computer", from("desktop-notices:this-computer", ["cloud", "server"], async (asking, intent) => {
    if (!HANDOFF_PAGES.get(intent)?.includes(asking)) throw new Error("This page cannot hand that click to This computer");
    if (switched) return false;
    switched = true;
    let moved = false;
    try {
      if (!(await cloudOffered()) || store().seen().includes(CLOUD_PRO)) return false;
      handoff = { intent, until: now() + HANDOFF_MS };
      moved = await thisComputer() === true;
      return moved;
    } finally {
      if (!moved) { switched = false; handoff = null; }
    }
  }));
  ipcMain.handle("desktop-notices:handoff", from("desktop-notices:handoff", ["local"], () => handoff && now() < handoff.until ? { ...handoff } : null));
  // Security: a server's page learns only that this desktop turned analytics off, never that it is on.
  ipcMain.on("desktop-analytics:read", event => {
    try {
      const asking = page(event), saved = store().analytics();
      event.returnValue = asking === "local" ? saved : asking && saved === false ? false : null;
    } catch { event.returnValue = null; }
  });
  ipcMain.handle("desktop-analytics:set", from("desktop-analytics:set", ["local"], (_, enabled) => { store().setAnalytics(enabled === true); }));
}
