import { describe, expect, it, vi } from 'vitest';
import * as roles from '../src/core/workstation-role.js';
import { deviceLinkGate } from '../src/main/device-link-gate.js';
import { RelayHostService, type RelayHostServicePorts } from '../src/main/relay-host-service.js';

/*
 * THE WORDS A REFUSED CONNECT SAYS ARE TRUE (beta.61.1, the review of #1853). "Could not reach Tynn… Try again" is only for
 * a role read that really got no answer. A machine that is not registered says why it is not; a sign-in Tynn says is not
 * bound to a workstation says that. Nothing is dialled in any of them.
 */
type Reading = { role: 'pilot' | 'drone' | null; said: 'pilot' | 'drone' | null; why?: string | null };
const connectOutRefusal = (roles as unknown as { connectOutRefusal(r: Reading): string | null }).connectOutRefusal;
const UNREACHED = /could not reach Tynn to check this workstation’s role/;

function service(over: { ensure?: () => Promise<unknown>; readRole: () => Promise<unknown> }) {
    const ports = {
        account: () => ({ host: () => 'https://tynn.test', status: () => ({ signedIn: true }), request: async () => ({}) as never }),
        workstation: { identity: async () => ({ workstationId: 'ws_me', fingerprint: 'fp' }), ensure: over.ensure ?? (async () => ({ ok: true, status: 'exists', workstationId: 'ws_me' })), legacyDone: async () => null },
        enabled: () => false,
        readRole: over.readRole,
        start: () => { throw new Error('not started here'); },
        onChange: () => {},
    } as unknown as RelayHostServicePorts;
    const s = new RelayHostService(ports);
    return { s, why: () => (s.status() as unknown as { unknownWhy?: string | null }).unknownWhy ?? null };
}

describe('why the role is not known, as genie-host says it', () => {
    it('not registered: the registration\'s own reason', async () => {
        const r = service({ ensure: async () => { throw new Error('This machine is workstation ws_1, and its key is not in the keychain, so it could not prove itself to Tynn and was not registered again.'); }, readRole: async () => null });
        await r.s.register();
        expect(r.why()).toMatch(/not registered with Tynn/);
        expect(r.why()).toMatch(/its key is not in the keychain/);
        expect(r.why()).not.toMatch(UNREACHED);
    });

    it('Tynn\'s own null: this sign-in is not bound to a workstation', async () => {
        const r = service({ readRole: async () => ({ role: null, unbound: true }) });
        await r.s.register();
        expect(r.why()).toMatch(/not attached to this workstation/);
        expect(r.why()).not.toMatch(UNREACHED);
    });

    it('the read got no answer: nothing more is claimed, so the words are "could not reach Tynn"', async () => {
        const r = service({ readRole: async () => null });
        await r.s.register();
        expect(r.why()).toBeNull();
        expect(connectOutRefusal({ role: r.s.status().role, said: null, why: r.why() })).toMatch(UNREACHED);
    });

    it('CONTROL: a pilot has nothing to say', async () => {
        const r = service({ readRole: async () => 'pilot' });
        await r.s.register();
        expect(r.why()).toBeNull();
        expect(connectOutRefusal({ role: 'pilot', said: 'pilot', why: null })).toBeNull();
    });
});

describe('the refusal a person reads', () => {
    it('says the reason when there is one, the drone words only for Tynn\'s drone', () => {
        expect(connectOutRefusal({ role: 'drone', said: null, why: 'This machine is not registered with Tynn, so it did not connect: no key.' })).toBe('This machine is not registered with Tynn, so it did not connect: no key.');
        expect(connectOutRefusal({ role: 'drone', said: 'drone', why: 'ignored' })).toMatch(/is a drone/);
    });

    it('the dial\'s gate says it too, and dials nothing', async () => {
        const open = vi.fn(async () => ({ ok: true as const, channel: 'device_1' }));
        const gate = deviceLinkGate as unknown as (url: unknown, ports: object) => Promise<{ ok: boolean; reason?: string }>;
        const r = await gate('wss://drone:7421/genie', { role: () => 'drone', said: () => null, why: () => 'Tynn says this sign-in is not attached to this workstation yet.', reread: async () => {}, link: () => ({ open }) });
        expect(r).toEqual({ ok: false, reason: 'Tynn says this sign-in is not attached to this workstation yet.' });
        expect(open).not.toHaveBeenCalled();
    });
});
