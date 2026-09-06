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
describe('the Genie TUI states its install gap', () => {
    const genie = AGENT_CLI_CATALOG.find((entry) => entry.id === 'genie');

    it('is in the catalog at all — listed, never hidden', () => {
        expect(genie).toBeDefined();
    });

    it('offers no installer, because the only one available cannot work', () => {
        expect(genie?.install).toBeNull();
    });

    it('says WHY, in words the row can show where the button would have been', () => {
        // `installGap` is required IFF install is null, and a row with neither a
        // button nor a reason is the state the owner was already looking at.
        expect(genie?.installGap).toBeTruthy();
        expect(genie?.installGap).toMatch(/build|prebuilt/i);
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
