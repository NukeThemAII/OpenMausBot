import { EffortRow, ModelPicker } from "../ModelPicker";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";
import { useStore, type Bot } from "@/state/store";
import { useBotEditor } from "./BotEditorContext";
import { ProposalStatus } from "./ProposalStatus";
import { ThreadModelsLine } from "../ThreadModelsLine";
import { t } from "@/lib/i18n";
import { Select } from "../Select";

export function ModelSection({ bot }: { bot: Bot }) {
  const { state, dispatch } = useStore();
  const { draft } = useBotEditor();
  const modelVariants = state.instances.find((instance) => instance.instanceId === bot.modelSelection.instanceId)?.capabilities?.modelVariants;
  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-xl bg-card p-4">
        <ModelPicker
          bot={bot}
          contained
          label={
            <div>
              <div className="text-[15px] font-medium text-ink">Default model</div>
              <div className="mt-0.5 text-[13px] text-ink-secondary">
                {draft ? "Starting model for the new bot and its threads." : "For groups and every thread that uses the bot's model. A thread keeps its own model only when you pick one in it."}
              </div>
              <ProposalStatus bot={bot} kind="chief" />
            </div>
          }
        />
        {!draft && <ThreadModelsLine bot={bot} className="mt-3" />}
      </div>

      <EffortRow
        bot={bot}
        className="rounded-xl bg-card p-4"
        label={
          <div>
            <div className="text-[15px] font-medium text-ink">{modelVariants ? "Reasoning" : "Effort"}</div>
            {/* Codex applies a level to the whole thread and cannot take one back, so this says what the app sends, not where the engine ends up. */}
            <div className="mt-0.5 text-[13px] text-ink-secondary">
              {modelVariants ? (draft ? "Starting reasoning variant for the new bot." : "For groups and every thread that uses the bot's model.") : `How hard this bot thinks in groups and every thread that uses its model${bot.modelSelection.effort ? "" : " (Default: no level is sent)"}`}
            </div>
            <ProposalStatus bot={bot} kind="chief" />
          </div>
        }
      />
      {!draft && <FallbackChain bot={bot} onChange={(fallback) => dispatch({ type: "updateBot", botId: bot.id, patch: { fallback } })} />}
      {!draft && state.config?.cacheKeepWarm && (
        <KeepWarmRow bot={bot} workspaceOn={state.config.cacheKeepWarm.enabled}
          onChange={(cacheKeepWarm) => dispatch({ type: "updateBot", botId: bot.id, patch: { cacheKeepWarm } })} />
      )}
    </div>
  );
}

function KeepWarmRow({ bot, workspaceOn, onChange }: { bot: Bot; workspaceOn: boolean; onChange: (value: boolean | null) => void }) {
  const value = bot.cacheKeepWarm === true ? "on" : bot.cacheKeepWarm === false ? "off" : "follow";
  return (
    <div className="rounded-xl bg-card p-4">
      <label htmlFor="bot-cache-keepwarm" className="text-[15px] font-medium text-ink">{t("bot.keepWarm.title")}</label>
      <div className="mt-0.5 text-[13px] text-ink-secondary">{t("bot.keepWarm.help")}</div>
      <Select className="mt-3 max-w-full" id="bot-cache-keepwarm" value={value}
        onChange={(event) => onChange(event.target.value === "on" ? true : event.target.value === "off" ? false : null)}>
        <option value="follow">{t("bot.keepWarm.follow", { state: t(workspaceOn ? "bot.keepWarm.on" : "bot.keepWarm.off") })}</option>
        <option value="on">{t("bot.keepWarm.on")}</option>
        <option value="off">{t("bot.keepWarm.off")}</option>
      </Select>
    </div>
  );
}

function FallbackChain({ bot, onChange }: { bot: Bot; onChange: (fallback: Bot["fallback"]) => void }) {
  const { state } = useStore();
  const chain = bot.fallback ?? [];
  const available = state.instances.filter(
    (instance) =>
      instance.snapshot.state === "available" &&
      Boolean(instance.models.default.trim()) &&
      instance.instanceId !== bot.modelSelection.instanceId &&
      !chain.some((entry) => entry.instanceId === instance.instanceId),
  );
  const nameOf = (instanceId: string) => state.instances.find((instance) => instance.instanceId === instanceId)?.displayName ?? instanceId;

  const add = (instanceId: string) => {
    const instance = state.instances.find((candidate) => candidate.instanceId === instanceId);
    if (!instance || !instance.models.default.trim() || chain.length >= 5 || !available.includes(instance)) return;
    onChange([...chain, { instanceId, model: instance.models.default }]);
  };

  return (
    <div className="rounded-xl bg-card p-4">
      <div className="text-[15px] font-medium text-ink">Backup models for this bot</div>
      <div className="mt-0.5 text-[13px] text-ink-secondary">
        When Automatic recovery is enabled in App Settings, try these models in order only if the provider
        proves the request never started. Work that may have run is not replayed. Only that thread switches;
        bot defaults and other threads stay unchanged. Backup provider charges may apply.
      </div>
      {!state.config?.automaticRecovery?.enabled && <p className="mt-2 text-[12px] text-ink-secondary">Automatic recovery is off. This list stays inactive until you enable it in App Settings.</p>}
      {chain.length > 0 && (
        <ol className="mt-3 flex flex-col gap-1">
          {chain.map((entry, index) => (
            <li key={entry.instanceId} className="flex items-center gap-2 rounded-lg bg-inset px-3 py-1.5 text-[13px]">
              <span className="w-4 shrink-0 tabular-nums text-ink-secondary">{index + 1}.</span>
              <span className="min-w-0 flex-1 truncate text-ink">{nameOf(entry.instanceId)}</span>
              <span className="shrink-0 truncate text-[11.5px] text-ink-secondary">{entry.model}</span>
              <button
                type="button"
                onClick={() => onChange(chain.filter((candidate) => candidate.instanceId !== entry.instanceId))}
                aria-label={`Remove ${nameOf(entry.instanceId)} from the fallback list`}
                className="shrink-0 rounded p-0.5 text-ink-secondary hover:text-ink"
              >
                <X size={13} />
              </button>
            </li>
          ))}
        </ol>
      )}
      {chain.length < 5 && (
        <div className={cn("flex items-center gap-2", chain.length > 0 ? "mt-2" : "mt-3")}>
          <Select size="sm"
            value=""
            onChange={(event) => add(event.target.value)}
            aria-label="Add a fallback engine"
            disabled={available.length === 0}
          >
            <option value="">{available.length === 0 ? "No other engine is available" : "Add an engine…"}</option>
            {available.map((instance) => (
              <option key={instance.instanceId} value={instance.instanceId}>
                {instance.displayName}
              </option>
            ))}
          </Select>
        </div>
      )}
    </div>
  );
}
