import { describe, expect, it } from "vitest";

import { chiefOfStaffSystemPrompt } from "./chief-of-staff.ts";
import { escalationDeliverable } from "./escalations.ts";
import { chiefForBot } from "./incidents.ts";
import { canReachPeer, inScope, reachablePeers } from "./peer-roster.ts";

const ADA = "ada@acme.test", BOB = "bob@acme.test";
// Acme: Fox and Owl work on Product A for Bob; Tech Lead works on Product A too but reports to Ada.
const team = [
  { id: "ada-chief", name: "Ada's Chief", chiefOfStaff: true, createdBy: ADA },
  { id: "bob-chief", name: "Bob's Chief", chiefOfStaff: true, createdBy: ADA, reportsTo: BOB },
  { id: "fox", name: "Fox", section: "Product A", createdBy: ADA, reportsTo: BOB },
  { id: "owl", name: "Owl", section: "Product A", createdBy: BOB },
  { id: "lead", name: "Tech Lead", section: "Product A", createdBy: BOB, reportsTo: ADA },
  { id: "seo", name: "SEO", section: "SEO/SEA", createdBy: ADA },
];
const bot = (id: string) => team.find((one) => one.id === id)!;
const ids = (bots: ReadonlyArray<{ id: string }>) => bots.map((one) => one.id).sort();

describe("one Chief per person on a Team Cloud", () => {
  it("coordinates exactly the bots its person owns, in every department", () => {
    expect(ids(reachablePeers(team, bot("ada-chief")))).toEqual(["lead", "seo"]);
    expect(ids(reachablePeers(team, bot("bob-chief")))).toEqual(["fox", "owl"]);
  });

  it("is reached by its own person's bots only; others keep their department", () => {
    expect(canReachPeer(bot("lead"), bot("ada-chief"))).toBe(true);
    expect(canReachPeer(bot("lead"), bot("bob-chief"))).toBe(false);
    expect(canReachPeer(bot("fox"), bot("bob-chief"))).toBe(true);
    expect(ids(reachablePeers(team, bot("fox")))).toEqual(["bob-chief", "lead", "owl"]);
    expect(inScope(bot("seo"), bot("fox"))).toBe(false);
  });

  it("gets its own person's incidents and escalations, never another person's", () => {
    expect(chiefForBot(team, bot("fox"))?.id).toBe("bob-chief");
    expect(chiefForBot(team, bot("lead"))?.id).toBe("ada-chief");
    expect(escalationDeliverable(bot("ada-chief"), bot("fox"))).toBe(false);
    expect(escalationDeliverable(bot("ada-chief"), bot("lead"))).toBe(true);
    // A person with no Chief: their bot's notices go to them, not to someone else's Chief.
    expect(chiefForBot(team, { id: "x", name: "X", section: "Product A", createdBy: "cleo@acme.test" })).toBeNull();
  });

  it("is told whose Chief it is and lists only that person's bots", () => {
    const prompt = chiefOfStaffSystemPrompt("bob-chief", team, true);
    expect(prompt).toContain("You are Bob's assistant and Chief of Staff");
    expect(prompt).toContain("Bots that report to Bob:");
    expect(prompt).toContain("Fox");
    expect(prompt).not.toContain("Tech Lead");
  });

  it("leaves a team nobody owns bots in, and every other server, on departments", () => {
    const plain = team.map(({ createdBy: _createdBy, reportsTo: _reportsTo, ...rest }) => rest);
    expect(canReachPeer(plain[0]!, plain[2]!)).toBe(false);
    expect(ids(reachablePeers(plain, plain.find((one) => one.id === "fox")!))).toEqual(["lead", "owl"]);
    expect(chiefOfStaffSystemPrompt("ada-chief", plain, true)).toContain("Chief of Staff for the General department");
  });
});
