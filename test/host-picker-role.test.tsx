import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import * as roles from '../src/core/workstation-role.js';
import { deviceLinkGate } from '../src/main/device-link-gate.js';
import { RelayHostReplica } from '../src/main/relay-host-replica.js';
import { RelayHostService, type RelayHostServicePorts } from '../src/main/relay-host-service.js';
import { EMPTY_FEATURES, type FeatureData } from '../src/renderer/features.js';
import { Shell } from '../src/renderer/Shell.js';
import type { GenieSnapshot } from '../src/renderer/bridge.js';

/*
 * THE HOST PICKER IN A PILOT'S TITLE BAR (beta.61 as shipped; the owner lost it). What a person sees, then what a click
 * does: the picker is there unless Tynn SAID this machine is a drone, and a click with the role not yet answered asks Tynn
 * first. Only Tynn's own "drone" is refused as a drone; no answer says Tynn could not be reached, and nothing is dialled.
 */
const snapshot = { agents: [], osAgent: null, workspaces: [{ id: 'w', path: '/w', name: 'w', agentsKnown: true, asleep: false }], deckItems: [], signals: {}, workstation: { name: 'pilot', healthy: true } } as unknown as GenieSnapshot;
const connectProps = { state: null, remembered: [], onConnect: () => {}, onDisconnect: () => {}, tynnWorkstations: { ok: true as const, workstations: [{ id: 'ws_d', name: 'drone-1', role: 'drone' }] }, onOpenWorkstation: () => {}, onOpenLink: () => {}, onRefresh: () => {} };
const titleBar = (tynnWorkstation: unknown): string => renderToStaticMarkup(
    <Shell
        route="genie://dashboard" snapshot={snapshot} servable={['dashboard', 'deck', 'agent', 'workspace']} agentDetail={null} agentResolved={false} selectedRowId={null} chatThread={null} pinned={null}
        onNavigate={() => {}} onOpenAgent={() => {}} onAddAgent={() => {}} onAddWorkspace={() => {}} onOpenPalette={() => {}} onSelectRow={() => {}} onSend={() => {}} onCloseChat={() => {}}
        answeringApproval={null} onAnswerApproval={() => {}} onAnswerDeckItem={() => {}}
        features={{ ...EMPTY_FEATURES, remote: { host: 'pilot', url: null, unavailable: 'stopped', locked: false, pin: null, devices: [], connections: [], enabled: false, firewall: true, tynnWorkstation } } as unknown as FeatureData}
        remoteConnect={connectProps as never}
    />,
);
const PICKER = 'data-system-icon="Connect"';

describe('what the person sees', () => {
    it('Tynn said pilot: the host picker is in the title bar', () => {
        expect(titleBar({ registered: true, host: 'https://tynn.ai', workstationId: 'ws_me', role: 'pilot' })).toContain(PICKER);
    });
    it('the role has not been answered: the picker is there', () => {
        expect(titleBar({ registered: true, host: 'https://tynn.ai', workstationId: 'ws_me', role: null })).toContain(PICKER);
    });
    it('before genie-host has answered at all (the replica\'s first view): the picker is there', () => {
        expect(titleBar(new RelayHostReplica(async () => null).workstation())).toContain(PICKER);
    });
    it('CONTROL: Tynn said drone: no picker', () => {
        expect(titleBar({ registered: true, host: 'https://tynn.ai', workstationId: 'ws_me', role: 'drone' })).not.toContain(PICKER);
    });
});

type Check = (reading: { role: 'pilot' | 'drone' | null; said: 'pilot' | 'drone' | null }) => string | null;
const connectOutRefusal = (roles as unknown as { connectOutRefusal: Check }).connectOutRefusal;
const gate = deviceLinkGate as unknown as (url: unknown, ports: object) => Promise<{ ok: boolean; reason?: string; channel?: string }>;
const UNREACHED = /could not reach Tynn to check this workstation’s role/;

