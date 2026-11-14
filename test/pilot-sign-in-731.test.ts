import { describe, expect, it, vi } from 'vitest';
import { RESTRICTED_CALL_CONTEXT, type CallContext } from '../src/core/remote-protocol.js';

// Tynn #731: a Pilot signs in for the drone it drives; the link opens on the PILOT's screen, over ITS connection.
// The module is loaded inside each test so a missing module fails each test, not the whole file.
const modulePath = '../src/main/pilot-sign-in.js';
const load = () => import(/* @vite-ignore */ modulePath) as Promise<typeof import('../src/main/pilot-sign-in.js')>;

const caller = (over: Partial<CallContext> = {}): CallContext => Object.freeze({
    connectionId: 'pilot-1', origin: 'relay', profile: 'desktop', isOwner: true, workspaceId: null, readonly: false, label: 'laptop', ...over,
});
const remoteOrigins = ['remote-window', 'device', 'relay'] as const;

function rig() {
    const sent: Array<[string, string]> = [];
    const toPilot = vi.fn(async (id: string, url: string) => { sent.push([id, url]); });
    const local = vi.fn(async (_url: string) => {});
    const services = {
        tynnStart: vi.fn(async () => ({ url: 'https://tynn.ai/device?code=T1', code: 'T1' })),
        githubStart: vi.fn(async (open: ((url: string) => Promise<void>) | null) => { if (open) await open('https://github.com/login/device'); }),
        githubOpenPage: vi.fn(async (_target: string, open: (url: string) => Promise<void>) => { await open('https://github.com/settings/installations'); }),
        tailscaleUp: vi.fn(async () => ({ authUrl: 'https://login.tailscale.com/a/abc' as string | null })),
        tailscaleInstall: vi.fn(async () => ({ url: 'https://tailscale.com/download' as string | null })),
    };
    return { sent, toPilot, local, services };
}

describe('a Pilot caller’s sign-in link goes over its own connection (Tynn #731)', () => {
    it.each(remoteOrigins)('an owner over %s: the URL is sent to that connection and the drone’s local opener is not called', async origin => {
        const { signInOpener } = await load(); const r = rig();
        const open = signInOpener(caller({ origin }), r.local, r.toPilot)!;
        await open('https://github.com/login/device');
        expect(r.sent).toEqual([['pilot-1', 'https://github.com/login/device']]);
        expect(r.local).not.toHaveBeenCalled();
    });
    it('a guest of the whole workstation is a Pilot too', async () => {
        const { signInOpener } = await load(); const r = rig();
        await signInOpener(caller({ isOwner: false, workspaceId: null }), undefined, r.toPilot)!('https://tynn.ai/x');
        expect(r.sent).toEqual([['pilot-1', 'https://tynn.ai/x']]);
    });
    it('CONTROL: this machine’s own window uses its own opener and never the Pilot path', async () => {
        const { signInOpener } = await load(); const r = rig();
        await signInOpener(caller({ origin: 'local-window' }), r.local, r.toPilot)!('https://tynn.ai/x');
        expect(r.local).toHaveBeenCalledExactlyOnceWith('https://tynn.ai/x');
        expect(r.toPilot).not.toHaveBeenCalled();
        expect(signInOpener(caller({ origin: 'local-window' }), undefined, r.toPilot)).toBeNull();
    });
    it('a guest of one workspace is refused in words and nothing is sent', async () => {
        const { signInOpener } = await load(); const r = rig();
        expect(() => signInOpener(caller({ isOwner: false, workspaceId: 'tynn' }), r.local, r.toPilot)).toThrow(/guest of one workspace.*cannot sign in/i);
        expect(r.toPilot).not.toHaveBeenCalled(); expect(r.local).not.toHaveBeenCalled();
    });
    it('a read-only caller is refused in words, owner or not', async () => {
        const { signInOpener } = await load(); const r = rig();
        expect(() => signInOpener(caller({ readonly: true }), r.local, r.toPilot)).toThrow(/read-only.*cannot sign in/i);
        expect(r.toPilot).not.toHaveBeenCalled();
    });
    it('an unidentified caller is refused', async () => {
        const { signInOpener } = await load(); const r = rig();
        expect(() => signInOpener(RESTRICTED_CALL_CONTEXT, r.local, r.toPilot)).toThrow(/cannot sign in/i);
    });
});

describe('every sign-in effect uses the caller’s opener (Tynn #731)', () => {
    it('GitHub sign-in: the opener the drone’s account service gets sends to the Pilot, never the drone’s browser', async () => {
        const { signInEffectsFor } = await load(); const r = rig();
        await signInEffectsFor(caller(), r.local, r.toPilot, r.services).githubStart();
        expect(r.sent).toEqual([['pilot-1', 'https://github.com/login/device']]);
        expect(r.local).not.toHaveBeenCalled();
    });
    it('Tynn sign-in: the answer (with its code) returns to the Pilot and its URL is sent there', async () => {
        const { signInEffectsFor } = await load(); const r = rig();
        expect(await signInEffectsFor(caller(), r.local, r.toPilot, r.services).tynnStart()).toEqual({ url: 'https://tynn.ai/device?code=T1', code: 'T1' });
        expect(r.sent).toEqual([['pilot-1', 'https://tynn.ai/device?code=T1']]);
        expect(r.local).not.toHaveBeenCalled();
    });
    it('Tailscale auth URL goes to the Pilot; no URL means nothing is sent', async () => {
        const { signInEffectsFor } = await load(); const r = rig();
        await signInEffectsFor(caller(), r.local, r.toPilot, r.services).tailscaleUp();
        expect(r.sent).toEqual([['pilot-1', 'https://login.tailscale.com/a/abc']]);
        r.services.tailscaleUp.mockResolvedValueOnce({ authUrl: null });
        await signInEffectsFor(caller(), r.local, r.toPilot, r.services).tailscaleUp();
        expect(r.sent).toHaveLength(1);
        expect(r.local).not.toHaveBeenCalled();
    });
    it('GitHub pages and the Tailscale installer page open on the Pilot', async () => {
        const { signInEffectsFor } = await load(); const r = rig();
        const effects = signInEffectsFor(caller({ origin: 'device' }), r.local, r.toPilot, r.services);
        await effects.githubOpen('installations'); await effects.tailscaleInstall();
        expect(r.sent).toEqual([['pilot-1', 'https://github.com/settings/installations'], ['pilot-1', 'https://tailscale.com/download']]);
        expect(r.local).not.toHaveBeenCalled();
    });
    it('a guest is refused BEFORE any sign-in starts, for all five effects', async () => {
        const { signInEffectsFor } = await load(); const r = rig();
        const effects = signInEffectsFor(caller({ isOwner: false, workspaceId: 'tynn' }), r.local, r.toPilot, r.services);
        for (const run of [effects.tynnStart, effects.githubStart, effects.tailscaleUp, () => effects.githubOpen('installations'), effects.tailscaleInstall]) {
            await expect(run()).rejects.toThrow(/guest of one workspace.*cannot sign in/i);
        }
        for (const service of Object.values(r.services)) expect(service).not.toHaveBeenCalled();
        expect(r.toPilot).not.toHaveBeenCalled();
    });
    it('a read-only caller is refused before the Tynn sign-in starts', async () => {
        const { signInEffectsFor } = await load(); const r = rig();
        await expect(signInEffectsFor(caller({ readonly: true }), r.local, r.toPilot, r.services).tynnStart()).rejects.toThrow(/read-only/i);
        expect(r.services.tynnStart).not.toHaveBeenCalled();
    });
});
