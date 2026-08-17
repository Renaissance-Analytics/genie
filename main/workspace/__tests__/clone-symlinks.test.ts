import { describe, expect, it } from 'vitest';
import { cloneConfigFor, materializeAgentDocLinks } from '../clone-symlinks';

/**
 * Cloning a `.agi` envelope on Windows (genie#214).
 *
 * Reported: adding a workspace from a Tynn project failed outright —
 *
 *   Cloning into 'C:\…\orr-trader.agi'... error: unable to create symlink
 *   CLAUDE.md: Filename too long
 *   fatal: unable to checkout working tree
 *   warning: Clone succeeded, but checkout failed.
 *
 * The envelope keeps `CLAUDE.md` as a SYMLINK to `AGENTS.md`. Creating a symlink
 * on Windows needs Developer Mode or elevation, and without it git fails the
 * whole checkout — so the clone "succeeds" with an EMPTY working tree and the
 * workspace cannot be added at all.
 *
 * `core.symlinks=false` is git's own answer: it writes each symlink as an
 * ORDINARY FILE whose contents are the link target. That turns a fatal checkout
 * into a working tree — but leaves a `CLAUDE.md` whose entire content is the
 * text `AGENTS.md`, which Claude Code would then load as the workspace's
 * instructions. So the second half is required, not optional: materialise those
 * placeholders into the real thing.
 */

describe('cloning a repo that contains symlinks', () => {
    it('disables symlink checkout on Windows, where creating one fails the whole clone', () => {
        expect(cloneConfigFor('win32')).toContain('core.symlinks=false');
    });

    it('leaves symlinks alone everywhere they actually work', () => {
        // macOS and Linux create symlinks natively; forcing them off there would
        // turn a working link into a stray text file for no reason.
        expect(cloneConfigFor('darwin')).not.toContain('core.symlinks=false');
        expect(cloneConfigFor('linux')).not.toContain('core.symlinks=false');
    });
});

/** An in-memory tree standing in for the checkout. */
function fakeTree(files: Record<string, string>) {
    const written: Record<string, string> = {};
    return {
        written,
        fx: {
            read: async (p: string) => (p in files ? files[p]! : null),
            write: async (p: string, body: string) => {
                written[p] = body;
                files[p] = body;
            },
            size: async (p: string) => (p in files ? files[p]!.length : -1),
        },
    };
}

describe('materialising an agent doc that checked out as a symlink placeholder', () => {
    it('replaces a CLAUDE.md that is just the text "AGENTS.md" with the real content', async () => {
        const { written, fx } = fakeTree({
            'C:\\ws\\AGENTS.md': '# Tynn envelope\n\nThe real instructions.\n',
            // What core.symlinks=false leaves behind: the link TARGET as content.
            'C:\\ws\\CLAUDE.md': 'AGENTS.md',
        });

        const result = await materializeAgentDocLinks('C:\\ws', 'win32', fx);

        expect(result.materialized).toEqual(['CLAUDE.md']);
        expect(written['C:\\ws\\CLAUDE.md']).toBe('# Tynn envelope\n\nThe real instructions.\n');
    });

    it('NEVER overwrites a CLAUDE.md that is a real document', async () => {
        // The whole risk of this repair: a workspace whose CLAUDE.md is genuinely
        // its own file must not be replaced by AGENTS.md. Only a file that is
        // exactly a link target — one short line naming a sibling that exists —
        // is treated as a placeholder.
        const realDoc = '# CLAUDE.md\n\nThis workspace has its own instructions.\n';
        const { written, fx } = fakeTree({
            'C:\\ws\\AGENTS.md': '# Agents\n',
            'C:\\ws\\CLAUDE.md': realDoc,
        });

        const result = await materializeAgentDocLinks('C:\\ws', 'win32', fx);

        expect(result.materialized).toEqual([]);
        expect(written['C:\\ws\\CLAUDE.md']).toBeUndefined();
    });

    it('does nothing when the target named by the placeholder is not there', async () => {
        const { written, fx } = fakeTree({ 'C:\\ws\\CLAUDE.md': 'AGENTS.md' });

        const result = await materializeAgentDocLinks('C:\\ws', 'win32', fx);

        // Writing AGENTS.md's content when there is no AGENTS.md would mean
        // inventing content; leaving the placeholder is the honest failure.
        expect(result.materialized).toEqual([]);
        expect(written['C:\\ws\\CLAUDE.md']).toBeUndefined();
    });

    it('is a no-op on a platform whose symlinks checked out properly', async () => {
        const { written, fx } = fakeTree({
            '/ws/AGENTS.md': '# Agents\n',
            '/ws/CLAUDE.md': 'AGENTS.md',
        });

        const result = await materializeAgentDocLinks('/ws', 'linux', fx);

        // On posix that file IS a working symlink; reading it returns the
        // target's content already, and rewriting it would destroy the link.
        expect(result.materialized).toEqual([]);
        expect(written['/ws/CLAUDE.md']).toBeUndefined();
    });
});