describe('what a click does', () => {
    it('only a role Tynn answered as drone is refused as a drone', () => {
        expect(connectOutRefusal({ role: 'drone', said: 'drone' })).toMatch(/is a drone/);
        expect(connectOutRefusal({ role: 'drone', said: null })).toMatch(UNREACHED);
        expect(connectOutRefusal({ role: 'drone', said: null })).not.toMatch(/is a drone/);
        expect(connectOutRefusal({ role: 'pilot', said: 'pilot' })).toBeNull();
        // Signed out: not on the Tynn network, no Tynn role to apply.
        expect(connectOutRefusal({ role: null, said: null })).toBeNull();
    });

    const dial = (first: { role: 'pilot' | 'drone' | null; said: 'pilot' | 'drone' | null }, afterReread: typeof first) => {
        let now = first;
        const open = vi.fn(async () => ({ ok: true as const, channel: 'device_1' }));
        const reread = vi.fn(async () => { now = afterReread; });
        return { open, reread, run: () => gate('wss://drone:7421/genie', { role: () => now.role, said: () => now.said, reread, link: () => ({ open }) }) };
    };

    it('the role unknown: Tynn is asked first, and a pilot connects', async () => {
        const d = dial({ role: 'drone', said: null }, { role: 'pilot', said: 'pilot' });
        expect(await d.run()).toEqual({ ok: true, channel: 'device_1' });
        expect(d.reread).toHaveBeenCalledOnce();
        expect(d.open).toHaveBeenCalledOnce();
    });

    it('asked, and Tynn says drone: refused as a drone, nothing dialled', async () => {
        const d = dial({ role: 'drone', said: null }, { role: 'drone', said: 'drone' });
        expect(await d.run()).toMatchObject({ ok: false, reason: expect.stringMatching(/is a drone/) });
        expect(d.open).not.toHaveBeenCalled();
    });

    it('asked, and Tynn does not answer: said so, never a drone refusal, nothing dialled', async () => {
        const d = dial({ role: 'drone', said: null }, { role: 'drone', said: null });
        const r = await d.run();
        expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(UNREACHED) });
        expect(r.reason).not.toMatch(/is a drone/);
        expect(d.open).not.toHaveBeenCalled();
    });

    it('CONTROL: a known pilot is not asked again', async () => {
        const d = dial({ role: 'pilot', said: 'pilot' }, { role: 'pilot', said: 'pilot' });
        expect(await d.run()).toMatchObject({ ok: true });
        expect(d.reread).not.toHaveBeenCalled();
    });
});

describe('a role read that got no answer is read again until Tynn answers', () => {
    function service(answers: Array<'pilot' | 'drone' | null>) {
        const waits: number[] = [];
        let fire: (() => void) | null = null;
        const ports = {
            account: () => ({ host: () => 'https://tynn.test', status: () => ({ signedIn: true }), request: async () => ({}) as never }),
            workstation: { identity: async () => ({ workstationId: 'ws_me', fingerprint: 'fp' }), ensure: async () => ({ ok: true, workstationId: 'ws_me' }) as never, legacyDone: async () => null },
            enabled: () => false,
            readRole: async () => (answers.length > 1 ? answers.shift()! : answers[0]!),
            start: () => { throw new Error('not started here'); },
            onChange: () => {},
            schedule: (ms: number, fn: () => void) => { waits.push(ms); fire = fn; return () => { fire = null; }; },
        } as unknown as RelayHostServicePorts;
        return { s: new RelayHostService(ports), waits, tick: async () => { const f = fire; fire = null; f?.(); await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r)); } };
    }
    const said = (s: RelayHostService) => (s.status() as unknown as { said: unknown }).said;

    it('no answer, no answer, then pilot: it is a pilot without anyone asking, and the waits grow', async () => {
        const r = service([null, null, 'pilot']);
        await r.s.register();
        expect(said(r.s)).toBeNull();
        expect(r.waits).toHaveLength(1);
        await r.tick();
        expect(r.waits).toHaveLength(2);
        expect(r.waits[1]!).toBeGreaterThan(r.waits[0]!);
        await r.tick();
        expect(r.s.status()).toMatchObject({ role: 'pilot', workstation: { role: 'pilot' } });
        expect(said(r.s)).toBe('pilot');
    });

    it('CONTROL: answered at once, nothing is scheduled', async () => {
        const r = service(['pilot']);
        await r.s.register();
        expect(r.waits).toEqual([]);
    });
});
