import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
    listTree,
    readFile,
    writeFile,
    _setMachineRootsForTest,
    listWindowsDrives,
    type TreeNodeData,
} from '../ipc';
import {
    markDesktopRuntime,
    markHeadlessRuntime,
    _resetRuntimeModeForTest,
} from '../../runtime-mode';
import { cleanupTmpRoot, makeTmpDir } from '../../../test/helpers';

/**
 * System-workspace FULL-filesystem access (Part A). On the DESKTOP the System
 * workspace resolves ANY absolute path — read/write outside the (home) root —
 * because it is the user's own trusted machine. Every NON-system workspace stays
 * strictly confined by the path-guard, and HEADLESS (genie-cloud) can NEVER get
 * full-FS even when a caller sets `system: true`. Fail-closed.
 */

afterAll(() => cleanupTmpRoot());
afterEach(() => {
    _resetRuntimeModeForTest();
    _setMachineRootsForTest(null);
});

/** Flatten a tree's ids. */
function ids(nodes: TreeNodeData[]): string[] {
    const out: string[] = [];
    const walk = (ns: TreeNodeData[]) => {
        for (const n of ns) {
            out.push(n.id);
            if (n.children) walk(n.children);
        }
    };
    walk(nodes);
    return out;
}

describe('system workspace full-FS (desktop only)', () => {
    it('desktop system read/write resolves an ABSOLUTE path outside the root', async () => {
        markDesktopRuntime();
        const wsRoot = makeTmpDir('sys-ws');
        const outside = makeTmpDir('sys-outside');
        const secret = path.join(outside, 'secret.txt');
        fs.writeFileSync(secret, 'top-secret');

        // Read an absolute path far outside the workspace root — allowed for system.
        const r = await readFile(wsRoot, secret, true);
        expect(r.content).toBe('top-secret');

        // Write an absolute path outside the root — allowed for system.
        const target = path.join(outside, 'written-by-system.txt');
        await writeFile(wsRoot, target, 'hello', true);
        expect(fs.readFileSync(target, 'utf8')).toBe('hello');
    });

    it('desktop system tree drilled into an absolute folder yields ABSOLUTE ids', async () => {
        markDesktopRuntime();
        const wsRoot = makeTmpDir('sys-ws2');
        const outside = makeTmpDir('sys-outside2');
        fs.writeFileSync(path.join(outside, 'a.txt'), '1');

        const tree = await listTree(wsRoot, { system: true, root: outside });
        const wantId = path.join(outside, 'a.txt').replace(/\\/g, '/');
        expect(ids(tree)).toContain(wantId);
    });

    it('lists one node per drive when the machine reports several (genie#466)', async () => {
        // The roots are INJECTED, so this asserts the mapping from a drive list
        // to a tree — which is the actual behaviour — instead of asserting
        // whatever happens to be plugged into the machine running the suite.
        markDesktopRuntime();
        _setMachineRootsForTest(async () => ['C:', 'D:']);
        const wsRoot = makeTmpDir('sys-ws3');

        // maxDepth 0 stops at the roots: this test is about the TOP level, and
        // walking two whole drives to assert their names is what made the old
        // version take 21 seconds.
        const tree = await listTree(wsRoot, { system: true, maxDepth: 0 });

        expect(tree.map((n) => n.id)).toEqual(['C:/', 'D:/']);
        expect(tree.map((n) => n.label)).toEqual(['C:', 'D:']);
        expect(tree.every((n) => n.type === 'folder')).toBe(true);
    });

    it('lists a single drive as a single node', async () => {
        markDesktopRuntime();
        _setMachineRootsForTest(async () => ['C:']);
        const tree = await listTree(makeTmpDir('sys-ws3b'), { system: true, maxDepth: 0 });
        expect(tree.map((n) => n.id)).toEqual(['C:/']);
    });

    it('puts the CHILDREN of / at the top level on POSIX, not a node called /', async () => {
        // The other shape, which the old test could never reach on a Windows box
        // and never asserted on a POSIX one: `/` has no drive letter above it, so
        // its children ARE the top level.
        markDesktopRuntime();
        _setMachineRootsForTest(async () => ['/']);
        const tree = await listTree(makeTmpDir('sys-ws3c'), { system: true, maxDepth: 0 });
        expect(tree.some((n) => n.id === '/')).toBe(false);
        expect(tree.every((n) => path.isAbsolute(n.id) || /^[A-Za-z]:\//.test(n.id))).toBe(true);
    });

    it(
        'enumerates the REAL machine roots end to end',
        async () => {
            // The one case that genuinely touches the machine, kept separate and
            // given room so the three deterministic assertions above are not
            // hostage to how many drives are attached or how loaded the box is.
            // `maxDepth: 0` still applies: enumerating the roots is the part that
            // has to be real, walking them is not.
            markDesktopRuntime();
            const tree = await listTree(makeTmpDir('sys-ws3d'), { system: true, maxDepth: 0 });
            expect(Array.isArray(tree)).toBe(true);
            for (const n of tree) {
                expect(path.isAbsolute(n.id) || /^[A-Za-z]:\/$/.test(n.id)).toBe(true);
            }
        },
        120_000,
    );
});

describe('non-system workspace stays confined (Part A invariant)', () => {
    it('rejects a `..` traversal even with no system flag', async () => {
        const wsRoot = makeTmpDir('conf-ws');
        const outside = makeTmpDir('conf-out');
        fs.writeFileSync(path.join(outside, 'secret.txt'), 'nope');
        await expect(readFile(wsRoot, '../conf-out/secret.txt')).rejects.toThrow(
            /escapes workspace/i,
        );
    });

    it('rejects an ABSOLUTE path for a NON-system read (system flag false)', async () => {
        markDesktopRuntime();
        const wsRoot = makeTmpDir('conf-ws2');
        const outside = makeTmpDir('conf-out2');
        const secret = path.join(outside, 'secret.txt');
        fs.writeFileSync(secret, 'nope');
        // Absolute path, but system=false → confined → escapes → rejected.
        await expect(readFile(wsRoot, secret, false)).rejects.toThrow(/escapes workspace/i);
    });
});

describe('headless can NEVER get system full-FS (HARD constraint)', () => {
    it('denies an absolute system read under the headless runtime', async () => {
        markHeadlessRuntime();
        const wsRoot = makeTmpDir('hl-ws');
        const outside = makeTmpDir('hl-out');
        const secret = path.join(outside, 'secret.txt');
        fs.writeFileSync(secret, 'nope');
        // system:true is IGNORED headless — the confined guard rejects the escape.
        await expect(readFile(wsRoot, secret, true)).rejects.toThrow(/escapes workspace/i);
    });

    it('denies a system tree that would escape the workspace under headless', async () => {
        markHeadlessRuntime();
        const wsRoot = makeTmpDir('hl-ws2');
        const outside = makeTmpDir('hl-out2');
        // system:true is ignored headless; `root` is treated as a confined
        // subfolder and an absolute path escapes → throws.
        await expect(listTree(wsRoot, { system: true, root: outside })).rejects.toThrow(
            /escapes workspace/i,
        );
    });
});

/**
 * genie#466 — a drive letter that does not answer must not stall the tree.
 *
 * The reported symptom was a slow, flaky TEST. The cause turned out to be in the
 * product: `fsp.access('A:\')` blocks for TWENTY-ONE SECONDS on a machine with
 * no floppy drive, because Windows retries the absent removable device before
 * giving up. Every Windows user opening the System workspace's file tree paid
 * that, and the test was only the thing that noticed.
 *
 * A letter is probed with a bound, and the probes run together, so one
 * unreachable device — a legacy A:/B:, a disconnected network mapping — costs
 * the bound once instead of its full retry, serially.
 */
describe('drive probing is bounded (genie#466)', () => {
    const never = () => new Promise<void>(() => {});

    it('drops a letter that does not answer within the bound', async () => {
        const drives = await listWindowsDrives(
            (root) => (root.startsWith('A:') ? never() : Promise.resolve()),
            20,
        );
        // A: hung, so it is not reported...
        expect(drives).not.toContain('A:');
        // ...and the letters that DID answer still are. Without this the
        // assertion above would pass against a probe that returned nothing.
        expect(drives).toContain('C:');
        expect(drives).toContain('Z:');
    });

    it('does not wait for the hung letter serially', async () => {
        const started = Date.now();
        await listWindowsDrives((root) => (root.startsWith('A:') ? never() : Promise.resolve()), 40);
        // One bound, not 26 of them: probes run together. Generous, because this
        // asserts a shape (concurrent, not sequential) and not a stopwatch.
        expect(Date.now() - started).toBeLessThan(40 * 5);
    });

    it('reports every letter when the machine answers for all of them', async () => {
        const drives = await listWindowsDrives(() => Promise.resolve(), 50);
        expect(drives).toHaveLength(26);
        expect(drives[0]).toBe('A:');
        expect(drives[25]).toBe('Z:');
    });

    it('keeps the letters in order when only some answer', async () => {
        const present = new Set(['C:', 'G:', 'H:']);
        const drives = await listWindowsDrives(
            (root) => (present.has(root.slice(0, 2)) ? Promise.resolve() : Promise.reject(new Error('nope'))),
            50,
        );
        expect(drives).toEqual(['C:', 'G:', 'H:']);
    });
});
