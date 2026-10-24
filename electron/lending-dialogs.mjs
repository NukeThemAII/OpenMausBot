// Security: lending this computer lets bots read its folders, run commands or act in its apps as the person. These are
// main's own dialogs, which no page (this computer's or a server's) can draw or answer, and each one defaults to Cancel
// but Use my Mac, which shows only after a few seconds with no typing, so a key meant for the page never answers it.
import { randomUUID } from "node:crypto";

/** The word the person knows this computer by, and the popup's button. */
const USE_WORDS = Object.freeze({
  darwin: { computer: "this Mac", use: "Use my Mac" },
  win32: { computer: "this PC", use: "Use my PC" },
  other: { computer: "this computer", use: "Use this computer" },
});

/** "Use my Mac": the popup's question, its one line and its buttons. `screen`: apps and screen can be lent here. */
export function useMyComputerText(platform, { screen }) {
  const words = USE_WORDS[platform] ?? USE_WORDS.other;
  return {
    message: `Let your bots use ${words.computer}?`,
    detail: screen
      ? "Like before, they can use its internet connection, read your Desktop, Documents and Downloads, and use your apps and screen."
      : "Like before, they can use its internet connection and read your Desktop, Documents and Downloads.",
    buttons: [words.use, "Not now"],
  };
}

export function serverAccessDetail(env, { folders, terminal, computer }) {
  return [
    `Server: ${env.origin}`,
    ...folders.map(folder => `${folder.write ? "Read and write" : "Read only"}: ${folder.path}${folder.home ? " (your whole home folder)" : ""}`),
    terminal === true ? "Terminal: UNRESTRICTED commands as your user. Can access files outside the folders above, including credentials." : "Terminal: off",
    computer === true ? "Computer control: can view your screen and operate logged-in apps. Can access information outside the folders above." : "Computer control: off",
    "Shared content is sent to this server and may reach its model provider. Bots on this server can use these permissions until you revoke them. Closing the desktop stops access.",
  ].join("\n\n");
}

/**
 * @param {{
 *   dialog: { showOpenDialog: Function, showMessageBox: Function },
 *   window: () => ({ isDestroyed(): boolean } | null),
 *   validate: (folders: Array<{ id: string, path: string, write: boolean, home?: boolean }>) => Promise<Array<{ id: string, path: string, name: string, write: boolean, home?: boolean }>>,
 *   isHome?: (path: string) => Promise<boolean>,
 * }} deps
 */
export function createLendingDialogs({ dialog, window, validate, isHome = async () => false, platform = process.platform }) {
  return {
    /** Use my Mac, asked in `parent`: "use" or "later". */
    async useMyComputer(parent, { screen }) {
      const { message, detail, buttons } = useMyComputerText(platform, { screen });
      const { response } = await dialog.showMessageBox(parent, { type: "question", message, detail, buttons, defaultId: 0, cancelId: 1, noLink: true });
      return response === 0 ? "use" : "later";
    },
    /** The folder or drive the person picks, read only and checked as every lent folder is; null when they cancel. The
     * home folder is lent only when it is picked here and confirmed here: the folders above it and the system disk never are. */
    async chooseFolder(title) {
      const picked = await dialog.showOpenDialog(window(), { title, properties: ["openDirectory"] });
      if (picked.canceled || !picked.filePaths[0]) return null;
      const folder = { id: randomUUID(), path: picked.filePaths[0], write: false };
      if (await isHome(folder.path)) {
        // What stays private is `personalSecretPaths` and this app's own data (computer-sharing.mjs `protectedRoots`),
        // refused inside any lent folder, the home folder included.
        const { response } = await dialog.showMessageBox(window(), { type: "warning", message: "Share your whole home folder?",
          detail: "Everything in your home folder becomes readable by the bots you allow. The places that hold keys, passwords and browser data, like .ssh and your browsers' profiles, always stay private.",
          buttons: ["Share home folder", "Cancel"], defaultId: 1, cancelId: 1 });
        if (response !== 0) return null;
        folder.home = true;
      }
      return (await validate([folder]))[0];
    },
    async confirmServerAccess(env, grant) {
      const { response } = await dialog.showMessageBox(window(), { type: "warning", message: `Allow computer access for ${env.name}?`, detail: serverAccessDetail(env, grant), buttons: ["Allow access", "Cancel"], defaultId: 1, cancelId: 1 });
      return response === 0;
    },
    /** Apps and screen asked for from My Cloud's page: false when there is no window to ask in. */
    async confirmScreen() {
      const parent = window();
      if (!parent || parent.isDestroyed()) return false;
      const { response } = await dialog.showMessageBox(parent, {
        type: "warning", message: "Let your bots on My Cloud use your apps and screen?",
        detail: "In your own conversations and routines, they can see your screen, click and type in your apps as you, while this computer is awake with OpenMausBot open. That reaches anything those apps can reach. You can turn it off at any time on My Cloud's page or in Settings → MausBot Cloud.",
        buttons: ["Lend apps and screen", "Cancel"], defaultId: 1, cancelId: 1,
      });
      return response === 0;
    },
  };
}
