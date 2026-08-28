import path from 'path';
import { describe, expect, it } from 'vitest';
import { copyAppSource, type CopyFs } from '../copy-source';
import type { AppManifest } from '../manifest';

/**
 * Copying a GApp's source into its workspace.
 *
 * The install gate and this copier answer the SAME question — where does the
 * component named in the manifest actually sit — and they used to answer it in two
 * places with one hardcoded assumption each. When those disagree the install does
 * not merely fail: it fails after the workspace has been created, with the source
 * folder still holding exactly the folder the error says is missing.
 *
 * So both layouts are asserted here, and the envelope one is asserted with a
 * fixture that is envelope-SHAPED — a flat fixture cannot reach the branch.
 */

const SOURCE = 'C:/src/the-ripple-effect.agi';
const WORKSPACE = 'C:/genie/workspaces/ripple';

const manifest = (over: Record<string, unknown> = {}): AppManifest =>
    ({
        id: 'com.civicognita.ripple',
        slug: 'ripple',
        name: 'The Ripple Effect',
        version: '0.1.0',
        frontend: { repo: 'the-ripple-effect', serve: { mode: 'proxy', hostPort: 5273 } },
        permissions: { scope: 'self', capabilities: [] },
        ...over,
    }) as unknown as AppManifest;

/** Records what was copied, so the assertion is on the MOVE and not on a mock call. */
function fsWith(present: string[]): CopyFs & { copies: { from: string; to: string }[] } {
    const set = new Set(present.map((p) => path.normalize(p)));
    const copies: { from: string; to: string }[] = [];
    return {
        copies,
        exists: (p) => set.has(path.normalize(p)),
        copyDir: (from, to) => copies.push({ from: path.normalize(from), to: path.normalize(to) }),
    };
}

describe('a converted .agi envelope as the source', () => {
    /** Manifest at the root, component at `repos/<name>`, nothing flat. */
    const envelope = () => [
        path.join(SOURCE, 'project.json'),
        path.join(SOURCE, 'repos', 'the-ripple-effect'),
        path.join(SOURCE, 'gapp.json'),
    ];

    it('takes the component from repos/, and still lands it at repos/', () => {
        const io = fsWith(envelope());

        copyAppSource(SOURCE, WORKSPACE, manifest(), io);

        expect(io.copies).toContainEqual({
            from: path.normalize(path.join(SOURCE, 'repos', 'the-ripple-effect')),
            to: path.normalize(path.join(WORKSPACE, 'repos', 'the-ripple-effect')),
        });
    });

    it('carries the manifest, which is envelope-level in either layout', () => {
        const io = fsWith(envelope());

        copyAppSource(SOURCE, WORKSPACE, manifest(), io);

        expect(io.copies).toContainEqual({
            from: path.normalize(path.join(SOURCE, 'gapp.json')),
            to: path.normalize(path.join(WORKSPACE, 'gapp.json')),
        });
    });

    it('still refuses when the component is genuinely not there', () => {
        // POSITIVE CONTROL for the two tests above: they assert a copy HAPPENED,
        // which a copier that blindly copied everything would also satisfy. This is
        // the same fixture with the component removed, and it has to throw.
        const io = fsWith([path.join(SOURCE, 'project.json'), path.join(SOURCE, 'gapp.json')]);

        expect(() => copyAppSource(SOURCE, WORKSPACE, manifest(), io)).toThrow(
            /the-ripple-effect/,
        );
    });
});

describe('a scaffolded staging folder as the source', () => {
    const STAGING = 'C:/src/trader';
    const flat = () => [path.join(STAGING, 'web'), path.join(STAGING, 'gapp.json')];
    const traderManifest = () =>
        manifest({ frontend: { repo: 'web', serve: { mode: 'static', root: 'dist' } } });

    it('takes a flat component and lands it under repos/ — the copier translates', () => {
        const io = fsWith(flat());

        copyAppSource(STAGING, WORKSPACE, traderManifest(), io);

        expect(io.copies).toContainEqual({
            from: path.normalize(path.join(STAGING, 'web')),
            to: path.normalize(path.join(WORKSPACE, 'repos', 'web')),
        });
    });

    it('does NOT go looking under repos/ in a folder that has no project.json', () => {
        // The mirror of the bug: fixing the envelope case by always preferring
        // `repos/` would break every folder `scaffoldApp` writes.
        const io = fsWith([...flat(), path.join(STAGING, 'repos', 'web')]);

        copyAppSource(STAGING, WORKSPACE, traderManifest(), io);

        expect(io.copies.map((c) => c.from)).toContain(path.normalize(path.join(STAGING, 'web')));
        expect(io.copies.map((c) => c.from)).not.toContain(
            path.normalize(path.join(STAGING, 'repos', 'web')),
        );
    });

    it('still refuses when the flat component is missing', () => {
        const io = fsWith([path.join(STAGING, 'gapp.json')]);

        expect(() => copyAppSource(STAGING, WORKSPACE, traderManifest(), io)).toThrow(/web/);
    });
});

describe('an app that named no components at all', () => {
    it('copies the whole folder, in either layout', () => {
        const io = fsWith([path.join(SOURCE, 'project.json')]);

        copyAppSource(
            SOURCE,
            WORKSPACE,
            manifest({ frontend: { serve: { mode: 'proxy', hostPort: 5273 } } }),
            io,
        );

        expect(io.copies).toEqual([
            { from: path.normalize(SOURCE), to: path.normalize(WORKSPACE) },
        ]);
    });
});
