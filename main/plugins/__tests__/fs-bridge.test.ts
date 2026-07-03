import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
    resolvePluginPath,
    writePluginBinary,
    readPluginBinary,
    writePluginText,
} from '../../files/ipc';
import { runPluginFsOp } from '../fs-bridge';
import type { PluginManifest } from '../manifest';
import type { PluginGrants } from '../../db';

/**
 * The Plugin System Phase-1 FS capability gate — the security seam deliverable
 * #2 asks for. Covers BOTH layers:
 *   - the guard-resolving, extension-limited helpers in `files/ipc.ts`
 *     (writePluginBinary / readPluginBinary / resolvePluginPath), and
 *   - the grant/scope/root gate in `fs-bridge.ts` (runPluginFsOp).
 * The focus is FAIL-CLOSED: a path escape, a disallowed extension, an empty
 * allow-list, an undeclared or ungranted capability, or a missing workspace all
 * refuse the write — nothing lands outside the granting workspace + extensions.
 */

let root: string;

beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-fsbridge-'));
});
afterAll(() => {
    try {
        fs.rmSync(root, { recursive: true, force: true });
    } catch {
        /* best-effort */
    }
});

const EXTS = ['.pptx', '.odp'];

describe('resolvePluginPath + guarded helpers (files/ipc.ts)', () => {
    it('writes bytes within scope and round-trips them', async () => {
        const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]);
        const w = await writePluginBinary(root, 'sub/deck.pptx', bytes, EXTS);
        expect(w.ok).toBe(true);
        expect(w.relPath).toBe('sub/deck.pptx');
        expect(w.bytes).toBe(bytes.length);
        expect(fs.existsSync(path.join(root, 'sub', 'deck.pptx'))).toBe(true);

        const r = await readPluginBinary(root, 'sub/deck.pptx', EXTS);
        expect(Buffer.from(r.base64, 'base64').equals(bytes)).toBe(true);
    });

    it('rejects a `..` escape (fail-closed)', async () => {
        await expect(writePluginBinary(root, '../escape.pptx', Buffer.from([1]), EXTS)).rejects.toThrow(
            /escapes workspace/i,
        );
    });

    it('rejects a disallowed extension', () => {
        expect(() => resolvePluginPath(root, 'note.txt', EXTS)).toThrow(/not in this plugin/i);
    });

    it('rejects an EMPTY extension allow-list (fail-closed)', () => {
        expect(() => resolvePluginPath(root, 'deck.pptx', [])).toThrow(/No file extensions are granted/i);
    });

    it('rejects the workspace root itself', () => {
        expect(() => resolvePluginPath(root, '', EXTS)).toThrow(/Invalid path/i);
    });

    it('normalises extensions (case + missing dot) before matching', async () => {
        // Allow-list given without a dot / uppercase still matches `.pptx`.
        const w = await writePluginText(root, 'a.pptx', 'x', ['PPTX']);
        expect(w.ok).toBe(true);
    });
});

function manifest(over: Partial<PluginManifest> = {}): PluginManifest {
    return {
        id: 'ai.genie.presentation',
        namespace: 'presentation',
        name: 'Presentation',
        version: '0.1.0',
        entry: { tools: 'tools.cjs' },
        capabilities: { fs: { scope: 'workspace', extensions: EXTS } },
        ...over,
    };
}

const GRANTED: PluginGrants = { fs: { workspace: true }, network: {}, genieApi: {} };
const UNGRANTED: PluginGrants = { fs: {}, network: {}, genieApi: {} };

function b64(bytes: number[]): string {
    return Buffer.from(bytes).toString('base64');
}

describe('runPluginFsOp — grant/scope/root gate (fs-bridge.ts)', () => {
    it('DENIES when the manifest does not declare fs (fail-closed)', async () => {
        const m = manifest({ capabilities: { fs: { scope: 'none' } } });
        const r = await runPluginFsOp(m, GRANTED, root, 'fs.writeBytes', { rel: 'a.pptx', base64: b64([1]) });
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/not declared/i);
    });

    it('DENIES when the fs capability is not granted (fail-closed)', async () => {
        const r = await runPluginFsOp(manifest(), UNGRANTED, root, 'fs.writeBytes', {
            rel: 'a.pptx',
            base64: b64([1]),
        });
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/not granted/i);
    });

    it('DENIES when no workspace root is resolved (fail-closed)', async () => {
        const r = await runPluginFsOp(manifest(), GRANTED, null, 'fs.writeBytes', {
            rel: 'a.pptx',
            base64: b64([1]),
        });
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/no workspace/i);
    });

    it('DENIES a disallowed extension even when granted', async () => {
        const r = await runPluginFsOp(manifest(), GRANTED, root, 'fs.writeBytes', {
            rel: 'evil.exe',
            base64: b64([1]),
        });
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/not in this plugin/i);
    });

    it('DENIES a path escape even when granted', async () => {
        const r = await runPluginFsOp(manifest(), GRANTED, root, 'fs.writeBytes', {
            rel: '../out.pptx',
            base64: b64([1]),
        });
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/escapes workspace/i);
    });

    it('WRITES + reads back bytes when declared, granted, scoped, and allowed', async () => {
        const bytes = [0x50, 0x4b, 0x03, 0x04, 9, 9];
        const w = await runPluginFsOp(manifest(), GRANTED, root, 'fs.writeBytes', {
            rel: 'ok/deck.pptx',
            base64: b64(bytes),
        });
        expect(w.ok).toBe(true);
        expect((w.value as { relPath: string }).relPath).toBe('ok/deck.pptx');
        expect(fs.existsSync(path.join(root, 'ok', 'deck.pptx'))).toBe(true);

        const r = await runPluginFsOp(manifest(), GRANTED, root, 'fs.readBytes', { rel: 'ok/deck.pptx' });
        expect(r.ok).toBe(true);
        expect(Buffer.from((r.value as { base64: string }).base64, 'base64').equals(Buffer.from(bytes))).toBe(true);
    });
});
