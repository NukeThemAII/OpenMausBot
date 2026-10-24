import { describe, expect, it } from "vitest";
import { LENT_BROWSER_NO_ENDPOINT, LENT_SCREEN_BROWSING, lentScreenResult } from "./lent-screen-guidance.ts";
import { omittedFromErrorNote } from "./mcp-error-result.ts";

const call = (tool_name: string) => ({ action: "computer_call", tool_name });
const failed = (text: string) => ({ content: [{ type: "text", text }], isError: true });
const texts = (result: unknown) => (result as { content: { text: string }[] }).content.map((part) => part.text);

describe("a lent screen's answers carry the fix", () => {
  it("lists the screen tools with how to browse there", () => {
    const listing = { content: [{ type: "text", text: "{\"tools\":[]}" }] };
    expect(texts(lentScreenResult({ action: "computer_tools" }, listing))).toEqual(["{\"tools\":[]}", LENT_SCREEN_BROWSING]);
  });

  it("turns a browser that needs DevTools setup into the screen route, whatever shape the driver used", () => {
    const structured = { content: [{ type: "text", text: "no endpoint" }], structuredContent: { code: "browser_requires_setup" }, isError: true };
    expect(texts(lentScreenResult(call("get_browser_state"), structured)).at(-1)).toBe(LENT_BROWSER_NO_ENDPOINT);
    expect(texts(lentScreenResult(call("browser_navigate"), failed("browser_route_unavailable: run browser_prepare explicitly to set one up"))).at(-1)).toBe(LENT_BROWSER_NO_ENDPOINT);
    expect(texts(lentScreenResult(call("browser_prepare"), failed("browser_prepare is not part of lent apps and screen"))).at(-1)).toBe(LENT_BROWSER_NO_ENDPOINT);
  });

  it("leaves working browser and screen answers alone", () => {
    const ok = { content: [{ type: "text", text: "clicked" }] };
    expect(lentScreenResult(call("browser_click"), ok)).toBe(ok);
    expect(lentScreenResult(call("click"), failed("browser_requires_setup"))).toEqual(failed("browser_requires_setup"));
    expect(lentScreenResult({ action: "read_file" }, failed("spawn cua-driver ENOENT"))).toEqual(failed("spawn cua-driver ENOENT"));
  });

  it("replaces an older desktop's raw failure with the fix, and never passes its path on", () => {
    const quarantined = lentScreenResult(call("get_desktop_state"), failed("spawn C:\\Users\\Ana\\AppData\\Local\\Programs\\OpenMausBot\\resources\\cua-driver.exe ENOENT"));
    expect(texts(quarantined)).toHaveLength(1);
    expect(texts(quarantined)[0]).toMatch(/^Computer control could not start on this computer: its helper, cua-driver, is missing or blocked\. .*Protection history/);
    expect(JSON.stringify(quarantined)).not.toContain("Ana");
    expect(texts(lentScreenResult(call("click"), failed("Computer-control transport closed")))[0]).toMatch(/^Computer control stopped on this computer: .*Try the action once more/);
    expect(texts(lentScreenResult(call("click"), failed("Computer control is unavailable. Enable it in the local app and grant OS permissions first.")))[0]).toMatch(/^Computer control is not running on this computer\./);
    expect(texts(lentScreenResult(call("click"), failed("fetch failed")))[0]).toMatch(/restart OpenMausBot on that computer/);
  });
  it("passes a lent screen's error on as text only, and its successful screenshots unchanged", () => {
    const image = { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" };
    const refused = { content: [{ type: "text", text: "refused" }, image], isError: true };
    expect(lentScreenResult(call("click"), refused)).toEqual({ content: [{ type: "text", text: "refused" }, { type: "text", text: omittedFromErrorNote(1) }], isError: true });
    const shot = { content: [image] };
    expect(lentScreenResult(call("get_desktop_state"), shot)).toBe(shot);
  });
});
