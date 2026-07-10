// aistats Opencode plugin — live-trigger shim (DESIGN.md §3.1/§13).
//
// Install: copied by `aistats install --opencode` to
// ~/.config/opencode/plugins/aistats.js, where opencode auto-loads every `*.js`
// plugin file. All logic lives in the CLI — this shim only decides when to fire
// `aistats ingest --tool opencode` and never blocks opencode itself: the ingest
// runs detached (its promise is deliberately not awaited) and every failure is
// swallowed, so a plugin bug (or `aistats` missing from PATH) can never break the
// host.
//
// Verified against the installed @opencode-ai/plugin 1.17.x typings
// (~/.opencode/node_modules/@opencode-ai/plugin/dist/index.d.ts) and the two
// existing plugins this is modeled after:
//  - `event.type === "session.idle"` carries `event.properties.sessionID`
//    (≈ a session's Stop/SessionEnd) — see herdr-agent-state.js.
//  - `Session.parentID` is set only on a subagent/child session; `client.session.get`
//    is the way to check it before acting, so a spawn's internal subtask never
//    triggers its own ingest — see telegram-notify.js's `isRootSession`.
//  - `$` is the Bun shell handed in `PluginInput`; a template call spawns without
//    blocking unless awaited, and `.quiet()` keeps its output out of opencode's UI.

export const AistatsPlugin = async ({ client, $ }) => {
  async function isRootSession(id) {
    try {
      const { data } = await client.session.get({ path: { id } });
      return data ? !data.parentID : true;
    } catch {
      return true;
    }
  }

  return {
    event: async ({ event }) => {
      if (event.type !== 'session.idle') return;
      const id = event.properties.sessionID;
      if (!id || !(await isRootSession(id))) return;
      // Fire-and-forget: do not await, so a slow/failing ingest never delays opencode.
      void $`aistats ingest --tool opencode`
        .quiet()
        .catch(() => {});
    },
  };
};
