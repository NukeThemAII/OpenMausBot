import { useEffect, useRef, useState } from "react";
import type { CloudMoveBridge, CloudMoveOverview, CloudMoveState } from "../../electron/cloud-move.mjs";
import type { LocaleKey } from "@/locales";
import { cloudFilesBridge } from "@/lib/cloud-files";
import { activeLocale, t } from "@/lib/i18n";
import { OpenFilesButton } from "./OpenFilesButton";
import { Card } from "./SettingsPrimitives";

const RUNNING = new Set<CloudMoveState["phase"]>(["preparing", "growing", "exporting", "uploading", "checking", "replacing", "restarting"]);
const CANCELLABLE = new Set<CloudMoveState["phase"]>(["preparing", "growing", "exporting", "uploading", "checking"]);
const PHASE: Record<string, LocaleKey> = {
  preparing: "cloudMove.phase.preparing", growing: "cloudMove.phase.growing", exporting: "cloudMove.phase.exporting", uploading: "cloudMove.phase.uploading",
  checking: "cloudMove.phase.checking", replacing: "cloudMove.phase.replacing", restarting: "cloudMove.phase.restarting",
};
const ERROR: Record<string, LocaleKey> = {
  busy: "cloudMove.error.busy", cloud_busy: "cloudMove.error.cloudBusy", too_large: "cloudMove.error.tooLarge",
  local_full: "cloudMove.error.localFull", upload_failed: "cloudMove.error.network", network: "cloudMove.error.network",
  access_changed: "cloudMove.error.accessChanged", cloud_unavailable: "cloudMove.error.cloudUnavailable",
  cancelled: "cloudMove.error.cancelled", no_previous: "cloudMove.error.noPrevious",
  owner_needed: "cloudMove.error.ownerNeeded", shared_workspace: "cloudMove.error.sharedWorkspace", same_computer: "cloudMove.error.sameComputer",
  not_empty: "cloudMove.error.notEmpty", unreachable: "cloudMove.error.unreachable", busy_elsewhere: "cloudMove.error.busyElsewhere",
};
const NO_RETRY = new Set(["shared_workspace", "same_computer", "not_empty", "cloud_grow_unsupported", "too_large", "busy_elsewhere"]);
const OPEN = new Set(["restart_timeout", "owner_needed", "access_changed"]);
const CHECK = new Set(["outdated", "unreachable"]);

export const formatMoveBytes = (value: number) => {
  const power = value >= 1024 ** 3 ? 3 : value >= 1024 ** 2 ? 2 : 1;
  return `${new Intl.NumberFormat(activeLocale(), { maximumFractionDigits: power === 3 ? 1 : 0 }).format(value / 1024 ** power)} ${["", "KB", "MB", "GB"][power]}`;
};

const savedAt = (iso: string) => new Intl.DateTimeFormat(activeLocale(), { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));

type Destination = NonNullable<CloudMoveState["destination"]>;
export type MoveActionKind = "start" | "cancel" | "open" | "check" | "dismiss";
export interface MoveView {
  server: string;
  running: boolean;
  message: { text: string; tone: "status" | "done" | "error" | "note" } | null;
  next: string[];
  action: { kind: MoveActionKind; label: string } | null;
  resumable: boolean;
}

