import { useEffect, useState } from "react";

import { fetchMemoryDoc, MEMORY_INDEX, type MemoryDoc } from "@/lib/memory";
import type { Bot } from "@/state/store";

export interface MemoryIndex {
  doc: MemoryDoc | null;
  error: boolean;
  setDoc: (doc: MemoryDoc) => void;
  reload: () => Promise<void>;
}

/** MEMORY.md for a bot whose memory is on; `doc` stays null until it has been read. */
export function useMemoryDoc(bot: Pick<Bot, "id" | "memoryEnabled">): MemoryIndex {
  const [state, setState] = useState<{ botId: string; doc: MemoryDoc | null; error: boolean }>({ botId: bot.id, doc: null, error: false });
  const memoryOn = bot.memoryEnabled !== false;

  const read = async (botId: string, cancelled?: () => boolean) => {
    try {
      const doc = await fetchMemoryDoc(botId, MEMORY_INDEX);
      if (!cancelled?.()) setState({ botId, doc, error: false });
    } catch {
      if (!cancelled?.()) setState({ botId, doc: null, error: true });
    }
  };

  useEffect(() => {
    if (!memoryOn) return;
    let cancelled = false;
    void read(bot.id, () => cancelled);
    return () => { cancelled = true; };
  }, [bot.id, memoryOn]);

  const own = state.botId === bot.id;
  return {
    doc: own ? state.doc : null,
    error: own && state.error,
    setDoc: (doc) => setState({ botId: bot.id, doc, error: false }),
    reload: () => read(bot.id),
  };
}
