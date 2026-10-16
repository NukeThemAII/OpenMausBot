import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-omb.ts";
import { removeTempDir } from "./testing/cleanup.ts";

it("Chief creation uses the workspace default or a validated explicit model without inheriting permissions", async () => {
  const temp = mkdtempSync(join(tmpdir(), "omb-create-model-"));
  const gate = join(temp, "finish");
  const fixture = await launchVerificationServer({ FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLOW_FINISH_GATE: gate }, undefined, undefined, undefined, undefined, undefined, ["codex"]);
  const api = async (method: string, path: string, body?: unknown, expected = 200, token?: string) => {
    const response = await fetch(fixture.info.url + path, { method,
      headers: { "content-type": "application/json", origin: fixture.info.url,
        ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json() as any;
    expect(response.status, JSON.stringify(result)).toBe(expected);
    return result;
  };
  try {
    const instances = (await api("GET", "/api/instances")).instances;
    const claude = instances.find((item: any) => item.instanceId === "claude");
    const codex = instances.find((item: any) => item.instanceId === "codex");
    const defaultModel = { instanceId: "codex", model: codex.models.default, effort: "low" };
    await api("PATCH", "/api/config", { defaultModelSelection: defaultModel });
    const chiefModel = { instanceId: "claude", model: claude.models.default };
    const chief = (await api("POST", "/api/bots", { name: "Chief", section: "Design", modelSelection: chiefModel }, 201)).bot;
    // On Ask, so each creation waits on its review card.
    await api("PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: true, approvalMode: "ask" });
    await api("POST", `/api/bots/${chief.id}/messages`, { text: "Prepare a specialist." }, 202);
    await expect.poll(() => existsSync(fixture.fixtureDumpPath), { timeout: 15_000 }).toBe(true);
    const dump = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8"));
    let token = dump.mcpConfig.mcpServers.agents.env.OMB_COMMS_TOKEN;
    const create = (name: string, modelSelection?: unknown, expected = 201) => api("POST", "/api/internal/create-bot", {
      fromBotId: chief.id, fromThreadId: chief.threadId, name,
      role: "Specialist", instructions: "Complete assigned work.",
      ...(modelSelection === undefined ? {} : { modelSelection }),
    }, expected, token);
    const idle = () => expect.poll(async () => (await api("GET", "/api/bots")).bots.every((bot: any) => !bot.busy), { timeout: 20_000 }).toBe(true);
    const apply = async (pending: any) => {
      expect(pending).toMatchObject({ state: "pending", applied: false });
      await idle();
      // the approval gate also counts turns the bots list does not show; a refused approval changes nothing, so retry it
      let answered: any;
      await expect.poll(async () => {
        const response = await fetch(fixture.info.url + `/api/threads/${chief.threadId}/respond`, { method: "POST",
          headers: { "content-type": "application/json", origin: fixture.info.url },
          body: JSON.stringify({ requestId: pending.requestId, behavior: "allow" }) });
        answered = await response.json();
        return response.status;
      }, { timeout: 20_000 }).toBe(200);
      await idle();
      return answered.result.bots[0];
    };
    const before = (await api("GET", "/api/bots")).bots.length;
    const firstCard = await create("Default specialist");
    const explicit = { instanceId: "claude", model: claude.models.options.find((item: any) => item.id !== claude.models.default).id, effort: "low" };
    const secondCard = await create("Chosen specialist", explicit);
    expect((await api("GET", "/api/bots")).bots.length).toBe(before);
    for (const invalid of [null, {}, { instanceId: "missing", model: "missing" },
      { ...explicit, model: "not-in-catalog" }, { ...explicit, effort: "invalid" },
      { ...explicit, variant: "a-variant" }]) {
      await create("Invalid specialist", invalid, 400);
    }
    await create("Third specialist");
    await create("Fourth specialist");
    await create("Fifth specialist", undefined, 429);
    writeFileSync(gate, "finish");
    await idle();
    await create("Expired authority", undefined, 401);
    const first = await apply(firstCard);
    const second = await apply(secondCard);
    expect(first.modelSelection).toEqual(defaultModel);
    expect(second.modelSelection).toEqual(explicit);
    const bots = (await api("GET", "/api/bots")).bots;
    expect(bots.length).toBe(before + 2);
    expect(bots.find((bot: any) => bot.id === chief.id).modelSelection).toEqual(chiefModel);
    for (const [id, modelSelection] of [[first.id, defaultModel], [second.id, explicit]]) {
      expect(bots.find((bot: any) => bot.id === id)).toMatchObject({
        section: "Design", modelSelection, approvalMode: "full", autoApprove: false, composio: false, approvePeerComms: false,
        soul: "Complete assigned work.",
      });
    }
    await api("PATCH", "/api/config", { defaultModelSelection: explicit });
    unlinkSync(gate);
    unlinkSync(fixture.fixtureDumpPath);
    await api("POST", `/api/bots/${chief.id}/messages`, { text: "Prepare the next specialist." }, 202);
    await expect.poll(() => existsSync(fixture.fixtureDumpPath), { timeout: 15_000 }).toBe(true);
    token = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")).mcpConfig.mcpServers.agents.env.OMB_COMMS_TOKEN;
    const updatedCard = await create("Updated default specialist");
    writeFileSync(gate, "finish");
    await idle();
    expect((await apply(updatedCard)).modelSelection).toEqual(explicit);
    expect((await api("GET", "/api/bots")).bots.find((bot: any) => bot.id === first.id).modelSelection).toEqual(defaultModel);
  } finally {
    writeFileSync(gate, "finish");
    await fixture.close();
    await removeTempDir(temp);
  }
}, 60_000);
