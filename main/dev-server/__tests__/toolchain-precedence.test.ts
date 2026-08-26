import { describe, expect, it } from 'vitest';
import { pathWithToolsFirst, diagnoseToolchainPath } from '../toolchain-primitives';

/**
 * Genie's own tools must WIN on PATH, and Genie must be able to say when they
 * are not winning.
 *
 * The reported failure: the owner uninstalled Herd, Herd left its binaries on
 * disk and its entry on PATH, and `php` kept resolving to
 * `.config/herd/bin/php` — a shim for an install that no longer exists — while
 * Genie's own `toolchain/php/8.4.24` sat unused. Every terminal, agent and dev
 * server Genie spawned inherited that.
 *
 * The cause was one operator: `addToolsPathEntry` APPENDED, so anything already
 * on PATH shadowed the thing Genie had just installed. Installing a runtime and
 * then placing it where it cannot be found is a promise the UI does not keep.
 */
describe('Genie tools take precedence on PATH', () => {
    const SEP = ';';

    it('puts the tools dir FIRST, ahead of a foreign install that shadowed it', () => {
        const before = ['C:/Users/x/.config/herd/bin', 'C:/Windows/system32'].join(SEP);

        const after = pathWithToolsFirst(before, 'C:/Users/x/AppData/Roaming/genie/tools/bin', SEP);

        expect(after.split(SEP)[0]).toBe('C:/Users/x/AppData/Roaming/genie/tools/bin');
        // Positive control: the rest of PATH survives. "Genie is first" would
        // also pass against an operator that threw everything else away.
        expect(after.split(SEP)).toContain('C:/Windows/system32');
        expect(after.split(SEP)).toContain('C:/Users/x/.config/herd/bin');
    });

    it('MOVES an existing entry to the front rather than duplicating it', () => {
        const dir = 'C:/genie/tools/bin';
        const before = ['C:/Windows/system32', dir].join(SEP);

        const after = pathWithToolsFirst(before, dir, SEP);

        expect(after.split(SEP)[0]).toBe(dir);
        expect(after.split(SEP).filter((p) => p === dir)).toHaveLength(1);
    });

    it('is case- and trailing-slash-insensitive, because Windows PATH is', () => {
        const before = ['C:/GENIE/Tools/Bin/', 'C:/Windows/system32'].join(SEP);

        const after = pathWithToolsFirst(before, 'C:/genie/tools/bin', SEP);

        expect(after.split(SEP)).toHaveLength(2);
        expect(after.split(SEP)[0]).toBe('C:/genie/tools/bin');
    });

    it('normalises a trailing BACKSLASH, the form Windows actually writes', () => {
        // Forward-slash fixtures cannot catch this: a regex stripping only `/`
        // leaves `C:\\genie\\tools\\bin\\` unequal to the same path without it,
        // so the entry is duplicated instead of moved.
        const dir = 'C:\\genie\\tools\\bin';
        const before = ['C:\\genie\\tools\\bin\\', 'C:\\Windows\\system32'].join(SEP);

        const after = pathWithToolsFirst(before, dir, SEP);

        expect(after.split(SEP)).toHaveLength(2);
        expect(after.split(SEP)[0]).toBe(dir);
    });
});

describe('diagnosing a broken toolchain', () => {
    const SEP = ';';

    it('reports a foreign install SHADOWING a tool Genie manages', () => {
        const report = diagnoseToolchainPath({
            path: ['C:/herd/bin', 'C:/genie/tools/bin'].join(SEP),
            toolsDirs: ['C:/genie/tools/bin'],
            sep: SEP,
            resolved: { php: 'C:/herd/bin/php.bat' },
        });

        expect(report.shadowed).toContain('php');
        expect(report.toolsFirst).toBe(false);
    });

    it('says nothing is wrong when Genie already wins', () => {
        // The negative control for the case above: without this, "shadowed is
        // empty" could pass against a diagnoser that never reports anything.
        const report = diagnoseToolchainPath({
            path: ['C:/genie/tools/bin', 'C:/herd/bin'].join(SEP),
            toolsDirs: ['C:/genie/tools/bin'],
            sep: SEP,
            resolved: { php: 'C:/genie/tools/bin/php.exe' },
        });

        expect(report.shadowed).toEqual([]);
        expect(report.toolsFirst).toBe(true);
        expect(report.stale).toEqual([]);
    });

    it('reports a PATH entry pointing at a directory that no longer exists', () => {
        const report = diagnoseToolchainPath({
            path: ['C:/herd/bin', 'C:/genie/tools/bin'].join(SEP),
            toolsDirs: ['C:/genie/tools/bin'],
            sep: SEP,
            resolved: {},
            exists: (p) => p !== 'C:/herd/bin',
        });

        expect(report.stale).toContain('C:/herd/bin');
    });
});

/**
 * The dirs that must win are the ENGINE dirs, not one `tools` directory.
 *
 * Found by checking the reporting machine rather than trusting the design: the
 * language runtimes live under `<userData>/toolchain/<tool>/<version>`, while
 * `<userData>/tools` — the only directory the original repair prepended — did
 * not exist at all. Repairing it would have reported success and left `php`
 * resolving to Herd, which is the exact "green report, unchanged machine"
 * failure this feature exists to end.
 */
describe('precedence covers every managed engine dir', () => {
    const SEP = ';';

    it('puts ALL managed dirs first, in order, ahead of a foreign install', () => {
        const dirs = ['C:/genie/toolchain/php/8.4.24', 'C:/genie/toolchain/node/22.23.2/bin'];
        const before = ['C:/Users/x/.config/herd/bin', 'C:/Windows/system32'].join(SEP);

        const after = pathWithToolsFirst(before, dirs, SEP);

        expect(after.split(SEP).slice(0, 2)).toEqual(dirs);
        // Positive control: nothing else was thrown away.
        expect(after.split(SEP)).toContain('C:/Windows/system32');
        expect(after.split(SEP)).toContain('C:/Users/x/.config/herd/bin');
    });

    it('does not call a tool shadowed when it resolves into ANY managed dir', () => {
        // With one tools dir, an engine resolving out of the php dir while the
        // node dir sits first would be reported as shadowed — a false alarm that
        // makes the repair button lie about a healthy machine.
        const report = diagnoseToolchainPath({
            path: ['C:/genie/toolchain/node/22.23.2', 'C:/genie/toolchain/php/8.4.24'].join(SEP),
            toolsDirs: ['C:/genie/toolchain/node/22.23.2', 'C:/genie/toolchain/php/8.4.24'],
            sep: SEP,
            resolved: {
                node: 'C:/genie/toolchain/node/22.23.2/node.exe',
                php: 'C:/genie/toolchain/php/8.4.24/php.exe',
            },
        });

        expect(report.shadowed).toEqual([]);
        expect(report.toolsFirst).toBe(true);
    });

    it('still reports shadowing when a foreign dir sits ahead of the managed ones', () => {
        // Negative control for the case above.
        const report = diagnoseToolchainPath({
            path: ['C:/herd/bin/php84', 'C:/genie/toolchain/php/8.4.24'].join(SEP),
            toolsDirs: ['C:/genie/toolchain/php/8.4.24'],
            sep: SEP,
            resolved: { php: 'C:/herd/bin/php84/php.exe' },
        });

        expect(report.shadowed).toContain('php');
        expect(report.toolsFirst).toBe(false);
    });
});
