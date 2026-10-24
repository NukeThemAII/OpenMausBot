import { describe, expect, it } from "vitest";

import en from "@/locales/en.json";
import { BOT_SECTIONS } from "../bot-settings/sections";
import { isSimplePage, PAGE_IDS, PAGES, PANEL_TABS, sectionTarget, SIMPLE_PAGES, TAB_LABEL } from "./page-registry";

describe("the bot panel's page registry", () => {
  it("has two tabs, Bot and Computer", () => {
    expect(PANEL_TABS).toEqual(["bot", "computer"]);
  });

  it("lands every settings section on a tab, and on a Simple page that lives on that tab", () => {
    for (const { id } of BOT_SECTIONS) {
      const target = sectionTarget(id);
      expect(PANEL_TABS).toContain(target.tab);
      if (target.page) {
        expect(isSimplePage(target.page), id).toBe(true);
        expect(PAGES[target.page].home, id).toBe(target.tab);
      }
    }
  });

  it.each([
    ["overview", { tab: "bot" }], ["identity", { tab: "bot" }],
    ["soul", { tab: "bot", anchor: "instructions", editInstructions: true }],
    ["skills", { tab: "bot", page: "skills" }], ["memory", { tab: "bot", page: "memory" }], ["routines", { tab: "bot", page: "routines" }],
    ["access", { tab: "computer" }], ["model", { tab: "bot", anchor: "model" }], ["permissions", { tab: "bot", anchor: "approval" }],
    ["voice", { tab: "bot" }], ["visibility", { tab: "bot" }], ["history", { tab: "bot" }], ["usage", { tab: "bot" }], ["slack", { tab: "bot" }],
  ] as const)("sends a %s link to %o", (section, target) => {
    expect(sectionTarget(section)).toEqual(target);
  });

  it("draws only the six Simple pages, each on the Bot tab but the browser", () => {
    expect(SIMPLE_PAGES).toEqual(["apps", "routines", "memory", "skills", "folder", "browser"]);
    for (const page of SIMPLE_PAGES) expect(PAGES[page].home).toBe(page === "browser" ? "computer" : "bot");
    expect(isSimplePage("mcp")).toBe(false);
  });

  it("names every page, its intro and every tab in English copy", () => {
    const keys = en as Record<string, string>;
    for (const id of PAGE_IDS) {
      expect(keys[PAGES[id].title], id).toBeTruthy();
      if (PAGES[id].intro) expect(keys[PAGES[id].intro], id).toBeTruthy();
    }
    for (const tab of PANEL_TABS) expect(keys[TAB_LABEL[tab]]).toBeTruthy();
    expect(keys[TAB_LABEL.bot]).toBe("Bot");
    expect(keys[TAB_LABEL.computer]).toBe("Computer");
  });
});
