import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { containerPlan } from '../../src/core/services.js';
import { MAILPIT_MEASURED_IMAGE } from './mailpit-image.js';

/**
 * GENIE MAIL G2: THE SEND API IS CLOSED BY GENIE'S OWN CONFIG, MEASURED (Tynn story #488; G1's finding 6, genie#1712).
 *
 * G1 measured that with no send-API auth, Mailpit records an UNVERIFIED Basic user as a message's Username and tag. G2
 * gives Genie's Mailpit its own send-API credential (`MP_SEND_API_AUTH`, user:password). This runs the container with the
 * env Genie's own plan gives it (core/services.ts containerPlan, not a copy typed here) and measures that an unverified
 * user, and no user, are refused, while Genie's credential still sends. Same image, same CI job as G1.
 */
const run = promisify(execFile);
const docker = async (...args: string[]) => (await run('docker', args, { maxBuffer: 16 * 1024 * 1024 })).stdout.trim();
const finding = (name: string, value: unknown) => { console.log(`MAILPIT_FINDING ${name} ${JSON.stringify(value)}`); };

const CREDENTIALS = { user: 'genie', password: 'GenieSendApi-test-0001' };
const plan = containerPlan({ engine: 'mailpit', major: '1.30', scope: { kind: 'shared' }, publishedPort: 1, surfacePorts: { ui: 2 }, credentials: CREDENTIALS });
let name = '';
let httpPort = 0;
const api = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${httpPort}${path}`, init);
const basic = (user: string, password: string) => `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
const send = (subject: string, authorization?: string) => api('/api/v1/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(authorization ? { Authorization: authorization } : {}) },
    body: JSON.stringify({ From: { Email: 'app@alpha.mail.gen' }, To: [{ Email: 'signup@alpha.mail.gen' }], Subject: subject, Text: 'x' }),
});

beforeAll(async () => {
    name = `genie-mailpit-sendapi-${process.pid}`;
    await docker('pull', MAILPIT_MEASURED_IMAGE);
    const env = Object.entries(plan.env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
    await docker('run', '-d', '--name', name, '-p', '127.0.0.1::8025', '--tmpfs', '/data', ...env, MAILPIT_MEASURED_IMAGE);
    httpPort = Number(/:(\d+)\s*$/m.exec(await docker('port', name, '8025/tcp'))![1]);
    for (let i = 0; i < 120; i++) {
        try { if ((await api('/readyz')).ok) return; } catch { /* not listening yet */ }
        await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`Mailpit did not become ready: ${await docker('logs', name).catch(() => '')}`);
}, 180_000);

afterAll(async () => {
    if (name) await docker('rm', '-f', name).catch(() => '');
});

describe('Genie\'s Mailpit send API', () => {
    it('refuses an unverified user and no user; Genie\'s own credential sends, recorded as Genie\'s', async () => {
        expect(plan.env.MP_SEND_API_AUTH).toBe(`${CREDENTIALS.user}:${CREDENTIALS.password}`);
        const forged = await send('G2 forged', basic('alpha', 'not-the-password'));
        const none = await send('G2 none');
        const genie = await send('G2 genie', basic(CREDENTIALS.user, CREDENTIALS.password));
        const genieBody = await genie.json() as { ID?: string };
        const list = await (await api('/api/v1/messages')).json() as { messages: Array<{ Subject: string; Username: string; Tags: string[] }> };
        finding('send-api-auth', {
            forged: { status: forged.status, wwwAuthenticate: forged.headers.get('www-authenticate') },
            none: { status: none.status },
            genie: { status: genie.status, body: genieBody },
            stored: list.messages.map((m) => ({ Subject: m.Subject, Username: m.Username, Tags: m.Tags })),
        });
        expect(forged.status).toBe(401);
        expect(none.status).toBe(401);
        expect(genie.status).toBe(200);
        expect(genieBody.ID).toMatch(/\S/);
        // Only Genie's message was stored, and it names Genie, never a workspace's user.
        expect(list.messages.map((m) => m.Subject)).toEqual(['G2 genie']);
        expect(list.messages[0]!.Username).toBe('genie');
    });
});
