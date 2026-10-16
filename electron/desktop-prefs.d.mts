export { DESKTOP_PORTS } from "./desktop-ports.mjs";
export declare const DESKTOP_NOTICES: readonly string[];
export declare const HANDOFF_MS: number;
export interface DesktopNoticesState {
  /** Notices this desktop has shown and someone closed, on whichever page of its window. */
  seen: string[];
  /** This desktop sells MausBot Cloud: the installed app, not a branded build, not connected to another computer. */
  cloud: boolean;
}
/**
 * A click on the Cloud Pro popup that a server's page hands This computer's page to finish, without the popup showing
 * there: "manage" (My Cloud's own page only) opens Settings → MausBot Cloud; "cloud-pro", sent by a page that cannot know
 * the plan, does what This computer's own popup offers for the plan it knows: the Add a Cloud dialog, or Settings.
 */
export type DesktopHandoffIntent = "manage" | "cloud-pro";
export interface DesktopHandoff {
  intent: DesktopHandoffIntent;
  /** Epoch ms after which the click is too old to finish. */
  until: number;
}
/** On every page this desktop's window shows: this computer's, My Cloud's or another saved server's. */
export interface DesktopNoticesBridge {
  state(): Promise<DesktopNoticesState>;
  seen(id: string): Promise<void>;
  /** True the first time today the notice counts as shown on this desktop. */
  shown(id: string): Promise<boolean>;
  /**
   * A server's page only, right after a click on it: switches the window to This computer, once a launch while the Cloud
   * Pro popup is unseen, and hands This computer's page that click. Any other intent, or "manage" from a page main does
   * not verify as My Cloud's, is refused.
   */
  thisComputer(intent: DesktopHandoffIntent): Promise<boolean>;
  /** This computer's page only: the click a server's page handed over, until the popup is seen, while fresh. */
  handoff(): Promise<DesktopHandoff | null>;
}
/** The desktop's own switch, the same on every port its page is served from. */
export interface DesktopAnalyticsBridge {
  /** null until a choice is saved; a server's page is told only false, when this desktop turned analytics off. */
  enabled(): boolean | null;
  /** This computer's page only. */
  set?(enabled: boolean): Promise<void>;
}
export interface DesktopPrefs {
  seen(): string[];
  markSeen(id: string): void;
  shown(id: string): boolean;
  analytics(): boolean | null;
  setAnalytics(enabled: boolean): void;
}
type Files = Pick<typeof import("node:fs"), "readFileSync" | "writeFileSync" | "renameSync" | "rmSync">;
export declare function jsonFile(file: string, files?: Files): { read(): unknown; write(value: unknown): void };
export declare function createDesktopPrefs(options: { read(): unknown; write(value: unknown): void; now?: () => number }): DesktopPrefs;
export declare function registerDesktopPrefs(options: {
  ipcMain: { handle(channel: string, handler: (event: unknown, ...args: unknown[]) => unknown): void; on(channel: string, listener: (event: { returnValue?: unknown }) => void): void };
  read(): unknown;
  write(value: unknown): void;
  page(event: unknown): "local" | "cloud" | "server" | null;
  cloudOffered(): Promise<boolean>;
  thisComputer(): Promise<boolean>;
  now?: () => number;
}): void;
