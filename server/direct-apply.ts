// Which proposed changes apply without a person: under Full access everything; at any other level a bot's change to itself
// (its routines, skills, profile, model) applies with an Undo receipt, and a change for another bot keeps its card. A Cloud
// home's guest-driven turn keeps the card for everything; team setup and peer approvals stay Full access only.

/** Why a change applied without a person. Also the decision log's source. */
export type DirectApply = "full-access" | "self";

/** Server-owned and decided per request, never from request input. */
export type DirectApplyCheck = (botId: string, threadId: string, targetBotId: string) => DirectApply | null;

/** What Undo says, applying nothing, once the thing changed since. */
export const UNDO_STALE = "Changed since, so it can't be undone here.";

/** A bot applying its own routines directly keeps at most this many
 * enabled; past it, a create or resume shows today's card instead. */
export const SELF_ROUTINE_CAP = 20;

export function directApply(args: {
  fullAccess: boolean;
  botId: string;
  targetBotId: string;
  blocked: boolean;
}): DirectApply | null {
  if (args.fullAccess) return "full-access";
  return args.targetBotId === args.botId && !args.blocked ? "self" : null;
}
