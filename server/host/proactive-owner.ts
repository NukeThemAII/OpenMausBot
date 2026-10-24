// The one answer to "which bot is proactive here": it owns the "Keep an eye on my day" routine, the brief and the
// suggestion to add a helper-model key. Today that is the main Chief of Staff. Every such decision goes through this
// function, so moving proactiveness to another bot (a default MausBot, say) is a change here and nowhere else.
import { sectionKey, type BotRecord, type Store } from "../store.ts";

/** The Chief of the whole workspace, or the first Chief there is. */
export function proactiveOwner(store: Pick<Store, "bots">): BotRecord | null {
  const chiefs = store.bots.filter((bot) => bot.chiefOfStaff && !bot.hidden);
  return chiefs.find((bot) => sectionKey(bot.section) === "") ?? chiefs[0] ?? null;
}
