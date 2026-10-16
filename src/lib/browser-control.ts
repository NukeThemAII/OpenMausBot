import type { createBrowserInputQueue } from "./browser-input-queue";

type Body = Record<string, unknown>;
export type BrowserInteraction = { input: Body } | { command: Body };
export type BrowserTakeStatus = "" | "pending" | "slow" | "stale";

export const BROWSER_HAND_BACK_MS = 8_000;
export const BROWSER_TAKE_NOTICE_MS = 300;
// The input queue halts beyond 32 unsent inputs, and a slow take can buffer more.
const FLUSH_BATCH = 16;
const MODIFIER_KEYS = new Set(["Alt", "Control", "Meta", "Shift"]);
const DISCRETE_KEYS = new Set(["Backspace", "Enter", "Tab", "Escape", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"]);
const ABSOLUTE_COMMANDS = new Set(["navigate", "tab-new"]);

function startsInteraction(item: BrowserInteraction): boolean {
  if ("command" in item) return true;
  const { eventType, key } = item.input;
  return eventType === "mousePressed" || eventType === "mouseWheel" || eventType === "char"
    || (eventType === "keyDown" && !MODIFIER_KEYS.has(String(key)));
}

const inputId = ({ type, code, key, button }: Body) => type === "input_keyboard" ? `key:${code || key}` : `mouse:${button}`;
const isPress = ({ eventType }: Body) => eventType === "keyDown" || eventType === "mousePressed";
const isRelease = ({ eventType }: Body) => eventType === "keyUp" || eventType === "mouseReleased";

/** macOS sends no key-up for a key let go while Cmd is down, so those never count as held. */
function heldUntilReleased(input: Body): boolean {
  if (input.type !== "input_keyboard") return true;
  const key = String(input.key);
  if (MODIFIER_KEYS.has(key)) return true;
  if (DISCRETE_KEYS.has(key)) return false;
  return !input.modifiers || (input.modifiers === 8 && [...key].length === 1);
}

const waitedForBot = (reply: unknown) => (reply as { waited?: unknown } | null | undefined)?.waited === true;

/** Never hands back while a key or button is held down: the server would then need a browser restart. */
export function createBrowserControl(options: {
  queue: Pick<ReturnType<typeof createBrowserInputQueue>, "enqueue" | "drain" | "settle" | "size" | "stopped">;
  take: () => Promise<unknown>;
  release: () => Promise<unknown>;
  command: (body: Body) => Promise<unknown>;
  busy: () => boolean;
  owned: () => boolean;
  onTakeStatus: (status: BrowserTakeStatus) => void;
  onError: (message: string) => void;
  onHalted: () => void;
}) {
  let state: "bot" | "taking" | "held" | "releasing" = "bot";
  let status: BrowserTakeStatus = "";
  let buffer: BrowserInteraction[] = [];
  let flushing = false;
  let closed = false;
  let pinned = false;
  let kept = false;
  let soon = false;
  let ownedBefore = false;
  let activity = 0;
  let chain: Promise<unknown> = Promise.resolve();
  let idle: ReturnType<typeof setTimeout> | undefined;
  let notice: ReturnType<typeof setTimeout> | undefined;
  const held = new Set<string>();
  const dropped = new Set<string>();

  const report = (next: BrowserTakeStatus) => { status = next; options.onTakeStatus(next); };
  const track = (input: Body) => {
    if (isPress(input) && heldUntilReleased(input)) held.add(inputId(input));
    else if (isRelease(input)) held.delete(inputId(input));
  };
  const quiet = () => !closed && !pinned && (soon || !kept) && !flushing && !held.size && !options.busy()
    && (state === "held" || (state === "bot" && options.owned()));
  const arm = () => {
    clearTimeout(idle);
    idle = closed ? undefined : setTimeout(() => { idle = undefined; void idleHandBack(); }, soon ? 0 : BROWSER_HAND_BACK_MS);
  };
  const release = () => {
    state = "releasing";
    if (status === "stale") report("");
    chain = chain.then(() => closed ? undefined : options.release()).catch(() => {})
      .then(() => { if (state === "releasing") state = "bot"; });
  };
  const idleHandBack = async () => {
    if (!quiet()) return;
    const seen = activity;
    await options.queue.drain();
    if (seen === activity && quiet()) release();
  };
  const dropStale = () => {
    const kept = buffer.filter((item) => "command" in item && ABSOLUTE_COMMANDS.has(String(item.command.type)));
    const lost = buffer.some((item) => !kept.includes(item) && startsInteraction(item));
    buffer = kept;
    for (const id of held) dropped.add(id);
    held.clear();
    return lost;
  };
  const flush = async () => {
    flushing = true;
    try {
      for (let item = buffer.shift(); item && !closed; item = buffer.shift()) {
        if ("command" in item) await options.command(item.command);
        else {
          options.queue.enqueue(item.input);
          if (options.queue.size() >= FLUSH_BATCH) await options.queue.settle();
        }
      }
    } finally { flushing = false; buffer = []; }
  };
  const take = () => {
    state = "taking";
    options.onError("");
    report("pending");
    clearTimeout(notice);
    notice = setTimeout(() => { if (!closed && state === "taking") report("slow"); }, BROWSER_TAKE_NOTICE_MS);
    chain = chain.then(async () => {
      if (closed) return;
      const grant = await options.take().then((reply) => ({ reply }), (cause: unknown) => {
        if (!closed) options.onError(cause instanceof Error ? cause.message : String(cause));
        return null;
      });
      clearTimeout(notice);
      if (closed) return;
      if (grant) {
        state = "held";
        report(waitedForBot(grant.reply) && dropStale() ? "stale" : "");
        await flush();
      } else { report(""); state = "bot"; buffer = []; held.clear(); }
      arm();
    }).catch(() => {});
  };

  return {
    interact(item: BrowserInteraction) {
      if (closed) return;
      if ("input" in item) {
        const id = inputId(item.input);
        if (isRelease(item.input) && dropped.delete(id)) return;
        if (isPress(item.input)) dropped.delete(id);
      }
      const waiting = state === "taking" || flushing;
      if (state !== "held" && !waiting) {
        if (!startsInteraction(item)) return;
        if ("input" in item && options.queue.stopped()) { options.onHalted(); return; }
      }
      if ("command" in item && waiting && buffer.some((queued) => "command" in queued)) return;
      if (startsInteraction(item)) {
        soon = false;
        if (status === "stale") report("");
      }
      if ("input" in item) track(item.input);
      activity++;
      arm();
      if (state === "held" && !waiting) {
        if ("input" in item) options.queue.enqueue(item.input);
        else void options.command(item.command).then(arm);
        return;
      }
      buffer.push(item);
      if (!waiting) take();
    },
    observe() {
      if (closed) return;
      const owned = options.owned();
      if (ownedBefore && !owned && state === "held" && !flushing) {
        state = "bot"; held.clear(); dropped.clear(); clearTimeout(idle); idle = undefined;
      }
      ownedBefore = owned;
      if (idle === undefined && owned) arm();
    },
    takeControl() {
      if (closed || state === "held" || state === "taking" || flushing) return;
      soon = false;
      take();
    },
    keep(on: boolean) {
      if (closed || kept === on) return;
      kept = on;
      if (!on) arm();
    },
    handBack() { if (!closed) { soon = true; arm(); } },
    hold(on: boolean) {
      if (closed || pinned === on) return;
      pinned = on;
      if (!on) arm();
    },
    leave() {
      if (!quiet() || options.queue.size()) return;
      state = "releasing";
      void options.release().catch(() => {});
    },
    close() { closed = true; clearTimeout(idle); clearTimeout(notice); buffer = []; held.clear(); dropped.clear(); },
  };
}
