import { describe, expect, it } from "vitest";
import type { Bot, Group, Message } from "@/state/store";
import { botPreview, groupPreview, lastPreviewable } from "./sidebar-preview";

let at = 0;
const message = (fields: Partial<Message>): Message => ({ id: `m${++at}`, at, role: "bot", kind: "text", ...fields }) as Message;
const screen = () => message({ kind: "screen", png: "frame", mime: "image/jpeg" });
const bot = { id: "ada", name: "Ada", messages: [], busy: false } as unknown as Bot;

describe("sidebar previews", () => {
  it("shows a bot's reply, not the screen frame its computer turn ended with", () => {
    const visible = [message({ role: "user", text: "Paint a sunset" }), message({ text: "I painted a sunset in JS Paint." }), screen()];
    expect(botPreview(bot, visible, [], false)).toBe("I painted a sunset in JS Paint.");
    expect(botPreview(bot, [...visible, message({ kind: "digest", text: "[digest]" }), screen()], [], false)).toBe("I painted a sunset in JS Paint.");
  });

  it("shows nothing for a conversation that holds only screen frames", () => {
    expect(botPreview(bot, [screen(), screen()], [], false)).toBe("");
    expect(lastPreviewable([screen(), message({ kind: "compaction" })])).toBeUndefined();
  });

  it("skips screen frames in a group chat's preview too", () => {
    const group = { id: "g", name: "Room", messages: [message({ text: "Done.", from: { botId: "ada", name: "Ada", color: "green" } }), screen()] } as unknown as Group;
    expect(groupPreview(group, [bot], [], false)).toBe("Ada: Done.");
  });
});
