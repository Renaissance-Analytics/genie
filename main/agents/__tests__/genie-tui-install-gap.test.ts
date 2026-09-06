import { describe, expect, it } from 'vitest';
import { AGENT_CLI_CATALOG } from '../agent-cli-catalog';

/**
 * THE GAP THAT STARTED THIS — reopened, with the reason nailed down.
 *
 * The `genie` entry began as `install: null` with two named blockers: `@genie/tui`
 * was unpublished, and its `bin` was `genie-tui` while the provider launches
 * `genie`. Four more faults were found and fixed on the way — no build script,
 * `dist/` gitignored with no `files` array (so the tarball shipped empty), and no
 * `prepare` (so a git install cloned and never built) — and then an installer was
 * wired, on the strength of this:
 *
 *     $ npm install github:Renaissance-Analytics/genie-tui
 *     $ ls node_modules/.bin/genie*          -> genie, genie.cmd, genie.ps1
 *     $ ./node_modules/.bin/genie --version  -> 0.0.0
 *
 * That command works. It is not the command the product runs. The product runs
 * `npm install -g --prefix <userData>/toolchain/npm-global <spec>`, and with `-g`
 * the same install fails every single time:
 *
 *     npm error command failed
 *     > @genie/tui@0.0.0 build
 *     > tsc -p tsconfig.build.json
 *     'tsc' is not recognized as an internal or external command
 *
 * WHY: npm prepares a git dependency by cloning it and shelling out to a nested
 * `npm install --force … --include=dev …` inside the clone. That nested process
 * inherits `npm_config_global=true` and `npm_config_prefix` from the outer `-g`,
 * so it installs globally too — the clone's dependencies land under
 * `<prefix>/node_modules/@genie/tui/node_modules/` and the clone itself never
 * gets a `node_modules/.bin`. `prepare` then calls a `tsc` that is not there.
 *
 * The variable was isolated by running all three:
 *
 *     npm install                github:…/genie-tui  -> exit 0, .bin/genie present
 *     npm install --prefix X     github:…/genie-tui  -> exit 0, .bin/genie present
 *     npm install -g --prefix X  github:…/genie-tui  -> FAILS, 'tsc' not found
 *
 * so it is `-g`, not the prefix. Moving `typescript` into `dependencies` fixes
 * nothing: `@mastra/core`, a plain dependency, went to the wrong place too.
 *
 * WHAT WOULD CLOSE IT, in `genie-tui`: commit a built `dist/` and drop `prepare`,
 * or publish a packed tarball as a release asset and install from that URL. npm
 * never prepares a tarball. Either one makes this file's assertions flip back,
 * and the sibling suite in `agent-cli-catalog.test.ts` is what will hold whoever
 * flips them to a spec npm can actually run.
 *
 * The lesson worth more than the fix: a verification that runs a WEAKER command
 * than the product's proves the product nothing. That is now enforced, not
 * remembered — see "an npm install spec names a REGISTRY package".
 */
describe('the Genie TUI installs, from a packed tarball', () => {
    const genie = AGENT_CLI_CATALOG.find((entry) => entry.id === 'genie');

    it('is in the catalog at all — listed, never hidden', () => {
        expect(genie).toBeDefined();
    });

    it('installs from a release TARBALL, which npm never prepares', () => {
        expect(genie?.install?.manager).toBe('npm');
        expect(genie?.install?.package).toMatch(/\.tgz$/);
    });

    /**
     * The URL names the VERSION-LESS ALIAS, so this entry never needs editing
     * on a release.
     *
     * GitHub's `/releases/latest/download/<name>` resolves only if the LATEST
     * release carries an asset with that exact name, so a URL naming the
     * versioned asset works today and 404s the moment the next release ships —
     * a button that fails in the field rather than at edit time. That was the
     * case when this shipped, and the entry pinned the tag instead: stale beats
     * broken. genie-tui now publishes the same bytes twice on every release,
     * under the versioned name and under `genie-tui.tgz`, and backfilled the
     * alias onto v0.1.0, so the stable URL resolves today.
     *
     * Re-measured after that landed rather than taken on report:
     *
     *     latest/download/genie-tui.tgz         -> 200
     *     download/v0.1.0/genie-tui-0.1.0.tgz   -> 200
     *     cmp of the two downloads              -> byte-identical
     *     npm install -g --prefix <tmp> <alias> -> added 255 packages
     *     <tmp>/genie --version                 -> 0.1.0
     */
    it('names the version-less alias, so a release does not strand this line', () => {
        expect(genie?.install?.package).toContain('/releases/latest/download/');
        // A VERSION in the filename is the failure mode this exists to stop:
        // `latest/download/genie-tui-0.1.0.tgz` is a 200 that becomes a 404.
        expect(genie?.install?.package).not.toMatch(/\d+\.\d+\.\d+/);
    });

    it('states no gap, because it no longer has one', () => {
        // `installGap` beside a working installer is a UI explaining why it
        // cannot do the thing it is currently doing.
        expect(genie?.installGap).toBeUndefined();
    });

    it('still points at somewhere a person can get it themselves', () => {
        expect(genie?.docsUrl).toBe('https://github.com/Renaissance-Analytics/genie-tui');
    });

    it('binds the provider whose defaultCommand is the binary it would install', () => {
        // Unchanged by any of this: when the package ships a prebuilt release,
        // the bin on PATH is `genie`, which is what the provider launches.
        expect(genie?.provider).toBe('genie');
        expect(genie?.bin).toBe('genie');
    });
});
