import { useSyncExternalStore } from "react";

export const ADVANCED_MODE_KEY = "omb-advanced-mode";

// Read before main.tsx's first-paint writes: applySkin stamps omb-skin on every boot.
const PRIOR_RUN_KEYS = ["omb-skin", "omb-installed", "omb-email-gate", "omb-drafts", "omb-show-threads"];

let sessionChoice: boolean | undefined;
const listeners = new Set<() => void>();

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export function readAdvancedMode(): boolean {
  if (sessionChoice !== undefined) return sessionChoice;
  try {
    const store = storage();
    const stored = store?.getItem(ADVANCED_MODE_KEY);
    if (stored === "1") return true;
    if (stored === "0") return false;
    return PRIOR_RUN_KEYS.some((key) => store?.getItem(key) != null);
  } catch {
    return false;
  }
}

export function settleAdvancedModeDefault(): void {
  try {
    if (storage()?.getItem(ADVANCED_MODE_KEY) == null) setAdvancedMode(readAdvancedMode());
  } catch {
  }
}

function notify() {
  for (const listener of listeners) listener();
}

function onStorage(event: StorageEvent) {
  if (event.key !== ADVANCED_MODE_KEY && event.key !== null) return;
  if (event.storageArea && event.storageArea !== storage()) return;
  sessionChoice = undefined;
  notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1 && typeof window !== "undefined") {
    window.addEventListener("storage", onStorage);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== "undefined") {
      window.removeEventListener("storage", onStorage);
    }
  };
}

export function setAdvancedMode(enabled: boolean): void {
  sessionChoice = enabled;
  try {
    storage()?.setItem(ADVANCED_MODE_KEY, enabled ? "1" : "0");
  } catch {
  }
  notify();
}

export function useAdvancedMode(): boolean {
  return useSyncExternalStore(subscribe, readAdvancedMode, () => false);
}