function errorText(error: NonNullable<CloudMoveState["error"]>, server: string, cloud: boolean): string {
  const needed = error.neededBytes;
  if (error.code === "cloud_full") {
    if (error.maxBytes !== undefined && needed !== undefined && needed > error.maxBytes) {
      return t(error.largest ? "cloudMove.error.planFullLargest" : "cloudMove.error.planFull", { needed: formatMoveBytes(needed), max: formatMoveBytes(error.maxBytes) });
    }
    if (cloud && error.maxBytes === undefined && error.volumeBytes !== undefined && needed !== undefined && needed > error.volumeBytes) {
      return t("cloudMove.error.growUnsupported", { needed: formatMoveBytes(needed) });
    }
    return error.freeBytes !== undefined && needed !== undefined
      ? t("cloudMove.error.cloudFull", { server, free: formatMoveBytes(error.freeBytes), needed: formatMoveBytes(needed) })
      : t("cloudMove.error.cloudFullPlain", { server });
  }
  if (error.code === "cloud_grow_unsupported") {
    return needed !== undefined ? t("cloudMove.error.growUnsupported", { needed: formatMoveBytes(needed) }) : t("cloudMove.error.growUnsupportedPlain");
  }
  if (error.code === "cloud_grow_unavailable") {
    return error.maxBytes !== undefined ? t("cloudMove.error.growUnavailable", { max: formatMoveBytes(error.maxBytes) }) : t("cloudMove.error.cloudFullPlain", { server });
  }
  if (error.code === "restore_failed") return t("cloudMove.error.notReplaced", { server, detail: error.message });
  if (error.code === "outdated") {
    if (cloud) return t("cloudMove.error.cloudOutdated");
    return error.destVersion && error.localVersion ? t("cloudMove.error.serverOutdated", { server, dest: error.destVersion, local: error.localVersion })
      : t("cloudMove.error.serverOutdatedPlain", { server });
  }
  if (error.code === "restart_timeout") return t(cloud ? "cloudMove.error.restartTimeout" : "cloudMove.error.restartTimeoutServer", { server });
  if (error.code === "proxy_limit") return t("cloudMove.error.proxyLimit", { server, size: formatMoveBytes(error.partBytes ?? 512 * 1024) });
  const key = ERROR[error.code];
  return key ? t(key, { server, other: error.other || t("cloudMove.thisServer") }) : t("cloudMove.error.other", { detail: error.message });
}
function actionFor(code: string, failed: boolean, server: string, resumable = false): MoveView["action"] {
  if (OPEN.has(code)) return { kind: "open", label: t("cloudMove.open", { server }) };
  if (NO_RETRY.has(code)) return null;
  if (CHECK.has(code)) return { kind: "check", label: t("cloudMove.check") };
  return failed ? { kind: "start", label: resumable ? t("cloudMove.resume") : t("cloudMove.retry") } : null;
}

function fitNote(overview: CloudMoveOverview | null, server: string, cloud: boolean): string | null {
  const fit = overview?.fit;
  if (fit?.fit !== "never") return null;
  return errorText({ code: "cloud_full", message: "", freeBytes: fit.freeBytes, neededBytes: fit.neededBytes,
    ...(fit.maxBytes ? { maxBytes: fit.maxBytes } : {}), ...(fit.largest ? { largest: true as const } : {}), ...(fit.volumeBytes ? { volumeBytes: fit.volumeBytes } : {}) }, server, cloud);
}

function leftBehindStep(state: CloudMoveState, server: string): string[] {
  const left = state.leftBehind, path = left?.paths[0];
  if (!left || !path) return [];
  const line = t(left.bots === 1 ? "cloudMove.leftBehindFolderOne" : left.bots ? "cloudMove.leftBehindFolders" : "cloudMove.leftBehindFiles", { count: left.bots, path, server });
  return [state.destination?.kind === "cloud" ? `${line} ${t("cloudMove.leftBehindLend")}` : line];
}

/** What a finished move to My Cloud left on this computer, for Files to offer sharing; null for none, or without Files. */
export function leftBehindToShare(state: CloudMoveState): string[] | null {
  const paths = state.leftBehind?.paths ?? [];
  return state.phase === "done" && state.action !== "restore" && state.destination?.kind === "cloud" && paths.length > 0 && cloudFilesBridge() ? paths : null;
}

export function moveNextSteps(state: CloudMoveState): string[] {
  if (state.phase !== "done" || state.action === "restore") return [];
  const server = state.destination?.name || t("cloudMove.thisServer");
  return [...(state.routines ? [t("cloudMove.doneRoutines", { count: state.routines, server })] : []), ...leftBehindStep(state, server), t("cloudMove.donePhone", { server })];
}

