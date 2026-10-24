import type { LocaleKey } from "@/locales";
import type { BotSettingsSection } from "@/state/store";

export const PANEL_TABS = ["bot", "computer"] as const;
export type PanelTab = (typeof PANEL_TABS)[number];

export const TAB_LABEL: Record<PanelTab, LocaleKey> = {
  bot: "botPanel.avatar.tabBot",
  computer: "botPanel.tab.computer",
};

export type PageId =
  | "setup" | "model" | "instructions" | "approvals" | "always" | "routines" | "apps"
  | "memory" | "skills"
  | "browser" | "folder" | "android"
  | "voice" | "blurb" | "team" | "chiefteams" | "mcp" | "tools" | "webhooks" | "visibility" | "slack"
  | "overview" | "prompt" | "history";

/** The pages Simple mode draws; a link to any other page lands where its section does. */
export const SIMPLE_PAGES = ["apps", "routines", "memory", "skills", "folder", "browser"] as const satisfies readonly PageId[];
export type SimplePageId = (typeof SIMPLE_PAGES)[number];

export function isSimplePage(page: PageId): page is SimplePageId {
  return (SIMPLE_PAGES as readonly PageId[]).includes(page);
}

export interface PageMeta {
  title: LocaleKey;
  home: PanelTab;
  intro?: LocaleKey;
}

export const PAGES: Record<PageId, PageMeta> = {
  setup: { title: "botSetup.ideas", home: "bot" },
  model: { title: "model.simple.model", home: "bot" },
  instructions: { title: "botSettings.simple.instructions", home: "bot" },
  approvals: { title: "botPanel.page.approvals", home: "bot" },
  routines: { title: "botSettings.simple.routines", home: "bot" },
  apps: { title: "botPanel.appsRow", home: "bot", intro: "botPanel.apps.intro" },
  memory: { title: "botPanel.memoryRow", home: "bot", intro: "botPanel.memory.intro" },
  skills: { title: "botSettings.simple.skills", home: "bot", intro: "botSettings.simple.skillsHint" },
  browser: { title: "settings.sites.title", home: "computer" },
  folder: { title: "computer.files.folder", home: "bot", intro: "botPanel.folder.intro" },
  android: { title: "botPanel.page.android", home: "computer" },
  voice: { title: "botPanel.page.voice", home: "bot" },
  blurb: { title: "botPanel.page.blurb", home: "bot" },
  team: { title: "botPanel.page.team", home: "bot" },
  chiefteams: { title: "botPanel.page.chiefTeams", home: "bot" },
  mcp: { title: "connectors.tab.mcp", home: "bot" },
  tools: { title: "botAccess.tools.title", home: "bot" },
  webhooks: { title: "botPanel.page.webhooks", home: "bot" },
  always: { title: "botPanel.page.always", home: "bot" },
  visibility: { title: "botSettings.visibility.title", home: "bot" },
  slack: { title: "botPanel.page.slack", home: "bot" },
  overview: { title: "botPanel.page.overview", home: "bot" },
  prompt: { title: "botPanel.page.prompt", home: "bot" },
  history: { title: "botPanel.page.history", home: "bot" },
};

export const PAGE_IDS = Object.keys(PAGES) as PageId[];

export interface PanelTarget {
  tab: PanelTab;
  page?: SimplePageId;
  anchor?: string;
  /** Opens the Instructions editor in place on the Bot tab. */
  editInstructions?: boolean;
}

const SECTION_TARGET: Record<BotSettingsSection, PanelTarget> = {
  overview: { tab: "bot" },
  identity: { tab: "bot" },
  slack: { tab: "bot" },
  soul: { tab: "bot", anchor: "instructions", editInstructions: true },
  skills: { tab: "bot", page: "skills" },
  memory: { tab: "bot", page: "memory" },
  routines: { tab: "bot", page: "routines" },
  access: { tab: "computer" },
  model: { tab: "bot", anchor: "model" },
  permissions: { tab: "bot", anchor: "approval" },
  voice: { tab: "bot" },
  visibility: { tab: "bot" },
  history: { tab: "bot" },
  usage: { tab: "bot" },
};

export function sectionTarget(section: BotSettingsSection): PanelTarget {
  return SECTION_TARGET[section];
}
