import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { listTree, readFile, writeFile, type TreeNodeData } from '../ipc';
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
afterEach(() => _resetRuntimeModeForTest());

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

    it('desktop system top-level tree is the machine root(s) (drives / /)', async () => {
        markDesktopRuntime();
        const wsRoot = makeTmpDir('sys-ws3');
        const tree = await listTree(wsRoot, { system: true });
        expect(Array.isArray(tree)).toBe(true);
        // Every top-level id is absolute (a drive like `C:/` or the POSIX root).
        for (const n of tree) {
            expect(path.isAbsolute(n.id) || /^[A-Za-z]:\/$/.test(n.id)).toBe(true);
        }
    });
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
