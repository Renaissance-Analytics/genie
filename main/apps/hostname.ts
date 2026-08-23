/**
 * PURE. WHERE a Genie App is served (Tynn #250).
 *
 * A GApp's address was being built by string concatenation in four places —
 * `appInstallPlan` (the site's `genName`), `appWindowTabs` (the origin a window's
 * tabs resolve against), `appsList` (the `homeUrl` the Apps panel opens), and the
 * consent screen (what the user is told will appear). Four copies of one fact.
 *
 * That was survivable while the answer was permanent. It is not permanent: the
 * owner's correction of 2026-08-22 moves hosted GApp sites from `<name>.gen` to
 * **`<name>.gapp`**, and a four-place change is a three-place change with a bug in
 * it — the missed one being, most likely, the tab origin, where a wrong answer
 * shows up as an app whose own pages will not load.
 *
 * So the address is decided here and nowhere else.
 *
 * ## The TLD is NOT switched yet, deliberately
 *
 * Serving `.gapp` is not a change to Genie Apps; it is a change to HOSTING, and it
 * lands on installed apps exactly as hard as on previewed ones. `.gen` is asserted
 * in at least four shared places outside this folder:
 *
 *   - `dev-server/sites-config.ts` — the site sanitiser REFUSES a `genName` whose
 *     last label is not `gen`, so a `.gapp` name would be silently dropped
 *   - `dev-server/hosts-file.ts` — `GEN_HOST_RE`, which THROWS on a non-`.gen` name
 *   - `dev-server/host-ca.ts` — the multi-SAN certificate, issued over `.gen` names
 *   - `dev-server/host-allowlist.ts` — the host-header allowlist
 *
 * None of that is a previewer's business, and doing it inside a previewer's change
 * would bury a hosting migration where nobody would review it as one. It is
 * flagged as its own piece of work, and this module is what makes it small: flip
 * {@link GAPP_TLD}, fix the hosting layer, and every GApp address in Genie —
 * installed, previewed, consented-to — moves together and cannot be left half
 * done.
 *
 * NOT to be confused with the `.gapp` ENVELOPE SUFFIX, which is what an installed
 * GApp's workspace FOLDER is called on disk. Same four letters, unrelated fact —
 * see the note at the top of `docs/agi-format.md`. A hostname suffix must never be
 * added to `ENVELOPE_SUFFIXES`: that would make Genie call a directory an envelope
 * because of what a web server answers to.
 */

/**
 * The TLD a Genie App's hosted sites live under.
 *
 * THE one line to change when the hosting layer can serve `.gapp`. It is a
 * constant rather than a setting because every GApp on a machine has to move at
 * once — a mix of `.gen` and `.gapp` apps is two addressing schemes for one thing,
 * and the certificate covers a set of names, not a pattern.
 */
export const GAPP_TLD = 'gen';

/** `<slug>.gen` — the DNS name. What a site config's `genName` is set to. */
export function gappHostname(slug: string): string {
    return `${slug}.${GAPP_TLD}`;
}

/**
 * `https://<slug>.gen` — the ORIGIN.
 *
 * Always https. Genie serves `.gen` over TLS and rewrites http to it, so building
 * an http origin here would reopen the downgrade the hosting layer exists to
 * close — and this string is what `decideAppNavigation` compares against, so a
 * wrong scheme would not merely be ugly, it would decide same-origin wrongly.
 */
export function gappOrigin(slug: string): string {
    return `https://${gappHostname(slug)}`;
}

/** `https://<slug>.gen/` — the app's front page, with the trailing slash. */
export function gappHomeUrl(slug: string): string {
    return `${gappOrigin(slug)}/`;
}
