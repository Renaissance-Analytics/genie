import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * THE RELAY PATH END TO END, WITH REAL PROCESSES (audit M-a, host split P9.2). Three processes and real sockets on one
 * machine, each Genie side with its own GENIE_HOME:
 *
 *   member process ──ws──▶ relay process ◀──ws── host process          Tynn: a double over real HTTP, in this process
 *
 * - the HOST is what genie-host runs to be reachable (`startRelayHost` over `relayHostPorts` and the device socket), with
 *   a RemoteHost behind it; it makes its key itself and enrols the public half at the Tynn double;
 * - the MEMBER is what genie-host runs to reach a workstation (`mintConnectGrant`, `openRelayMember`, the device socket);
 * - the RELAY follows genie-cloud's rules and keeps every frame it is handed in a file, as its operator could.
 *
 * What is asserted: Genie's protocol works across it; the relay's file holds none of it (with the frames counted first,
 * so "none" was looked for in the right place); and when Tynn names another key than the host holds, the member refuses
 * in words and the relay's file shows it sent no frame of Genie's own.
 *
 * Runs in the test VMs (spawns processes); never on the owner's desktop.
 */
const TSX = import.meta.resolve('tsx');
const WS_ID = 'ws_p92_host';
const NAME = 'alphar';
const MARKER_UP = 'agent-MARKER-UP-5d2e91';
const MARKER_DOWN = 'MARKER-DOWN-a81c07';

const tynnKey = generateKeyPairSync('ed25519');
const tynnJwk = { ...(tynnKey.publicKey.export({ format: 'jwk' }) as { kty: string; crv: string; x: string }), kid: 'tynn-1', alg: 'EdDSA' };
const thumbprint = (jwk: { crv: string; kty: string; x: string }) => createHash('sha256').update(`{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}"}`, 'utf8').digest('base64url');
function mintGrant(claims: Record<string, unknown>): string {
    const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
    const head = b64({ alg: 'EdDSA', typ: 'wsgrant+jwt', kid: 'tynn-1' });
    const body = b64({ aud: WS_ID, exp: Math.floor(Date.now() / 1000) + 300, jti: `g${Date.now()}`, sub: 'user_1', name: 'Pat', aud_role: 'pilot', src: 'owner', cap: 'control', scope: ['host:all'], ...claims });
    return `${head}.${body}.${sign(null, Buffer.from(`${head}.${body}`), tynnKey.privateKey).toString('base64url')}`;
}

