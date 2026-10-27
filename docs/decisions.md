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
- **`react-fancy@5.67.0`: `Editor` in view mode turns `ContentRenderer`'s copy buttons on but
  forwards neither `copyButtons` nor `clipboardWriter` (nor `onCopy`).** A host cannot route
  those copies through its own writer or switch them off. Genie is not affected today
  (`DocumentEditor`'s `readOnly` is never set, so its `Editor` is always in edit mode); a
  read-only document would get copy buttons on the page's clipboard, which can fail silently
  in a sandboxed Electron window.

## D7 — Packaging, and what the audit noise means

`electron-builder` (dev) and `electron-updater` (runtime) join the declared exceptions in D4.
Neither has a Fancy equivalent and both are what makes an Electron app installable.

**`npm audit` reports 8 moderate advisories and none of them reach the shipped app.** They all
trace to `sprintf-js` under `roarr` → `global-agent` → `@electron/get` → `app-builder-lib` →
`electron-builder`, which is a devDependency; `npm ls --omit=dev --all` finds none of them in
the production tree. The remaining fix is `npm audit fix --force`, which downgrades
`electron-builder` across a major version — a real change to the build for no change to what
users run. `electron-builder` was pinned to `26.5.0` and `npm audit fix` applied on arrival,
which cleared a CRITICAL `node-tar` chain and two HIGH `electron-updater` advisories, one of
which (`builder-util-runtime` leaking `Authorization` on a cross-origin redirect) DID reach the
runtime.

Recheck this when `electron-builder` ships a release whose `@electron/get` is current.

## D8 — The updater's channel is a PAIR, asserted on both sides

§0.8: the previous build's updater **could never see a release**, for the entire life of the
product. Every release published as a prerelease, `allowPrerelease` defaults to false in
`electron-updater`, and it was never set.

So `releaseType: prerelease` in `electron-builder.yml` and `allowPrerelease: true` in
`src/main/upgrade.ts` are asserted **together**. Changing either alone fails the test — probed
both ways, each going red on its own. Asserting only the flag would let somebody switch the
channel later and leave a flag that is true, inert and reassuring.

**Not yet verified end to end.** The config is right and tested; whether an in-app update
actually arrives cannot be known until a real release exists to check against, and this
document will not pretend otherwise.

## D9 — Glyph coverage, measured rather than assumed

`react-fancy`'s author asked which of the kit's non-ASCII characters render as tofu on a lean
Linux machine — a measurement they could not take from where they were. `scripts/glyph-coverage.mjs`
takes it, in the smoke container, by rasterising each character to a canvas and comparing it
pixel-for-pixel against a Private Use Area codepoint no font covers.

**The result depends entirely on which fonts are installed**, which is the useful half of the
answer:

| fonts present | tofu |
|---|---|
| Liberation only | `⇄` U+21C4, `✓` U+2713, `✕` U+2715, `✦` U+2726, `⌘` U+2318 |
| Liberation + DejaVu | none — every character drew |

So these are not broken characters. They sit in the band Liberation does not cover and DejaVu
does, which makes it a question about minimal images and kiosk installs rather than about the
components.

**And the band has a name.** react-fancy's author read the table and proposed it was WGL4 —
the repertoire Liberation targets — which would mean `direction="both"` is fixable with a
different CHARACTER rather than an SVG icon. They asked for the candidate (U+2194 `↔`) and,
unprompted, for the falsifier beside it (U+21C6 `⇆`, which should fail if the theory holds).

Measured, with four extra boundary probes because confirming one candidate is not testing a
theory: **seven predictions, seven correct.** `↔` draws, `⇆` is tofu, U+2195/21A8/25CA/2660 all
draw, U+2756 is tofu. The control failing as predicted is what makes it evidence rather than
agreement.

**So the fix is one character, not five icons.** `⇄` is the one that mattered to Genie —
`ActivityLight direction="both"` emits it and the Dashboard uses that component — and the
argument that closed it was not coverage but INCONSISTENCY: of the three directions, `in` and
`out` draw arrows and `both` draws a box, so a reader sees two working indicators and one
broken one with no way to tell a font gap from a state.

`✓` `✕` `✦` are Dingbats with no in-repertoire substitute, so those genuinely are the
glyph-versus-icon trade — and that one is not worth paying for an environment nobody ships a
desktop app into. `⌘` needs nothing: it only renders where somebody has that key.

### The first method was wrong, and its own control said so

Comparing advance WIDTHS cannot detect tofu in a monospace font, where every glyph is the same
width by definition — tofu included. The control (an ASCII `A` must not match tofu) failed in
the mono stack and the script refused to report, rather than announcing that every monospace
character was missing. **A control that refuses to report is worth more than a result.**
