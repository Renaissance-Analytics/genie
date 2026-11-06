import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LinuxKeyring, type KeyringFacts, type KeyringPorts } from '../src/main/linux-keyring.js';
import { SettingsSurface } from '../src/renderer/components/FeatureSurfaces.js';
import { EMPTY_FEATURES, type FeatureData } from '../src/renderer/features.js';
import { signedOutGithubView } from '../src/core/github.js';

/**
 * GENIE ASKS TO UNLOCK THE KEYRING ITSELF (Tynn story #388; the owner: "I need genie to request unlocking the keyring when
 * it starts on linux. don't make a user understand how to do that").
 *
 * A locked default collection used to read "Unlock it, then Check again" — instructions the person had to know how to
 * follow. Now, at start and from the card, Genie calls the Secret Service's own Unlock on the default collection; when
 * it answers with a prompt, Genie asks for that prompt and waits for its Completed signal. The desktop draws its own
 * dialog: Genie never asks for or sees the password. Unlocked, everything carries on with NO restart. Dismissed: "Your
 * keyring is still locked" and one Unlock button that asks again. Never manual steps.
 *
 * Reached loosely ON PURPOSE: before the module and the port exist these are red by assertion, not by an import error.
 */
const UNLOCK_MODULE = '../src/core/keyring-unlock.js';
const unlock: Record<string, unknown> = await import(/* @vite-ignore */ UNLOCK_MODULE).catch(() => ({}));
const fn = <T,>(name: string): T => {
    expect(unlock[name], `${name} in core/keyring-unlock.ts`).toBeTypeOf('function');
    return unlock[name] as T;
};
const DEFAULT = '/org/freedesktop/secrets/aliases/default';

describe('the call plan (pure)', () => {
    it('first: org.freedesktop.Secret.Service.Unlock([default collection]) on /org/freedesktop/secrets', () => {
        const first = fn<() => unknown>('unlockCall')();
        expect(first).toEqual({ path: '/org/freedesktop/secrets', iface: 'org.freedesktop.Secret.Service', member: 'Unlock', args: [[DEFAULT]] });
    });

    it('a prompt path that is not "/" is asked with Prompt(\'\') and its Completed signal awaited; "/" means it is already done', () => {
        const next = fn<(reply: { unlocked: string[]; prompt: string }) => unknown>('afterUnlockReply');
        expect(next({ unlocked: [DEFAULT], prompt: '/' })).toEqual({ done: 'unlocked' });
        expect(next({ unlocked: [], prompt: '/org/freedesktop/secrets/prompt/u7' })).toEqual({
            prompt: { path: '/org/freedesktop/secrets/prompt/u7', iface: 'org.freedesktop.Secret.Prompt', member: 'Prompt', args: [''] },
            wait: { path: '/org/freedesktop/secrets/prompt/u7', iface: 'org.freedesktop.Secret.Prompt', member: 'Completed' },
        });
    });

    it('the outcome: Completed(dismissed=false) is unlocked, Completed(dismissed=true) is dismissed, an error is failed', () => {
        const outcome = fn<(e: unknown) => string>('unlockOutcome');
        expect(outcome({ kind: 'completed', dismissed: false })).toBe('unlocked');
        expect(outcome({ kind: 'completed', dismissed: true })).toBe('dismissed');
        expect(outcome({ kind: 'error', message: 'no bus' })).toBe('failed');
    });
});

/** A session whose default collection is locked until `unlock` succeeds. */
function session(answer: 'unlocked' | 'dismissed' | 'failed') {
    let unlocked = false;
    const calls = { unlock: 0, relaunch: 0, exec: 0 };
    const facts = (): Omit<KeyringFacts, 'platform'> => ({ installed: true, owned: true, activatable: true, backend: 'gnome_libsecret', available: unlocked });
    const ports = {
        platform: 'linux' as const,
        facts: async () => facts(),
        plan: async () => ({ run: null, manual: null, packages: ['gnome-keyring'] }),
        exec: async () => { calls.exec += 1; return { code: 0, stderr: '' }; },
        relaunch: () => { calls.relaunch += 1; },
        unlock: async () => { calls.unlock += 1; if (answer === 'unlocked') unlocked = true; return answer; },
    };
    return { ports: ports as unknown as KeyringPorts, calls, unlockNext: (a: typeof answer) => { answer = a; } };
}
const settle = () => new Promise((r) => setTimeout(r, 0));
const openWith = LinuxKeyring.open as unknown as (ports: KeyringPorts, options: { unlockAtStart: boolean }) => Promise<LinuxKeyring>;

describe('at start, and from the card', () => {
    it('a locked keyring at start: Genie asks once by itself; unlocked, it is ready — and NO restart is asked for', async () => {
        const s = session('unlocked');
        const k = await openWith(s.ports, { unlockAtStart: true });
        await k.fix().catch(() => {}); // joins the start's ask if it still runs
        await settle();
        expect(s.calls.unlock).toBe(1);
        expect(k.state()).toBe('ready');
        expect(k.view()).toBeNull();
        expect(s.calls.relaunch).toBe(0);
        expect(s.calls.exec).toBe(0);
    });

    it('dismissed: "Your keyring is still locked", never manual steps; the button asks again (COUNTED: two asks)', async () => {
        const s = session('dismissed');
        const k = await openWith(s.ports, { unlockAtStart: true });
        await k.fix();
        await settle();
        const view = k.view();
        expect(view?.state).toBe('refused');
        expect(view?.failure).toBe('Your keyring is still locked');
        expect(view?.manual).toBeNull();
        expect(view?.failure).not.toMatch(/Unlock it|Check again|then restart/);
        expect(s.calls.unlock).toBeGreaterThanOrEqual(2);
        s.unlockNext('unlocked');
        await k.fix();
        expect(k.state()).toBe('ready');
        expect(s.calls.relaunch).toBe(0);
    });
});

const integrations: NonNullable<FeatureData['integrations']> = {
    tynnSignedIn: false,
    tynn: { host: 'https://tynn.ai', user: null, signInUrl: null, message: null },
    github: signedOutGithubView(null),
    gated: [],
    lastSync: null,
    mcp: { url: null, verified: null },
};
const card = (keyring: NonNullable<NonNullable<FeatureData['integrations']>['keyring']>) =>
    renderToStaticMarkup(<SettingsSurface data={{ ...EMPTY_FEATURES, settings: { values: {} }, remote: null, integrations: { ...integrations, keyring } }} onAction={() => {}} onNavigate={() => {}} section="tynn" workspaces={[]} />);

describe('the card’s words', () => {
    const base = { manual: null, packages: 'gnome-keyring' };
    it('while asking: "Genie is asking to unlock your keyring", busy', () => {
        const html = card({ state: 'refused', step: 'unlocking' as never, failure: null, ...base });
        expect(html).toContain('Genie is asking to unlock your keyring');
        expect(html).toMatch(/data-action="keyring-fix"[^>]*aria-busy="true"/);
    });
    it('locked, or dismissed: one Unlock button, no instructions', () => {
        const html = card({ state: 'refused', step: null, failure: 'Your keyring is still locked', ...base });
        expect(html).toMatch(/data-action="keyring-fix"[^>]*>(?:<[^>]+>)*Unlock</);
        expect(html).toContain('Your keyring is still locked');
        expect(html).not.toMatch(/Check again|Unlock it,/);
    });
});
