# Decisions the spec left to the builder

The spec (`.ai/plans/genie-2-spec-from-scratch.md`) names three choices as the builder's to
make **and record**. Recorded here, with what was measured rather than assumed.

## D1 — Client state: `fancy-query`

§10 said *"No Fancy client state manager. `fancy-query` and `fancy-inertia` are Laravel/
Inertia/Echo-shaped and useless to an Electron renderer."* **That was wrong, and measuring the
package corrected it.**

`@particle-academy/fancy-query` has `dependencies: {}`. Inertia is an *optional* peer reached
through a separate subpath; nothing on the main path touches it. The Echo coupling is
`EchoLike` — a **four-method structural interface** (`channel`, `private`, `leave`,
`socketId`), not a dependency on Echo. We implement it over Electron IPC and hand it to
`FancyDataRoot`. No third-party state library enters the tree.

`useFancyStream` is most of the Agent view's Stream already.

> **Trap, measured:** `while: "streaming"` is gated on a received `stream.started` frame.
> Use the `() => boolean` predicate form backed by a ref, or the first turn never streams.

## D2 — Styling: Tailwind v4 utilities, no CSS-in-JS

`tailwindcss ^4.0.0` is a **declared peer of `react-fancy`** — in-kit, the same category as
`node-pty` under `fancy-term`, not third-party drift. Every Fancy component is a bag of
Tailwind classes, so Tailwind is not optional and a second styling system would be a choice
to maintain two.

So: **one system.** Tailwind utilities for everything, with arbitrary values where the design
board gives an exact metric (`h-8`, `grid-cols-[150px_minmax(190px,1.15fr)_...]`). Colour
comes from the token names only — never a hex, except as the literal fallback inside `var()`.

Set up per the package's own README:

```css
@import "tailwindcss";
@source "../node_modules/@particle-academy/react-fancy/dist/**/*.js";
```

Rejected: inline `style` objects. They defeat `tailwind-merge`, so a Fancy component could not
be adjusted by passing `className`, and they put the mockup's metrics somewhere a theme cannot
reach them.

## D3 — Verification of a React surface without a window

Standing house rule: **no browser and no Electron on the owner's desktop.** So a surface is
asserted with `react-dom/server`'s `renderToStaticMarkup` — `react-dom` is a declared peer,
nothing is added to the tree, and the output is a string we can make real claims about:
the grid template, the row heights, which cells exist for which fidelity, and above all
**that a cell Genie cannot see is absent rather than zero**.

What that CANNOT prove, stated plainly so nobody reads more into a green suite than it earns:
it does not prove the surface *looks* right, that it fits a 900px screen, or that a click
opens anything. Those go to §8.1's smoke path on a VM. A render assertion is a claim about
markup, and will be reported as one.

## D4 — Tooling exceptions, declared rather than drifted into

The owner's rule is **Fancy and Prism only; no third party**. Four packages are in the tree
anyway, and each one is named here with what it is and why Fancy cannot supply it. Nothing
else gets added without the same paragraph.

| Package | Role | Why |
|---|---|---|
| `electron` | the runtime | Genie IS an Electron app. Not a library choice. |
| `vite` | bundler | Build tooling, not shipped code. Required by `@tailwindcss/vite`. |
| `tailwindcss`, `@tailwindcss/vite` | styling | A **declared peer of `react-fancy`** — in-kit, the same category as `node-pty` under `fancy-term`. |
| `vitest` | test runner | Build tooling. Upgraded 3 → 5 on arrival: `npm audit` reported two CRITICAL advisories (`tinypool` prototype-pollution → RCE) and one moderate path traversal in `@vitest/mocker`. Clean at 5. |

Still to come with their phases, and flagged in advance because each needs this paragraph
written: `electron-updater` (P7) and `electron-builder` (P7). `better-sqlite3` is **not**
planned — see D6.

### Rejected: `@vitejs/plugin-react`

Measured, not assumed: `@vitejs/plugin-react@6` requires `vite@^8`, and vitest pins vite at
`<=7`. One had to give. The plugin's only contribution is Fast Refresh for a dev server — and
running a dev server on the owner's desktop is forbidden by the house rules. Vite compiles
`.tsx` through esbuild from `jsx: "react-jsx"` with no plugin at all, so dropping it costs the
build nothing and keeps one test runner instead of two.

## D5 — A known visual gap: the fonts are not vendored

The design contract is **Geist** and **Geist Mono**. The published token file fetches them with
`@import url("https://fonts.googleapis.com/...")`, which was **stripped** on the way into this
repo: a desktop app must not render in a different face because the machine is offline, and a
renderer reaching a third-party CDN on boot is an undeclared dependency.

Until the woff2 files are vendored under `src/renderer/fonts/`, type falls back to the system
UI face. **The app is legible and NOT typographically correct**, and that is a real divergence
from the board rather than a styling bug. Written down so the next person recognises it.

## D6 — No database

Workspaces and agent records are two small JSON files under the runtime directory, written
atomically (`write .tmp` → `rename`). They are read once at boot and hold tens of entries.
`better-sqlite3` is a native module with no Fancy equivalent, and it would be bought for
nothing.

The file holds **every agent identity Genie has** — the persona survives in the repo, the
record pointing at a thread does not exist anywhere else — so two rules are tested rather than
intended: a write is atomic, and a malformed file **throws** instead of reading as empty. The
second matters more than it looks. Reading a truncated file as `[]` looks like graceful
recovery and is a two-step deletion: boot with no agents, then the first save writes `[]` over
the corrupt file.

## Reported upstream

- **`react-fancy@5.34.0` declares `resolveIcon` as a root export that the root does not have.**
  It is in `dist/index.d.ts` and absent from `dist/index.js`, so importing it from the package
  root typechecks clean and throws `resolveIcon is not a function` at runtime. The `./icon`
  subpath works. A types/runtime mismatch, which is the one class of bug a green `tsc` is
  guaranteed not to catch.
