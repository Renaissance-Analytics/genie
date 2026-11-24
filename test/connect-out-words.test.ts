import { describe, expect, it, vi } from 'vitest';
import { RelayHostService, type RelayHostServicePorts } from '../src/main/relay-host-service.js';

/*
 * WHY THE ROLE IS NOT KNOWN, IN TRUE WORDS (beta.61.1, the review of #1853). A machine that is not registered says why it
 * is not; a sign-in Tynn says is not bound to a workstation says that; a read with no answer claims nothing. The role no
 * longer gates a connect (Tynn #423; connect-out-any-role-423.test.ts), so these words are Settings' alone.
 */
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
    });

    it('CONTROL: a pilot has nothing to say', async () => {
        const r = service({ readRole: async () => 'pilot' });
        await r.s.register();
        expect(r.why()).toBeNull();
    });
});