let root: string;
let relayLog: string;
let relayUrl = '';
let tynnUrl = '';
let tynn: Server;
let enrolledKey: string | null = null;
/** What the Tynn double names as the host's key with a grant: the enrolled one, or another. */
let namedKey: 'enrolled' | 'another' = 'enrolled';
const anotherKey = (generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }) as Buffer).toString('base64');
const children: ChildProcess[] = [];
let hostOut = '';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(what: string, fn: () => boolean, ms = 90_000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!fn()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}\n--- host ---\n${hostOut}`);
        await sleep(100);
    }
}
const bodyOf = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>; } catch { return {}; }
};
const run = (script: string, env: Record<string, string>, args: string[] = []): ChildProcess => {
    const child = spawn(process.execPath, ['--import', TSX, resolve('test/support/relay-e2e', script), ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    return child;
};
const relayFrames = async (): Promise<Array<{ from: 'member' | 'host'; text: string; frame: Record<string, unknown> }>> =>
    (await readFile(relayLog, 'utf8')).split('\n').filter((l) => l !== '').map((l) => { const e = JSON.parse(l) as { from: 'member' | 'host'; text: string }; return { ...e, frame: JSON.parse(e.text) as Record<string, unknown> }; });

/** One member process, start to finish: what it printed last, and everything it printed. */
async function member(home: string): Promise<{ result: Record<string, unknown>; out: string }> {
    const child = run('member-process.ts', { GENIE_HOME: home, P92_TYNN: tynnUrl, P92_WORKSTATION: WS_ID, P92_NAME: NAME, P92_MARKER_UP: MARKER_UP });
    let out = '';
    child.stdout?.on('data', (d) => { out += String(d); });
    child.stderr?.on('data', (d) => { out += String(d); });
    await new Promise<void>((r) => child.once('exit', () => r()));
    const line = out.split('\n').filter((l) => l.startsWith('RESULT ')).at(-1);
    if (!line) throw new Error(`the member process said no result:\n${out}`);
    return { result: JSON.parse(line.slice('RESULT '.length)) as Record<string, unknown>, out };
}

beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'genie-p92-'));
    relayLog = join(root, 'relay-frames.jsonl');
    await writeFile(relayLog, '');

    // Tynn, as far as the two ends ask it: enrol a host key, a relay ticket, its grant keys, introspection, a connect grant.
    tynn = createServer((req, res) => {
        void (async () => {
            const path = new URL(req.url ?? '/', 'http://tynn').pathname;
            const body = await bodyOf(req);
            const json = (status: number, value: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
            if (path === `/api/v1/workstations/${WS_ID}/enroll`) { enrolledKey = String(body.host_public_key); json(200, { ok: true }); return; }
            if (path === `/api/v1/workstations/${WS_ID}/relay-ticket`) { json(200, { ticket: 'ticket-1', relay_endpoint: relayUrl }); return; }
            if (path === '/api/v1/workstations/grants/public-keys') { json(200, { keys: [tynnJwk] }); return; }
            if (path === '/api/v1/workstations/grants/introspect') { json(200, { active: true }); return; }
            if (path === `/api/v1/workstations/${WS_ID}/connect-grant`) {
                const jwk = body.pop_jwk as { crv: string; kty: string; x: string };
                json(201, { token: mintGrant({ cnf: { jkt: thumbprint(jwk) } }), workstation_id: WS_ID, relay_endpoint: relayUrl, host_public_key: namedKey === 'enrolled' ? enrolledKey : anotherKey });
                return;
            }
            json(404, {});
        })();
    });
    await new Promise<void>((r) => tynn.listen(0, '127.0.0.1', () => r()));
    tynnUrl = `http://127.0.0.1:${(tynn.address() as { port: number }).port}`;

    const relay = run('relay-process.ts', {}, [relayLog]);
    let relayOut = '';
    relay.stdout?.on('data', (d) => { relayOut += String(d); });
    relay.stderr?.on('data', (d) => { relayOut += String(d); });
    await until(`the relay's port\n${relayOut}`, () => /PORT \d+/.test(relayOut));
    relayUrl = `ws://127.0.0.1:${/PORT (\d+)/.exec(relayOut)![1]}`;

    const host = run('host-process.ts', { GENIE_HOME: join(root, 'home-host'), P92_TYNN: tynnUrl, P92_WORKSTATION: WS_ID, P92_NAME: NAME, P92_MARKER_DOWN: MARKER_DOWN });
    host.stdout?.on('data', (d) => { hostOut += String(d); });
    host.stderr?.on('data', (d) => { hostOut += String(d); });
    await until('the host to be reachable over the relay', () => hostOut.includes('"state":"reachable"'));
}, 180_000);

