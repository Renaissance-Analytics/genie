import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { upgradeHost, type HostUpgradeStep } from '../src/core/host-upgrade.js';
import { ConnectRemote } from '../src/renderer/components/FeatureSurfaces.js';

/**
 * UPGRADE A REMOTE HOST FROM HERE (Tynn #822; Genie 1's remote.upgradeHost — owner only). Genie 2's remote protocol already
 * carried the host's own updater (updates.check / download / install, refused to a shared-workspace guest); nothing drove
 * it. Genie 1's flow: check — up to date ends it; install — the host restarts and the link DROPS, which is EXPECTED, so the
 * client reconnects until the host is back, or gives up and says so.
 */
type Phase = 'none' | 'available' | 'error';
function fakes(opts: { phase: Phase; download?: boolean; install?: boolean; backAfter?: number }) {
    const steps: HostUpgradeStep[] = [];
    let now = 0;
    let attempts = 0;
    return {
        steps,
        run: () => upgradeHost({
            updates: {
                check: async () => ({ phase: opts.phase, version: opts.phase === 'available' ? '2.0.0-beta.33' : null, error: opts.phase === 'error' ? 'no network' : null }),
                download: async () => opts.download ?? true,
                install: () => ((opts.install ?? true) ? { report: 'draining' } : null),
            },
            reconnect: async () => { attempts += 1; return opts.backAfter !== undefined && attempts >= opts.backAfter; },
            sleep: async (ms) => { now += ms; },
            now: () => now,
            onStep: (s) => steps.push(s),
            retryMs: 3_000,
            giveUpMs: 300_000,
        }),
    };
}

describe('upgradeHost — the flow', () => {
    it('up to date: checks, says so, installs nothing', async () => {
        const f = fakes({ phase: 'none' });
        expect(await f.run()).toEqual({ kind: 'up-to-date' });
        expect(f.steps.map((s) => s.kind)).toEqual(['checking', 'up-to-date']);
    });

    it('an update: download, install, the EXPECTED drop, reconnecting until the host is back — done, with the version', async () => {
        const f = fakes({ phase: 'available', backAfter: 4 });
        expect(await f.run()).toEqual({ kind: 'done', version: '2.0.0-beta.33' });
        expect(f.steps.map((s) => s.kind)).toEqual(['checking', 'downloading', 'installing', 'reconnecting', 'done']);
    });

    it('the host never comes back: gives up after giveUpMs and says it is lost — never spins forever', async () => {
        const f = fakes({ phase: 'available' });
        const end = await f.run();
        expect(end).toEqual({ kind: 'lost', version: '2.0.0-beta.33' });
    });

    it('the updater errs, the download fails, or the host refuses the install: failed, in words — and nothing after', async () => {
        expect(await fakes({ phase: 'error' }).run()).toEqual({ kind: 'failed', reason: 'the host’s updater says: no network' });
        expect(await fakes({ phase: 'available', download: false }).run()).toEqual({ kind: 'failed', reason: 'the host could not download 2.0.0-beta.33' });
        const refused = fakes({ phase: 'available', install: false });
        expect(await refused.run()).toEqual({ kind: 'failed', reason: 'the host refused to install 2.0.0-beta.33' });
        expect(refused.steps.map((s) => s.kind)).not.toContain('reconnecting');
    });
});

describe('the connected bar — Upgrade <host>', () => {
    const connected = { connected: true, host: 'studio', isOwner: true, workspaceId: null, driving: true, driver: 'you', locked: false, lastRefusal: null, token: null };
    const render = (extra: Record<string, unknown>) =>
        renderToStaticMarkup(<ConnectRemote state={connected} remembered={[]} onConnect={() => {}} onDisconnect={() => {}} {...extra} />);

    it('the owner, connected: Upgrade studio', () => {
        expect(render({ onUpgradeHost: () => {} })).toMatch(/data-action="upgrade-host"[^>]*>Upgrade studio</);
    });

    it('CONTROL: not the owner (a shared workspace) — no Upgrade (the host would refuse it)', () => {
        expect(render({ state: { ...connected, isOwner: false }, onUpgradeHost: () => {} })).not.toContain('data-action="upgrade-host"');
    });

    it('while upgrading, the step is said in place of the button', () => {
        const html = render({ onUpgradeHost: () => {}, upgrade: { kind: 'reconnecting', version: '2.0.0-beta.33' } });
        expect(html).toMatch(/data-host-upgrade="reconnecting"[^>]*>[^<]*studio is restarting on 2\.0\.0-beta\.33/);
        expect(html).not.toContain('data-action="upgrade-host"');
    });
});
