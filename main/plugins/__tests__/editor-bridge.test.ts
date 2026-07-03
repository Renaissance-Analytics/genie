import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runPluginFsOp } from '../fs-bridge';
import type { PluginManifest } from '../manifest';
import { emptyPluginGrants, type PluginGrants } from '../../db';

/**
 * Phase-2 binary bridge (§6.2/§12.4): the plugin editor opens/saves its document
 * through `runPluginFsOp` — the SAME guarded, extension-limited gate the worker fs
 * bridge uses. This exercises the open/save ROUND-TRIP (writeBytes then readBytes
 * returns identical bytes) and the fail-closed cases the editor host relies on.
 */

const manifest: PluginManifest = {
    id: 'ai.genie.presentation',
    namespace: 'presentation',
    name: 'Presentation',
    version: '1.0.0',
    capabilities: { fs: { scope: 'workspace', extensions: ['.pptx', '.odp'] } },
};

function granted(): PluginGrants {
    const g = emptyPluginGrants();
    g.fs.workspace = true;
    return g;
}

let root: string;
beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-editor-bridge-'));
});
afterAll(() => {
    try {
        fs.rmSync(root, { recursive: true, force: true });
    } catch {
        /* best-effort */
    }
});

// Arbitrary binary payload (a PK zip header + noise) — proves byte fidelity.
const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01, 0x02, 0xfe, 0xff, 0x7f]);
const base64 = bytes.toString('base64');

describe('plugin editor binary bridge (runPluginFsOp)', () => {
    it('writes then reads back identical bytes (save/open round-trip)', async () => {
        const w = await runPluginFsOp(manifest, granted(), root, 'fs.writeBytes', {
            rel: 'deck.pptx',
            base64,
        });
        expect(w.ok).toBe(true);

        const r = await runPluginFsOp(manifest, granted(), root, 'fs.readBytes', {
            rel: 'deck.pptx',
        });
        expect(r.ok).toBe(true);
        expect((r.value as { base64: string }).base64).toBe(base64);
    });

    it('fails closed when the fs capability is not granted', async () => {
        const r = await runPluginFsOp(manifest, emptyPluginGrants(), root, 'fs.writeBytes', {
            rel: 'deck.pptx',
            base64,
        });
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/not granted/i);
    });

    it('fails closed on an extension outside the granted allow-list', async () => {
        const r = await runPluginFsOp(manifest, granted(), root, 'fs.writeBytes', {
            rel: 'secret.txt',
            base64,
        });
        expect(r.ok).toBe(false);
    });

    it('fails closed on a path escaping the workspace', async () => {
        const r = await runPluginFsOp(manifest, granted(), root, 'fs.readBytes', {
            rel: '../deck.pptx',
        });
        expect(r.ok).toBe(false);
    });
});