export function moveView(overview: CloudMoveOverview | null, state: CloudMoveState, { onServerPage = false }: { onServerPage?: boolean } = {}): MoveView {
  const destination: Destination | null | undefined = overview?.destination ?? state.destination;
  const server = destination?.name || t("cloudMove.thisServer"), cloud = destination?.kind === "cloud";
  const view = (message: MoveView["message"], action: MoveView["action"], extra: Partial<MoveView> = {}): MoveView =>
    ({ server, running: false, message, next: [], action, resumable: false, ...extra });
  if (RUNNING.has(state.phase)) {
    const phase = state.action === "restore" && state.phase === "replacing" ? "cloudMove.phase.restoring" : PHASE[state.phase];
    return view(phase ? { text: t(phase, { server }), tone: "status" } : null,
      CANCELLABLE.has(state.phase) ? { kind: "cancel", label: t("cloudMove.cancel") } : null, { running: true });
  }
  if (state.phase === "done") {
    const text = state.action === "restore" ? t("cloudMove.restored", { server }) : t("cloudMove.done", { server, bots: state.moved?.bots ?? 0, chats: state.moved?.chats ?? 0 });
    return view({ text, tone: "done" }, { kind: "dismiss", label: t("cloudMove.ok") }, { next: moveNextSteps(state) });
  }
  if (state.phase === "failed" && state.error) {
    const resumable = state.resumable === true;
    return view({ text: errorText(state.error, server, cloud), tone: "error" }, actionFor(state.error.code, true, server, resumable), { resumable });
  }
  const blocked = overview?.blocked;
  if (blocked) {
    const reason = { code: blocked, message: "", destVersion: overview?.cloud?.appVersion ?? undefined, localVersion: overview?.local?.appVersion ?? undefined, other: overview?.busyWith };
    return view({ text: errorText(reason, server, cloud), tone: "note" }, actionFor(blocked, false, server));
  }
  const note = fitNote(overview, server, cloud);
  if (note) return view({ text: note, tone: "note" }, null);
  const has = overview?.cloud && !overview.cloud.empty, previous = overview?.cloud?.previous;
  if (onServerPage && has && cloud) return view({ text: t("cloudMove.error.notEmpty", { server }), tone: "note" }, null);
  const label = onServerPage ? t("cloudMove.suggest.move") : previous ? t("cloudMove.replaceAgain", { server, date: savedAt(previous.createdAt) })
    : has ? t("cloudMove.replace", { server }) : t("cloudMove.start", { server });
  return view(null, { kind: "start", label });
}

export function useCloudMove(bridge: CloudMoveBridge | undefined, destination?: string) {
  const [overview, setOverview] = useState<CloudMoveOverview | null>(null);
  const [live, setLive] = useState<CloudMoveState | null>(null);
  const [pending, setPending] = useState(false);
  const generation = useRef(0);
  const known = useRef<string | null>(null);
  const load = () => {
    const current = generation.current;
    void bridge?.state(destination).then(next => {
      if (generation.current !== current) return;
      known.current = next.destination?.origin ?? null;
      setOverview(next);
    }).catch(() => {});
  };
  useEffect(() => {
    if (!bridge) return;
    const current = ++generation.current;
    const unsubscribe = bridge.onState(next => {
      if (generation.current !== current) return;
      const finished = next.phase === "done" || next.phase === "failed";
      if (next.destination && next.destination.origin !== known.current) {
        if (finished) load();
        return;
      }
      setLive(next);
      if (finished) load();
    });
    load();
    return () => { generation.current++; unsubscribe(); };
  }, [bridge, destination]);
  const act = (action: () => Promise<unknown>) => {
    if (pending) return;
    setPending(true);
    void action().catch(() => load()).finally(() => setPending(false));
  };
  const state: CloudMoveState = live ?? overview ?? { phase: "idle" };
  const run = (kind: MoveActionKind) => {
    if (!bridge) return;
    if (kind === "start") act(() => bridge.start(destination));
    else if (kind === "cancel") act(() => bridge.cancel());
    else if (kind === "dismiss") act(() => bridge.dismiss(destination).then(next => { setLive(null); setOverview(next); }));
    else if (kind === "check") load();
    else {
      const id = overview?.destination?.id;
      if (destination && id) act(() => window.ogb?.environments?.switch(id) ?? Promise.resolve());
      else window.location.reload();
    }
  };
  return { overview, state, pending, act, load, run, destination };
}

