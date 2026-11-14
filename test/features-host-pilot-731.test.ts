import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallContext } from '../src/core/remote-protocol.js';
import { CALLER_A, presentationFixture, type PresentationFixture } from './helpers/features-host-presentation.js';

// Tynn #731: GitHub's pages and Tailscale's installer open on a REMOTE Pilot's screen through the Pilot port, never in a drone window.
let f: PresentationFixture;
beforeEach(async () => { f = await presentationFixture(); });
afterEach(async () => { await f?.close(); vi.restoreAllMocks(); });
const pilot: CallContext = { ...CALLER_A, connectionId: 'pilot-9', origin: 'relay' };
const ownWindow = /caller.*own.*(?:admitted|local).*window/i;

describe('a Pilot’s sign-in pages (Tynn #731)', () => {
    it('a GitHub page is handed to the Pilot port for that caller, and no drone window is used', async () => {
        const opened: unknown[] = [];
        Object.assign(f.service.ports, { pilotPresentation: vi.fn((c: CallContext) => c.connectionId === 'pilot-9' ? { githubOpen: async (t: unknown) => { opened.push(t); } } : null) });
        await f.answer({ kind: 'integrations.githubOpen', target: { page: 'authorizations' } }, pilot);
        expect(opened).toEqual([{ page: 'authorizations' }]);
        expect(f.calls).toEqual([]);
    });
    it('the Tailscale installer page is handed to the Pilot port, and no drone window is used', async () => {
        const install = vi.fn(async () => ({ url: 'https://tailscale.com/download' }));
        Object.assign(f.service.ports, { pilotPresentation: () => ({ tailscaleInstall: install }) });
        await f.answer({ kind: 'tailscale.install' }, pilot);
        expect(install).toHaveBeenCalledTimes(1);
        expect(f.calls).toEqual([]);
    });
    it('CONTROL: with no Pilot port a remote caller is still refused, and never borrows a drone window', async () => {
        expect(await f.invoke({ kind: 'integrations.githubOpen', target: { page: 'authorizations' } }, pilot))
            .toMatchObject({ ok: false, reason: expect.stringMatching(ownWindow) });
        expect(f.calls).toEqual([]);
    });
    it('the Pilot port is for sign-in pages only: a flow editor is still this machine’s own window', async () => {
        Object.assign(f.service.ports, { pilotPresentation: () => ({ githubOpen: async () => {} }) });
        expect(await f.invoke({ kind: 'flows.openEditor', flowId: 'x' }, pilot)).toMatchObject({ ok: false, reason: expect.stringMatching(ownWindow) });
        expect(f.calls).toEqual([]);
    });
    it('CONTROL: this machine’s own window still uses its own presentation, not the Pilot port', async () => {
        const pilotPort = vi.fn(() => ({ githubOpen: async () => {} }));
        Object.assign(f.service.ports, { pilotPresentation: pilotPort });
        await f.answer({ kind: 'integrations.githubOpen', target: { page: 'authorizations' } });
        expect(f.calls).toEqual([{ owner: CALLER_A.connectionId, effect: 'github', value: { page: 'authorizations' } }]);
        expect(pilotPort).not.toHaveBeenCalled();
    });
});
