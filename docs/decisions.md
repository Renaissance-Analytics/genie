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
