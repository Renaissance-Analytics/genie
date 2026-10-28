import { describe, expect, it, vi } from 'vitest';
import { classifyConnectLink, dispatchConnectLink } from '../src/core/connect-link.js';

/**
 * WHAT SOMEBODY PASTED INTO "Open a share link…" (genie#1278 row C1). Genie 1's `main/tynn/connect-link.ts` and
 * `connect-dispatch.ts` (v0.7.0-beta.342), ported: a Tynn invite URL is opened in the browser to be accepted (Tynn's page
 * then opens `genie://workstation/open?id=…`, which Genie 2 already handles); a `genie://workstation/open` link opens the
 * workstation straight away. Anything else is refused with a sentence, never silently. The host check is load-bearing:
 * accepting any https URL would make the box a way to get Genie to open an arbitrary page.
 */

const TYNN = 'https://tynn.ai';

describe('classifying a pasted link', () => {
    it('a Tynn invite on this Genie’s Tynn', () => {
        expect(classifyConnectLink('https://tynn.ai/invites/accept/abc123', TYNN)).toEqual({ kind: 'invite', url: 'https://tynn.ai/invites/accept/abc123' });
        expect(classifyConnectLink('  https://tynn.ai/invites/accept/abc  \n', TYNN)).toEqual({ kind: 'invite', url: 'https://tynn.ai/invites/accept/abc' });
    });

    it('a genie://workstation/open link, with its name when it has one', () => {
        expect(classifyConnectLink('genie://workstation/open?id=ws_1&name=studio', TYNN)).toEqual({ kind: 'workstation', workstationId: 'ws_1', name: 'studio' });
        expect(classifyConnectLink('genie://workstation/open?id=ws_1', TYNN)).toEqual({ kind: 'workstation', workstationId: 'ws_1' });
    });

    it('refuses, with a reason: empty, not a link, another Tynn, a Tynn page that is not an invite, a sign-in genie:// link, no id', () => {
        for (const raw of ['', 'hello', 'https://evil.example/invites/accept/abc', 'https://tynn.ai/dashboard', 'https://tynn.ai/invites/accept/', 'genie://oauth/callback?token=x', 'genie://workstation/open']) {
            const out = classifyConnectLink(raw, TYNN);
            expect(out.kind, raw).toBe('unknown');
            if (out.kind === 'unknown') expect(out.reason.length, raw).toBeGreaterThan(10);
        }
        const other = classifyConnectLink('https://evil.example/invites/accept/abc', TYNN);
        expect(other.kind === 'unknown' && other.reason).toContain('evil.example');
    });

    it('an id that is not a workstation id is refused (the same rule as the genie:// handler)', () => {
        expect(classifyConnectLink('genie://workstation/open?id=../../x', TYNN).kind).toBe('unknown');
    });
});

describe('acting on it', () => {
    const deps = () => ({ openExternal: vi.fn(async () => true), openWorkstation: vi.fn() });

    it('an invite opens in the browser, and says what happens next', async () => {
        const d = deps();
        const out = await dispatchConnectLink('https://tynn.ai/invites/accept/tok', TYNN, 'pilot', d);
        expect(d.openExternal).toHaveBeenCalledWith('https://tynn.ai/invites/accept/tok');
        expect(d.openWorkstation).not.toHaveBeenCalled();
        expect(out.ok).toBe(true);
        expect(out.note).toContain('browser');
    });

    it('a workstation link opens the workstation', async () => {
        const d = deps();
        const out = await dispatchConnectLink('genie://workstation/open?id=ws_1&name=studio', TYNN, null, d);
        expect(d.openWorkstation).toHaveBeenCalledWith('ws_1', 'studio');
        expect(out).toEqual({ ok: true, note: 'Opening studio in its own window' });
    });

    it('the browser refused: says so', async () => {
        const d = { ...deps(), openExternal: vi.fn(async () => false) };
        expect((await dispatchConnectLink('https://tynn.ai/invites/accept/tok', TYNN, 'pilot', d)).ok).toBe(false);
    });

    it('a link it does not recognise opens nothing', async () => {
        const d = deps();
        const out = await dispatchConnectLink('https://evil.example/invites/accept/x', TYNN, 'pilot', d);
        expect(out.ok).toBe(false);
        expect(d.openExternal).not.toHaveBeenCalled();
        expect(d.openWorkstation).not.toHaveBeenCalled();
    });

    it('signed out of Tynn: nothing opens, and it says to sign in', async () => {
        const d = deps();
        const out = await dispatchConnectLink('https://tynn.ai/invites/accept/tok', null, null, d);
        expect(out.ok).toBe(false);
        expect(out.note).toContain('Sign in to Tynn');
        expect(d.openExternal).not.toHaveBeenCalled();
    });

    it('a drone opens nothing — Tynn refuses its connect-grant — and says why', async () => {
        const d = deps();
        for (const link of ['https://tynn.ai/invites/accept/tok', 'genie://workstation/open?id=ws_1']) {
            const out = await dispatchConnectLink(link, TYNN, 'drone', d);
            expect(out.ok).toBe(false);
            expect(out.note).toContain('drone');
        }
        expect(d.openExternal).not.toHaveBeenCalled();
        expect(d.openWorkstation).not.toHaveBeenCalled();
    });
});
