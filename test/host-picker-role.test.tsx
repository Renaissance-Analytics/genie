import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RelayHostService, type RelayHostServicePorts } from '../src/main/relay-host-service.js';
import { EMPTY_FEATURES, type FeatureData } from '../src/renderer/features.js';
import { Shell } from '../src/renderer/Shell.js';
import type { GenieSnapshot } from '../src/renderer/bridge.js';

/*
 * THE HOST PICKER IN THE TITLE BAR (beta.61 as shipped; the owner lost it). It is there whatever role Tynn gave this
 * machine (Tynn #423: every client a pilot); a dial is genie-host's, and Tynn decides the grant. And the role read that got
 * no answer is read again, for Settings to say.
 */
const snapshot = { agents: [], osAgent: null, workspaces: [{ id: 'w', path: '/w', name: 'w', agentsKnown: true, asleep: false }], deckItems: [], signals: {}, workstation: { name: 'pilot', healthy: true } } as unknown as GenieSnapshot;
const connectProps = { state: null, remembered: [], onConnect: () => {}, onDisconnect: () => {}, tynnWorkstations: { ok: true as const, workstations: [{ id: 'ws_d', name: 'drone-1', role: 'drone' }] }, onOpenWorkstation: () => {}, onOpenLink: () => {}, onRefresh: () => {} };
const titleBar = (tynnWorkstation: unknown): string => renderToStaticMarkup(
    <Shell
        route="genie://dashboard" snapshot={snapshot} servable={['dashboard', 'agent', 'workspace']} agentDetail={null} agentResolved={false} selectedRowId={null} chatThread={null} pinned={null}
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
    it('before genie-host has answered at all (no workstation said yet): the picker is there', () => {
        expect(titleBar(null)).toContain(PICKER);
    });
    it('Tynn said drone: the picker is there too — the role gates no connecting out (Tynn #423)', () => {
        expect(titleBar({ registered: true, host: 'https://tynn.ai', workstationId: 'ws_me', role: 'drone' })).toContain(PICKER);
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
