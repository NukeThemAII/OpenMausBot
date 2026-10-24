import type { Action } from "@/state/store";

/** New bot opens the New bot form in both modes; the form itself shows fewer fields in Simple mode. */
export function addBot(dispatch: (action: Action) => void): void {
  dispatch({ type: "toggleNewBot", open: true });
}
