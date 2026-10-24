import { describe, expect, it, vi } from "vitest";

import { addBot } from "./add-bot";

describe("adding a bot", () => {
  it("opens the New bot form, whichever mode is on and whether or not a Chief of Staff exists", () => {
    const dispatch = vi.fn();
    addBot(dispatch);
    expect(dispatch.mock.calls).toEqual([[{ type: "toggleNewBot", open: true }]]);
  });
});