export type CloudMoveHandle = ReturnType<typeof useCloudMove>;

function MoveProgress({ state }: { state: CloudMoveState }) {
  const progress = state.progress;
  if (!progress || progress.totalBytes <= 0 || (state.phase !== "uploading" && state.phase !== "exporting")) return null;
  return <>
    <progress className="w-full accent-accent" max={progress.totalBytes} value={Math.min(progress.bytesTransferred, progress.totalBytes)} aria-label={t("cloudMove.progress")} />
    <span className="text-[13px] text-ink-secondary">{t("cloudMove.transferred", { done: formatMoveBytes(progress.bytesTransferred), total: formatMoveBytes(progress.totalBytes) })}</span>
  </>;
}

function moveStatus(view: MoveView, state: CloudMoveState) {
  const message = view.message, share = leftBehindToShare(state);
  return <>
    {message && <p role={message.tone === "error" ? "alert" : message.tone === "note" ? "note" : "status"}
      className={message.tone === "error" ? "text-[13px] text-danger" : message.tone === "status" ? "text-[13px] text-ink-secondary" : "text-[13px] text-ink"}>{message.text}</p>}
    {view.running && <MoveProgress state={state} />}
    {view.next.map(line => <p key={line} className="text-[12px] text-ink-secondary">{line}</p>)}
    {share && <OpenFilesButton label={t("cloudMove.shareLeftBehind")} suggest={share} />}
    {view.resumable && <p className="text-[12px] text-ink-secondary">{t("cloudMove.resumeNote", { server: view.server })}</p>}
  </>;
}

function moveButton(view: MoveView, move: CloudMoveHandle, onStart?: () => void) {
  const action = view.action;
  if (!action) return null;
  return <button type="button" disabled={move.pending && action.kind !== "cancel"} className="ui-button"
    onClick={() => { if (action.kind === "start") onStart?.(); move.run(action.kind); }}>{action.label}</button>;
}

export function CloudMoveSettings({ destination, onClose }: { destination: string; onClose?: () => void }) {
  const bridge = window.ogb?.remoteClient?.active ? undefined : window.ogb?.cloudMove;
  const move = useCloudMove(bridge, destination);
  if (!bridge) return null;
  const { overview, state, pending } = move;
  const view = moveView(overview, state);
  const local = overview?.local, cloud = overview?.cloud, previous = cloud?.previous;
  const idle = !view.running && state.phase !== "done";
  const date = previous ? savedAt(previous.createdAt) : "";
  const ready = idle && !overview?.blocked;
  return <Card title={t("cloudMove.title")} subtitle={t("cloudMove.intro", { server: view.server })}>
    <div data-cloud-move={state.phase} className="flex flex-col items-start gap-3">
      <p className="text-[13px] text-ink">{local
        ? t("cloudMove.size", { size: formatMoveBytes(local.bytes), bots: local.bots, chats: local.chats, rooms: local.rooms })
        : t("cloudMove.measuring")}</p>
      <p className="text-[12px] text-ink-secondary">{t("cloudMove.signIn", { server: view.server })}</p>
      {ready && cloud && (previous || !cloud.empty) && <p role="note" className="text-[13px] text-ink">{previous
        ? t("cloudMove.replaceWarningPrevious", { server: view.server, bots: cloud.contents.bots, chats: cloud.contents.chats, date })
        : t("cloudMove.replaceWarning", { server: view.server, bots: cloud.contents.bots, chats: cloud.contents.chats })}</p>}
      {ready && !cloud && <p className="text-[12px] text-ink-secondary">{t("cloudMove.replaceMaybe", { server: view.server })}</p>}
      {moveStatus(view, state)}
      <div className="flex flex-wrap gap-2">
        {moveButton(view, move)}
        {ready && previous && <button type="button" disabled={pending} className="ui-button" onClick={() => move.act(() => bridge.restorePrevious(destination))}>{t("cloudMove.restorePrevious", { server: view.server })}</button>}
        {onClose && !view.running && <button type="button" className="ui-button" onClick={onClose}>{t("cloudMove.close")}</button>}
      </div>
      {ready && previous && <p className="text-[12px] text-ink-secondary">{t("cloudMove.previous", { server: view.server, date, bots: previous.bots, chats: previous.chats, size: formatMoveBytes(previous.bytes ?? 0) })}</p>}
    </div>
  </Card>;
}

