// While this computer is lent, the app starts with the person's session, out of sight, so My Cloud's bots can use it
// again after a restart without anyone opening it. Only a login item this app added for lending is ever removed, and
// only such a launch starts hidden: one the person set up themselves opens the window as before.
import fs from "node:fs";
import path from "node:path";

export const HIDDEN_ARG = "--omb-hidden";
const MARK = "X-OpenMausBot-Lending=true";

/** Desktop Entry Exec quoting: the path in double quotes, with ", `, $ and \ escaped. */
const quoted = (value) => `"${value.replace(/["`$\\]/g, (match) => `\\${match}`)}"`;

export function autostartEntry(exec) {
  return ["[Desktop Entry]", "Type=Application", "Name=OpenMausBot", `Exec=${quoted(exec)} ${HIDDEN_ARG}`, "NoDisplay=true", "X-GNOME-Autostart-enabled=true", MARK, ""].join("\n");
}

/**
 * `file`: where this app records that it added the login item (macOS, where a login item carries no arguments).
 * `follow(on)` keeps the login item in step with lending; `startedHidden()` says this launch came from it.
 */
export function createOpenAtLogin({ app, file, platform = process.platform, env = process.env, home, argv = process.argv, execPath = process.execPath }) {
  const autostart = path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "autostart", "openmausbot.desktop");
  const added = () => { try { return JSON.parse(fs.readFileSync(file, "utf8")).added === true; } catch { return false; } };
  const remember = (value) => { try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ added: value })); } catch {} };
  const ours = () => { try { return fs.readFileSync(autostart, "utf8").includes(MARK); } catch { return false; } };
  return {
    follow(on) {
      if (!app.isPackaged) return;
      try {
        if (platform === "linux") {
          if (on && !fs.existsSync(autostart)) {
            fs.mkdirSync(path.dirname(autostart), { recursive: true });
            fs.writeFileSync(autostart, autostartEntry(env.APPIMAGE || execPath));
          } else if (!on && ours()) fs.rmSync(autostart, { force: true });
          return;
        }
        if (platform === "win32") {
          const settings = { args: [HIDDEN_ARG] };
          if (app.getLoginItemSettings(settings).openAtLogin !== on) app.setLoginItemSettings({ openAtLogin: on, ...settings });
          return;
        }
        const set = app.getLoginItemSettings().openAtLogin === true;
        if (on && !set) { app.setLoginItemSettings({ openAtLogin: true }); remember(true); }
        else if (!on && set && added()) { app.setLoginItemSettings({ openAtLogin: false }); remember(false); }
        else if (!set && added()) remember(false);
      } catch {}
    },
    startedHidden() {
      if (platform === "darwin") {
        try { return app.getLoginItemSettings().wasOpenedAtLogin === true && added(); } catch { return false; }
      }
      return argv.includes(HIDDEN_ARG);
    },
  };
}
