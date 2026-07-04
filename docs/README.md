# Genie User Guide

Welcome to the Genie documentation. These pages describe **how to use every
feature** of the Genie desktop app, based on its actual current behaviour.

You can read them in order, or jump to what you need. The in-app **Docs** viewer
(open it from the title bar's Docs button, or the **Help → Documentation** menu)
renders these same pages with a navigable sidebar.

## Pages

1. **[Overview](00-overview.md)** — what Genie is and the big picture.
2. **[Getting started](01-getting-started.md)** — first workspace, first
   terminal, first editor.
3. **[Workspaces](02-workspaces.md)** — the sidebar, switching, `.agi`
   envelopes, pinning.
4. **[Views & layouts](03-views-and-layouts.md)** — terminals vs editors,
   Max Views, layout modes, maximise, resizable splits.
5. **[Terminals](04-terminals.md)** — creating, shells, focus, close, suspend /
   re-enable.
6. **[Terminal session persistence](05-session-persistence.md)** — the three
   tiers, quit confirmation, update warning, cwd resume.
7. **[Editor](06-editor.md)** — open / edit / save, lock to a folder, git-status
   colours, the tree context menu.
8. **[Keyboard shortcuts](07-keyboard-shortcuts.md)** — the keys that make Genie
   fast.
9. **[Settings](08-settings.md)** — every setting, explained.
10. **[Updates](09-updates.md)** — how auto-update works and what to expect.
11. **[Sign in & integrations](10-sign-in-and-integrations.md)** — Tynn,
    Aionima, GitHub, and quick capture.
12. **[Plugins & marketplaces](11-plugins.md)** — the bundled plugins,
    installing from the Official tab / marketplaces / a repo URL, capability
    grants, plugin editor tabs, agent tools, signing & Developer Mode.

## Developer & reference docs

Not shown in the in-app viewer (no numeric prefix) — for people building on
Genie:

- **[Writing a Genie plugin](plugin-authoring.md)** — the manifest, the worker
  contract, capabilities, and the complete `hello-world` example.
- **[Plugin signing](plugin-signing.md)** — Ed25519 signing in CI, the trust
  root, and signing your own plugins.
- **[The `.agi` envelope format](agi-format.md)** — the workspace monorepo
  format Genie creates and consumes.
- **[Release pipeline](release-pipeline.md)** — how Genie itself is built,
  tested, and released.

---

*This guide reflects the real behaviour of the app. If something here doesn't
match what you see, check your version under **Help → Genie vX.Y.Z**.*

*Index discipline: every `NN-name.md` page in this folder must be linked above —
a unit test (`main/docs/__tests__/docs.test.ts`) fails the build when this
index drifts out of date.*
