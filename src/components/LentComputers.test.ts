import { beforeEach, expect, it } from "vitest";
import { setLocale } from "@/lib/i18n";
import { lentComputerLines, type KnownLentComputer } from "./LentComputers";

beforeEach(() => setLocale("en"));
const NOW = Date.UTC(2026, 9, 18, 12);
const pc: KnownLentComputer = { id: "c1", name: "ASH-PC", platform: "win32", online: false, busy: false, lent: true,
  lastSeenAt: NOW - 11 * 86_400_000, lastUsedAt: NOW - 11 * 86_400_000 - 3_600_000, scopes: { folders: 2, terminal: false, screen: true } };

it("My Cloud says of each computer whether it is online, since when not, what it lends and when it last used it", () => {
  expect(lentComputerLines(pc, NOW)).toEqual(["Offline, last online Oct 7. It reconnects by itself once OpenMausBot is open on it.", "Shares: 2 folders, apps and screen", "Last used Oct 7"]);
  expect(lentComputerLines({ ...pc, online: true, lastUsedAt: null }, NOW)).toEqual(["Online now", "Shares: 2 folders, apps and screen", "Not used yet"]);
  expect(lentComputerLines({ ...pc, online: true, busy: true }, NOW)[0]).toBe("Cloud bots are using it now");
  expect(lentComputerLines({ ...pc, lent: false }, NOW)).toEqual(["No longer shared: sharing was turned off on it Oct 7.", "Last used Oct 7"]);
});
