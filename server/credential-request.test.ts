import { describe, expect, it } from "vitest";

import {
  CREDENTIAL_TARGETS,
  credentialConfigPatch,
  credentialIsConfigured,
  credentialResumeOutcome,
  credentialSaveRequest,
  isPendingCredentialRequest,
  isCredentialTargetId,
  type ConfigCredentialTargetId,
  type CredentialConfig,
} from "../shared/credential-request.ts";

const MAPPINGS: Array<[ConfigCredentialTargetId, CredentialConfig]> = [
  ["xaiApiKey", { xai: { key: "secret" } }],
  ["boxToken", { box: { token: "secret" } }],
  ["opencodeGoApiKey", { opencodeGo: { apiKey: "secret" } }],
  ["ttsKey", { tts: { key: "secret" } }],
  ["fishAudioKey", { tts: { fishKey: "secret" } }],
  ["openaiImageApiKey", { imageGen: { key: "secret" } }],
];

describe("credential request allowlist", () => {
  it("accepts only declared own ids", () => {
    expect(isCredentialTargetId("xaiApiKey")).toBe(true);
    expect(isCredentialTargetId("composioApiKey")).toBe(false);
    expect(isCredentialTargetId("__proto__")).toBe(false);
    expect(isCredentialTargetId({ toString: () => "xaiApiKey" })).toBe(false);
  });

  it("maps each id to a fixed config location", () => {
    expect([...MAPPINGS.map(([id]) => id), "onePasswordToken"].sort()).toEqual(Object.keys(CREDENTIAL_TARGETS).sort());
    for (const [id, patch] of MAPPINGS) {
      expect(credentialConfigPatch(id, "secret")).toEqual(patch);
      expect(credentialSaveRequest(id, "secret")).toEqual({ path: "/api/config", method: "PUT", body: patch });
      expect(credentialIsConfigured(patch, id)).toBe(true);
      expect(credentialIsConfigured({}, id)).toBe(false);
    }
  });

  // The token goes to Logins, which checks it with 1Password before keeping it; it never lands in the settings file.
  it("saves a 1Password token through Logins and counts it once Logins holds it", () => {
    expect(credentialSaveRequest("onePasswordToken", "ops_fake")).toEqual({ path: "/api/logins/1password", method: "POST", body: { token: "ops_fake" } });
    expect(credentialIsConfigured({ onePassword: { connected: true } }, "onePasswordToken")).toBe(true);
    expect(credentialIsConfigured({}, "onePasswordToken")).toBe(false);
    expect(CREDENTIAL_TARGETS.onePasswordToken).toMatchObject({ placeholder: "ops_…", helpUrl: "https://developer.1password.com/docs/service-accounts/get-started/" });
  });

  it("checks configured state without exposing values", () => {
    expect(credentialIsConfigured({ tts: { key: "secret" } }, "ttsKey")).toBe(true);
    expect(credentialIsConfigured({ tts: { key: "" } }, "ttsKey")).toBe(false);
    expect(credentialIsConfigured({ tts: { fishKey: "secret" } }, "fishAudioKey")).toBe(true);
    expect(credentialIsConfigured({ tts: { fishKey: "" } }, "fishAudioKey")).toBe(false);
    expect(Object.keys(CREDENTIAL_TARGETS)).toHaveLength(7);
  });

  // The key becomes OPENCODE_API_KEY, which only OpenCode Zen and Go read: the
  // card must not promise other providers a key it never reaches.
  it("says the OpenCode key is for Zen and Go only", () => {
    expect(CREDENTIAL_TARGETS.opencodeGoApiKey.description).toBe("Used for OpenCode Zen and Go.");
  });

  it("supersedes open room cards only for the bot that requested them", () => {
    const card = {
      kind: "secret",
      secret: { target: "xaiApiKey" },
      from: { botId: "atlas" },
    };
    expect(isPendingCredentialRequest(card, "xaiApiKey", "atlas", true)).toBe(true);
    expect(isPendingCredentialRequest(card, "xaiApiKey", "pixel", true)).toBe(false);
    expect(isPendingCredentialRequest(card, "xaiApiKey", "pixel", false)).toBe(true);
    expect(isPendingCredentialRequest({ ...card, secret: { ...card.secret, provided: true } }, "xaiApiKey", "atlas", true)).toBe(false);
    expect(isPendingCredentialRequest({ ...card, secret: { ...card.secret, dismissed: true } }, "xaiApiKey", "atlas", true)).toBe(false);
    expect(isPendingCredentialRequest({ ...card, secret: { ...card.secret, superseded: true } }, "xaiApiKey", "atlas", true)).toBe(false);
  });

  it("preserves the original save or decline outcome when retrying", () => {
    expect(credentialResumeOutcome({ provided: true })).toBe("provided");
    expect(credentialResumeOutcome({ dismissed: true })).toBe("dismissed");
    expect(credentialResumeOutcome({})).toBeNull();
    expect(credentialResumeOutcome({ provided: true, dismissed: true })).toBeNull();
  });
});
