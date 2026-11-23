import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { Baton, PairingPins } from '../../../src/core/remote.js';
import { deviceSocket } from '../../../src/main/device-socket.js';
import { DeviceStore } from '../../../src/main/remote-devices.js';
import { RemoteHost, type HostApi } from '../../../src/main/remote-host.js';
import { relayHostPorts, startRelayHost } from '../../../src/main/tynn-network.js';
import { buildWorkstationAuthHeader, generateHostKeypair, identityFrom } from '../../../src/main/workstation-identity.js';
import { allowEveryPairing } from '../allow-every-pairing.js';

/**
 * A HOST AS ITS OWN PROCESS, FOR THE REAL-PROCESS ROW (audit M-a, P9.2; test/relay-e2e-process.test.ts): this machine
 * on the Tynn relay as genie-host puts it there (genie-host.ts `start`: `startRelayHost` over `relayHostPorts` and the
 * device socket), with a RemoteHost behind the link and its own GENIE_HOME. Its key is made here, in this process, and
 * only its public half leaves it (the enrolment). What it is asked over the relay it prints, so the test can see that
 * the member's words arrived.
 */
const home = process.env.GENIE_HOME ?? '';
const tynn = process.env.P92_TYNN ?? '';
const workstationId = process.env.P92_WORKSTATION ?? '';
if (!home || !tynn || !workstationId) throw new Error('GENIE_HOME, P92_TYNN and P92_WORKSTATION are required');

const keypair = generateHostKeypair();
const identity = identityFrom({ workstationId, privateKeyPem: keypair.privateKeyPem });

const enrolled = await fetch(`${tynn}/api/v1/workstations/${workstationId}/enroll`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ host_public_key: keypair.publicKeySpkiB64, host_fingerprint: identity.fingerprint }) });
if (!enrolled.ok) throw new Error(`enrolment refused (${enrolled.status})`);

const snapshot = { agents: [{ id: 'agent_a', name: 'atlas', workspaceId: 'tynn' }], workspaces: [{ id: 'tynn', path: '/w/tynn', agentsKnown: true }], deckItems: [], signals: {}, note: process.env.P92_MARKER_DOWN ?? '' };
const api: HostApi = {
    invoke: async (method, args) => {
        console.log(`HOST-GOT ${method} ${JSON.stringify(args)}`);
        return method === 'snapshot' ? snapshot : { ok: true };
    },
    onEvent: () => () => {},
    workspaceOfAgent: () => 'tynn',
};
await mkdir(home, { recursive: true });
const devices = await DeviceStore.open(home, { now: Date.now, random: () => randomUUID() });

startRelayHost({
    ports: relayHostPorts({ tynnHost: tynn, workstationId, authHeader: () => buildWorkstationAuthHeader(keypair.privateKeyPem, workstationId), fetch: (url, init) => fetch(url, init) }),
    socket: (url) => deviceSocket(url),
    workstationId,
    fingerprint: identity.fingerprint,
    sign: (data) => identity.sign(data),
    signedInHere: () => 'user_1',
    attach: (transport) => {
        new RemoteHost({ confirm: allowEveryPairing, api, hostName: process.env.P92_NAME ?? 'host', baton: new Baton(), pins: new PairingPins({ now: Date.now, random: Math.random }), devices, transport });
        return () => {};
    },
    onStatus: (status) => console.log(`STATUS ${JSON.stringify(status)}`),
    log: (message) => console.log(`LINK ${message}`),
});
