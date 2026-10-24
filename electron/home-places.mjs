// The places one window can show besides My Cloud: each team the verified session lists. Main keeps them as saved
// places (environments.cjs `team` entries, so the window's navigation rules know their addresses) and here what else
// the switcher needs: the place to open next time, and the one line waiting for the next page (a team this person is
// no longer in). Nothing here comes from a page: the list of teams is the Admin's session's, read by main. Who can see a
// team's private chats is said by the team's own page, in the chat (T2's TeamPrivateChatsLine), not here.
import environments from "./environments.cjs";

/**
 * @param {{
 *   store: { read(): unknown, write(value: unknown): void },
 *   environments(): { environments: any[], activeId: string },
 *   persist(state: unknown): void,
 *   makeId(): string,
 *   homeOrigin(): string | null,
 *   log?(line: string): void,
 * }} deps `store`: this app's home-place.json (`{ team }`); `environments()` / `persist()`: the saved places and their
 * file; `homeOrigin()`: My Cloud's verified origin, the place the window falls back to.
 */
export function createHomePlaces({ store, environments: read, persist, makeId, homeOrigin, log = () => {} }) {
  let cached = null;
  const pending = [];
  function load() {
    try {
      const record = store.read();
      return { team: typeof record?.team === "string" ? record.team : null };
    } catch { return { team: null }; }
  }
  const current = () => (cached ??= load());
  function save(next) {
    cached = next;
    try { store.write(next); } catch (error) { log(`home places: could not save (${error?.message ?? error})`); }
  }
  const entryOf = (id) => read().environments.find((entry) => entry.team?.id === id) ?? null;
  const places = {
    /** The team shown last time, as saved: its id, and its name and address while it is still a saved place. */
    remembered() {
      const id = current().team;
      if (!id) return null;
      const entry = entryOf(id);
      return entry ? { team: id, name: entry.name, origin: entry.origin } : { team: id };
    },
    /** What the window opens next time: a team (`{ team }`), or My Cloud (null). */
    remember(place) {
      const team = typeof place?.team === "string" ? place.team : null;
      if (team !== current().team) save({ ...current(), team });
    },
    /** The team shown is no longer this person's: said once, on the next page that asks. */
    left(name) {
      if (typeof name === "string" && name && !pending.includes(name)) pending.push(name);
    },
    /** The Admin refused the person's pairing with a team (404: they were removed): the team leaves the switcher now,
     * not at the next session check, the window falls back to My Cloud, and the one line waits for its page. */
    drop(place) {
      const state = read(), entry = state.environments.find((candidate) => candidate.team?.id === place?.id) ?? null;
      if (entry) {
        const kept = state.environments.filter((candidate) => candidate !== entry);
        const activeId = state.activeId !== entry.id ? state.activeId : kept.find((candidate) => candidate.origin === homeOrigin())?.id ?? environments.LOCAL_ID;
        persist({ ...state, environments: kept, activeId });
      }
      places.left(entry?.name ?? place?.name);
      if (current().team === place?.id) places.remember(null);
    },
    /** The MausBot Cloud sign-in changed: a connected session's teams are the saved team places (one it no longer
     * lists is gone, with its name for the line); anything else changes nothing. */
    sync(state) {
      if (state?.status !== "connected") return;
      const teams = Array.isArray(state.teams) ? state.teams : [];
      const { state: next, left } = environments.reconcileTeams(read(), teams, makeId, homeOrigin());
      if (next !== read()) persist(next);
      for (const name of left) places.left(name);
      if (current().team && !teams.some((team) => team?.id === current().team)) places.remember(null);
    },
    /** The one line for the next page, served once: a team this person is no longer in. */
    line() {
      return pending.length ? { kind: "left", name: pending.shift() } : null;
    },
  };
  return places;
}
