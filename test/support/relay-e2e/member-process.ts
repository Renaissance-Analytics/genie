import { parseMessage, type WireMessage } from '../../../src/core/remote-protocol.js';
import { deviceSocket } from '../../../src/main/device-socket.js';
import { openRelayMember, PopKeypair } from '../../../src/main/relay-member.js';
import { mintConnectGrant } from '../../../src/main/tynn-network.js';

/**
 * A MEMBER AS ITS OWN PROCESS, FOR THE REAL-PROCESS ROW (audit M-a, P9.2; test/relay-e2e-process.test.ts): what
 * genie-host does to reach another workstation (genie-host.ts `relay`: a proof key made here, `mintConnectGrant`,
 * `openRelayMember` over the device socket), then Genie's own hello and three calls. Its last line of output is one
 * JSON object: what it was told.
 */
const tynn = process.env.P92_TYNN ?? '';
const workstationId = process.env.P92_WORKSTATION ?? '';
if (!process.env.GENIE_HOME || !tynn || !workstationId) throw new Error('GENIE_HOME, P92_TYNN and P92_WORKSTATION are required');

const done = (result: unknown): never => {
    console.log(`RESULT ${JSON.stringify(result)}`);
    process.exit(0);
};

const pop = PopKeypair.generate();
const grant = await mintConnectGrant(async (path, init) => {
    const res = await fetch(`${tynn}${path}`, { method: init.method, headers: { 'content-type': 'application/json', accept: 'application/json' }, ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}) });
    return { ok: res.ok, status: res.status, json: () => res.json() as Promise<unknown> };
}, workstationId, pop.publicJwk);
if (!grant.ok) done({ ok: false, stage: 'tynn', reason: grant.reason });
else {
    const opened = await openRelayMember({ socket: (url) => deviceSocket(url), relayUrl: grant.relayEndpoint, workstationId, grant: grant.token, hostPublicKey: grant.hostPublicKey, name: process.env.P92_NAME ?? null, pop });
    if (!opened.ok) done({ ok: false, stage: 'relay', reason: opened.reason });
    else {
        const t = opened.transport;
        const inbox: WireMessage[] = [];
        const waiters: Array<(m: WireMessage) => void> = [];
        t.onMessage((text) => { const r = parseMessage(text); if (!r.ok) return; const w = waiters.shift(); if (w) w(r.message); else inbox.push(r.message); });
        t.onClose(() => done({ ok: false, stage: 'session', reason: t.closedBecause() }));
        const next = (): Promise<WireMessage> => (inbox.length > 0 ? Promise.resolve(inbox.shift()!) : new Promise((r) => waiters.push(r)));
        let id = 0;
        const call = async (method: string, ...args: unknown[]): Promise<WireMessage> => { t.send(JSON.stringify({ kind: 'call', id: ++id, method, args })); return next(); };
        t.send(JSON.stringify({ kind: 'hello', auth: { kind: 'relay' }, label: 'member-process' }));
        let welcome = await next();
        while (welcome.kind === 'pairing') welcome = await next();
        const baton = await call('baton.take');
        const opened2 = await call('openAgent', process.env.P92_MARKER_UP ?? 'agent_a');
        const snapshot = await call('snapshot');
        done({ ok: true, welcome, baton, openAgent: opened2, snapshot });
    }
}
