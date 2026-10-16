import type { Bot } from "@/state/store";
import { SoulField } from "../SoulField";
import { ProposalStatus } from "./ProposalStatus";
import { ReplyStyleField } from "./ReplyStyleField";
import type { BotPatch } from "./useBotSettingsDerived";

export function SoulSection({ bot, patch }: { bot: Bot; patch: (patch: BotPatch) => void }) {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-[13px] leading-relaxed text-ink-secondary">
        Who this bot is and the rules it never breaks. Always in its context.
      </p>
      <ProposalStatus bot={bot} kind="chief" />
      <SoulField bot={bot} onPatch={patch} />
      <ReplyStyleField bot={bot} patch={patch} />
    </div>
  );
}
