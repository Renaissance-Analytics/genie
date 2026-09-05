import { describe, expect, it } from 'vitest';
import { AGENT_CLI_CATALOG } from '../agent-cli-catalog';

/**
 * THE GAP THAT STARTED THIS, CLOSED.
 *
 * The `genie` entry carried `install: null` with a comment naming two blockers:
 * `@genie/tui` was `private: true` and unpublished, and its `bin` was named
 * `genie-tui` while the provider launches `genie`. An installer wired before
 * both were fixed would have put the WRONG NAME on PATH — the exact bug the
 * registry's `defaultCommand` comment already documents, one layer later.
 *
 * Both are now false, and both were verified by RUNNING the install rather than
 * by reading the repo:
 *
 *   $ npm install github:Renaissance-Analytics/genie-tui
 *   $ ls node_modules/.bin/genie*      -> genie, genie.cmd, genie.ps1
 *   $ ./node_modules/.bin/genie --version -> 0.0.0
 *
 * Four independent faults had to be fixed before that worked: no build script,
 * the wrong bin name, `dist/` gitignored with no `files` array (so the tarball
 * shipped empty), and no `prepare` (so a git install cloned and never built).
 * Each one alone made the package uninstallable, which is why "it still isn't
 * installing" survived so many attempts to fix it.
 */
describe('the Genie TUI is installable', () => {
    const genie = AGENT_CLI_CATALOG.find((entry) => entry.id === 'genie');

    it('is in the catalog at all', () => {
        expect(genie).toBeDefined();
    });

    it('has an install recipe rather than a stated gap', () => {
        expect(genie?.install).not.toBeNull();
        // `installGap` is required IFF install is null. A gap left behind next
        // to a working installer is a UI that explains why it cannot do the
        // thing it is currently doing.
        expect(genie?.installGap).toBeUndefined();
    });

    it('installs from the public repo, not from the npm registry', () => {
        // Genie's own posture: a public GitHub repo, `private: true`, never
        // published to npm. `npm view genie` is somebody else's package
        // entirely, and the `@genie` scope is not ours — so the registry is the
        // wrong place to reach for, not merely the unchosen one.
        expect(genie?.install).toEqual({
            manager: 'npm',
            package: 'github:Renaissance-Analytics/genie-tui',
        });
    });

    it('binds the provider whose defaultCommand is the installed binary', () => {
        expect(genie?.provider).toBe('genie');
    });
});
