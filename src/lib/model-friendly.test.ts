import { describe, expect, it } from "vitest";
import { modelBlurb } from "./model-friendly";

describe("model blurbs", () => {
  it("describes the well-known Claude families", () => {
    expect(modelBlurb({ id: "claude-opus-5-5", label: "Opus 5.5" })).toMatch(/Smartest/);
    expect(modelBlurb({ id: "claude-sonnet-5-5", label: "Sonnet 5.5" })).toMatch(/most work/);
    expect(modelBlurb({ id: "claude-haiku-4-5-20251001", label: "Haiku 4.5" })).toMatch(/Quickest/);
  });

  it("calls small variants light without guessing at unknown models", () => {
    expect(modelBlurb({ id: "gpt-5-mini", label: "GPT-5 mini" })).toMatch(/light/);
    expect(modelBlurb({ id: "minimax-m2", label: "MiniMax M2" })).toBeUndefined();
    expect(modelBlurb({ id: "grok-4", label: "Grok 4" })).toBeUndefined();
  });
});