export function cloudMoveOffer(move: CloudMoveHandle, on: { start?: () => void; notNow?: () => void } = {}) {
  const { overview, state, pending } = move;
  const view = moveView(overview, state, { onServerPage: true });
  const local = overview?.local;
  const offering = !view.running && state.phase === "idle" && !view.message;
  return <div className="flex flex-col items-start gap-1.5">
    {offering && <p className="text-[13px] text-ink-secondary">{local && overview?.cloud?.empty
      ? t("cloudMove.suggest.body", { server: view.server, bots: local.bots, chats: local.chats, size: formatMoveBytes(local.bytes) })
      : t("cloudMove.intro", { server: view.server })}</p>}
    {offering && <p className="text-[12px] text-ink-secondary">{t("cloudMove.signIn", { server: view.server })}</p>}
    {moveStatus(view, state)}
    <div className="mt-1.5 flex flex-wrap gap-2">
      {moveButton(view, move, on.start)}
      {on.notNow && offering && <button type="button" disabled={pending} className="ui-button" onClick={() => { on.notNow!(); move.run("dismiss"); }}>{t("cloudMove.suggest.notNow")}</button>}
    </div>
  </div>;
}

export function CloudMoveSuggestion() {
  const bridge = window.ogb?.cloudMove;
  const move = useCloudMove(bridge);
  const [started, setStarted] = useState(false), [hidden, setHidden] = useState(false);
  const finished = move.overview?.destination && move.state.phase === "done";
  if (!bridge || hidden || !(move.overview?.suggest || started || finished)) return null;
  const title = window.ogb?.platform === "darwin" ? t("cloudMove.suggest.titleMac") : t("cloudMove.suggest.title");
  return <aside aria-label={title} data-cloud-move-suggestion={move.state.phase} className="fixed bottom-4 right-4 z-40 w-[22rem] max-w-[calc(100vw-2rem)] rounded-xl border border-hairline/40 bg-card p-4 shadow-lg">
    <p className="mb-1 text-[14px] font-medium text-ink">{title}</p>
    {cloudMoveOffer(move, { start: () => setStarted(true), notNow: () => setHidden(true) })}
  </aside>;
}

export function CloudMoveImport() {
  const bridge = window.ogb?.remoteClient?.active ? undefined : window.ogb?.cloudMove;
  const move = useCloudMove(bridge);
  const blocked = move.overview?.blocked;
  if (!bridge || !move.overview?.destination || blocked === "shared_workspace" || blocked === "same_computer") return null;
  return <Card title={t("backup.fromComputer")} subtitle={t("backup.fromComputerHint")}>
    <div data-cloud-move-import={move.state.phase}>{cloudMoveOffer(move)}</div>
  </Card>;
}