afterAll(async () => {
    for (const child of children) { try { child.kill(); } catch { /* gone */ } }
    await new Promise<void>((r) => tynn.close(() => r()));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('two Genie processes and a relay between them', () => {
    it('Genie’s protocol works across the relay, and the relay’s own record of every frame holds none of it', async () => {
        namedKey = 'enrolled';
        const before = (await relayFrames()).length;
        const { result } = await member(join(root, 'home-member-1'));
        expect(result).toMatchObject({
            ok: true,
            welcome: { kind: 'welcome', host: NAME, isOwner: true },
            baton: { kind: 'result', ok: true },
            openAgent: { kind: 'result', ok: true },
            snapshot: { kind: 'result', ok: true, value: { note: MARKER_DOWN } },
        });
        // The host process read the member's words (so they did cross), and the member read the host's.
        await until('the host to print the call', () => hostOut.includes('HOST-GOT openAgent') && hostOut.includes(MARKER_UP), 10_000);

        const frames = (await relayFrames()).slice(before);
        const rest = (from: 'member' | 'host') => frames.filter((f) => f.from === from && f.frame.channel === 'rest');
        // CONTROL for the absences below: the relay did carry Genie's frames, both ways, and kept them.
        expect(rest('member').length).toBeGreaterThanOrEqual(4);
        expect(rest('host').length).toBeGreaterThanOrEqual(4);
        const kept = frames.map((f) => f.text).join('\n');
        for (const plain of [MARKER_UP, MARKER_DOWN, 'baton.take', 'openAgent', 'snapshot', 'welcome', 'isOwner', 'member-process', '"kind":"hello"', '\\"kind\\"']) expect(kept, plain).not.toContain(plain);
        for (const f of [...rest('member'), ...rest('host')]) {
            expect(Object.keys(f.frame).sort()).toEqual(['channel', 'kind', 'payload', 'sid']);
            expect(Object.keys(f.frame.payload as object).sort()).toEqual(['c', 'e2e', 'n']);
        }
        // The handshake is what the relay does see, and no key of the host's is in it.
        const control = frames.filter((f) => f.frame.channel === 'control').map((f) => (f.frame.payload as { type?: string } | undefined)?.type);
        expect(control).toEqual(expect.arrayContaining(['e2e-init', 'pop-challenge', 'pop-proof', 'e2e-accept', 'e2e-finish']));
        expect(kept).not.toContain(enrolledKey!);
    }, 120_000);

    it('Tynn names ANOTHER key than the host holds: the member refuses in words, and sent the relay nothing of Genie’s own', async () => {
        namedKey = 'another';
        const before = (await relayFrames()).length;
        const hostBefore = hostOut.length;
        const { result } = await member(join(root, 'home-member-2'));
        expect(result).toEqual({
            ok: false, stage: 'relay',
            reason: `This workstation could not prove it is ${NAME}. Nothing was sent. If ${NAME} was set up again, wait until it has signed in to Tynn, then connect again.`,
        });
        await sleep(500);
        const frames = (await relayFrames()).slice(before);
        // CONTROL: the member did reach the relay and the host did answer (so the refusal is the member's own check).
        const types = frames.map((f) => `${f.from}:${(f.frame.payload as { type?: string } | undefined)?.type ?? String(f.frame.type ?? f.frame.kind)}`);
        expect(types).toEqual(expect.arrayContaining(['member:e2e-init', 'host:e2e-accept']));
        expect(types).not.toContain('member:e2e-finish');
        expect(frames.filter((f) => f.frame.channel === 'rest' || f.frame.channel === 'site')).toEqual([]);
        expect(hostOut.slice(hostBefore)).not.toContain('HOST-GOT');
    }, 120_000);

    it('Tynn names NO key: the member refuses before it dials the relay at all', async () => {
        namedKey = 'enrolled';
        const kept = enrolledKey;
        enrolledKey = null;
        try {
            const before = (await relayFrames()).length;
            const { result } = await member(join(root, 'home-member-3'));
            expect(result).toEqual({
                ok: false, stage: 'relay',
                reason: `Tynn has no key on record for ${NAME}, so this workstation could not prove it is ${NAME}. Nothing was sent. Open Genie on ${NAME} and sign in to Tynn there, then connect again.`,
            });
            await sleep(300);
            expect((await relayFrames()).length).toBe(before);
        } finally {
            enrolledKey = kept;
        }
    }, 120_000);

    it('CONTROL, last: with the right key named again, the same host still admits a member (the refusals left it whole)', async () => {
        namedKey = 'enrolled';
        const { result } = await member(join(root, 'home-member-4'));
        expect(result).toMatchObject({ ok: true, welcome: { kind: 'welcome', isOwner: true } });
    }, 120_000);
});
