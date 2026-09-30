import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * WIRED TO SOMETHING.
 *
 * Every layer of share-links has its own unit tests — the Tynn client, the
 * identity/error layer — and all of them pass whether or not the panel is on
 * screen or the IPC channels exist. That is the exact shape of the defect this
 * repository keeps finding: a capability that is built, tested, and connected to
 * nothing above it, with a green suite covering the PRODUCER and nothing covering
 * the boundary that carries it.
 *
 * So this walks the chain the user's click actually travels:
 *
 *   panel mounted → api().workspaces.<method> → preload channel → ipcMain.handle
 *
 * A break anywhere along it is the failure "I have no UX to share a workspace"
 * describes, and no behavioural test in this repo would notice.
 */
const root = join(__dirname, '..', '..', '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

const CHANNELS = [
    'workspaces:share-link-availability',
    'workspaces:mint-share-link',
    'workspaces:list-share-links',
    'workspaces:revoke-share-link',
];

const API_METHODS = [
    'shareLinkAvailability',
    'mintShareLink',
    'listShareLinks',
    'revokeShareLink',
];

describe('the share-link chain is connected end to end', () => {
    it('mounts the panel in workspace settings', () => {
        // The owner asked for this specifically: "a link manager in the workspace
        // settings so users can invalidate links on demand."
        const modal = read('renderer/components/Master/WorkspaceSettingsModal.tsx');

        expect(modal).toContain('function WorkspaceSharePanel(');
        expect(modal).toMatch(/<WorkspaceSharePanel\s+workspaceId=\{workspace\.id\}\s*\/>/);
    });

    it.each(API_METHODS)('exposes %s on the renderer api', (method) => {
        const preload = read('main/preload.ts');
        const types = read('renderer/lib/genie.ts');

        expect(preload).toContain(`${method}:`);
        expect(types).toContain(`${method}:`);
    });

    it.each(CHANNELS)('handles %s in main', (channel) => {
        const preload = read('main/preload.ts');
        const ipc = read('main/ipc.ts');

        // Both ends of the SAME string. A channel invoked but never handled hangs
        // the promise forever, which in the panel looks like a button that does
        // nothing at all.
        expect(preload).toContain(`'${channel}'`);
        // Whitespace-tolerant: a handler whose argument list wrapped onto the next
        // line is still a handler, and a guard that fails on formatting is a guard
        // people delete.
        expect(ipc).toMatch(new RegExp(String.raw`ipcMain\.handle\(\s*'${channel}'`));
    });

    it('routes every panel call through the api surface, never a bare invoke', () => {
        // A renderer component reaching ipcRenderer directly bypasses the typed
        // surface, so a renamed channel type-checks clean and breaks at runtime.
        const modal = read('renderer/components/Master/WorkspaceSettingsModal.tsx');
        const panel = modal.slice(
            modal.indexOf('function WorkspaceSharePanel('),
            modal.indexOf('function Section({'),
        );

        expect(panel).not.toContain('ipcRenderer');
        for (const method of API_METHODS) {
            expect(panel).toContain(`api().workspaces.${method}(`);
        }
    });

    it('never optimistically drops a link the service still holds', () => {
        // A revoke that failed must not look like one that worked: this panel's
        // only real job is telling the owner the truth about what is still live.
        const modal = read('renderer/components/Master/WorkspaceSettingsModal.tsx');
        const revoke = modal.slice(modal.indexOf('const revoke = async ('));
        const body = revoke.slice(0, revoke.indexOf('\n    };'));

        expect(body).toContain('await load()');
        expect(body).not.toMatch(/setLinks\(/);
    });
});
