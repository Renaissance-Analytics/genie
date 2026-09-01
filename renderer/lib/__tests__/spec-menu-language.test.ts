import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * An AGENT's menu must not call the agent a "terminal".
 *
 * The redesign made an agent bigger than the TUI and the pty driving it. The
 * menus did not follow: right-clicking an agent still offered "Delete terminal",
 * "Rename…", "Duplicate", "Move to workspace" — the vocabulary of the thing an
 * agent RUNS ON, on the thing that runs on it. The owner's words: "the mother
 * fucking menu is still using old language … the whole app has this problem".
 *
 * The component already knows which it is — `isAgent` has been computed in this
 * file the whole time and used to gate two items. So this is not a missing
 * capability, it is copy that was never revisited when the model changed.
 *
 * Read off the source rather than rendered, because there is no DOM harness in
 * this lane; the point is to fail when someone adds the next terminal-worded
 * label to a menu an agent shares.
 */

const SRC = fs.readFileSync(
    path.resolve(__dirname, '../../components/Master/SpecContextMenu.tsx'),
    'utf8',
);

/** Every `label="..."` in the file, with its surrounding line. */
function labels(): string[] {
    return [...SRC.matchAll(/label=\{?["'`]([^"'`]+)["'`]/g)].map((m) => m[1]!);
}

describe('the spec context menu', () => {
    it('knows whether it is on an agent', () => {
        // The guard this all hangs on. If it goes, the labels below cannot be
        // right for both cases and the test is pinning nothing.
        expect(SRC).toMatch(/const isAgent\s*=/);
    });

    it('does not hard-code "terminal" into a label an AGENT sees', () => {
        // The destructive one is the one that matters: "Delete terminal" on an
        // agent square reads as "remove the shell", and it is the whole agent.
        const hardCoded = labels().filter((l) => /\bterminal\b/i.test(l));
        expect(hardCoded).toEqual([]);
    });

    it('words the delete item from isAgent', () => {
        // Not a blanket rename to "Delete agent" — a plain terminal is still a
        // terminal, and calling it an agent would be the same error mirrored.
        expect(SRC).toMatch(/isAgent \? 'Delete agent' : 'Delete terminal'/);
    });
});
