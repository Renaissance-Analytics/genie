import { test, expect, type ElectronApplication } from '@playwright/test';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { closeGenieE2E, E2E_USERDATA, launchGenieE2E, readMcpPushHandle } from './helpers/launch';

/**
 * GENIE IS REPLACED, AND THE AGENT'S MCP CONNECTION NEVER DROPS (genie#346).
 *
 * The Phase 1 acceptance, in `.ai/plans/genie-mcp-shuttle-spec.md` §10: "a Genie
 * upgrade completes with an agent's MCP connection never dropping, proven on CI by
 * swapping the publisher under a live client". Every piece has its own tests; this
 * is the only place the whole thing runs — the real booted Genie, the shuttle it
 * really spawns on plain Node, and a client on the real port.
 *
 * ## How an update is stood in for
 *
 * By KILLING Genie, which is what the installer does to it. A graceful close is a
 * different event with a different rule (§3.3): a quit that leaves no terminal
 * running stops the shuttle, and the E2E build runs no terminals. There is a
 * second, harness-only reason the close cannot stand in: Playwright waits for the
 * app's stdout pipe to close, and a detached child still holding an inherited copy
 * of it (as the shuttle does on Linux and Windows) keeps that from happening while
 * it lives. Measured: with the shuttle alive, the close never returned on either.
 */

const STATE_DIR = path.join(E2E_USERDATA, 'genie', 'mcp-shuttle');
const SHUTTLE_ENV = { GENIE_E2E_MCP_SHUTTLE: '1' };

let app: ElectronApplication | undefined;
const shuttlePids = new Set<number>();

test.afterAll(async () => {
    // A shuttle still alive here would hold the MCP port for every later spec,
    // and keep a graceful close from returning.
    for (const pid of shuttlePids) {
        try {
            process.kill(pid);
        } catch {
            /* already gone */
        }
    }
    await closeGenieE2E(app);
});

function record(): { pid: number; port: number } | null {
    try {
        return JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'shuttle.json'), 'utf8'));
    } catch {
        return null;
    }
}

/** How many times the shuttle log records `event` in this state directory. */
function logged(event: 'started' | 'detached'): number {
    try {
        return fs.readFileSync(path.join(STATE_DIR, 'shuttle.log'), 'utf8').split(`"event":"${event}"`).length - 1;
    } catch {
        return 0;
    }
}

const starts = () => logged('started');

const alive = (pid: number) => {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
};

/** Run one step with its own deadline, so a hang names the step instead of the test. */
async function step<T>(name: string, ms: number, run: () => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            run(),
            new Promise<T>((_, reject) => {
                timer = setTimeout(() => reject(new Error(`step "${name}" did not finish within ${ms}ms`)), ms);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

function diagnostics(): string {
    const read = (name: string) => {
        try {
            return fs.readFileSync(path.join(STATE_DIR, name), 'utf8').slice(-4000);
        } catch {
            return '(none)';
        }
    };
    return [`shuttle.json: ${read('shuttle.json')}`, `refused.json: ${read('refused.json')}`, `shuttle.log: ${read('shuttle.log')}`].join(
        '\n',
    );
}

async function withDiagnostics(run: () => Promise<void>): Promise<void> {
    try {
        await run();
    } catch (e) {
        console.log(`[mcp-shuttle-swap] diagnostics:\n${diagnostics()}`);
        throw e;
    }
}

/** POST one JSON-RPC message; resolves with the final JSON-RPC body, streamed or not. */
function call(url: string, body: unknown): Promise<{ status: number; json: any }> {
    return new Promise((resolve, reject) => {
        const req = http.request(
            url,
            { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' } },
            (res) => {
                let text = '';
                res.on('data', (c) => (text += c));
                res.on('end', () => {
                    const events = text.split(/\r?\n/).filter((l) => l.startsWith('data:'));
                    const last = events.at(-1);
                    try {
                        resolve({ status: res.statusCode ?? 0, json: JSON.parse(last ? last.slice(5) : text) });
                    } catch {
                        reject(new Error(`unparseable response (${res.statusCode}): ${text.slice(0, 300)}`));
                    }
                });
            },
        );
        req.on('error', reject);
        req.end(JSON.stringify(body));
    });
}

const prompt = (id: number) => ({ jsonrpc: '2.0', id, method: 'prompts/get', params: { name: 'connectToGenie' } });

async function endpointUrl(target: ElectronApplication): Promise<string> {
    for (let i = 0; i < 100; i++) {
        const handle = await readMcpPushHandle(target);
        if (handle?.endpointUrl) return handle.endpointUrl;
        await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('the booted Genie never published its MCP endpoint');
}

/** Boot Genie with the shuttle on, and wait for the shuttle it serves through. */
async function bootWithShuttle(label: string): Promise<{ url: string; shuttle: { pid: number; port: number } }> {
    fs.rmSync(path.join(STATE_DIR, 'shuttle.json'), { force: true });
    ({ app } = await step(`launch ${label}`, 60_000, () => launchGenieE2E('issuewatch', SHUTTLE_ENV)));
    const url = await step(`read ${label}'s endpoint`, 15_000, () => endpointUrl(app!));
    await step(`${label}'s shuttle records itself`, 30_000, () =>
        expect.poll(() => record()?.pid ?? null, { timeout: 30_000 }).not.toBeNull(),
    );
    const shuttle = record()!;
    shuttlePids.add(shuttle.pid);
    // The routes reach the shuttle a moment after the token is minted.
    await step(`${label}'s shuttle routes the endpoint`, 15_000, () =>
        expect.poll(async () => (await call(url, { jsonrpc: '2.0', id: 0, method: 'ping' })).status, { timeout: 10_000 }).toBe(200),
    );
    return { url, shuttle };
}

/**
 * What the installer does to Genie during an update — and then the moment the
 * SHUTTLE knows it happened, not just the moment the OS does.
 *
 * Measured on Windows CI: the process was gone before the shuttle had read the
 * end of its pipe, so a call sent in between was dispatched to the dead Genie and
 * answered "interrupted" — correctly: it was in flight, and it is never replayed.
 * That is a real window an agent can land in, but it is not the case this spec
 * names, which is a call made while no Genie is attached. The shuttle's log is
 * where "detached" becomes an observable fact.
 */
async function killGenie(label: string): Promise<void> {
    const pid = await app!.evaluate(() => process.pid);
    const detachedBefore = logged('detached');
    process.kill(pid, 'SIGKILL');
    await step(`${label} is gone`, 15_000, () => expect.poll(() => alive(pid), { timeout: 15_000 }).toBe(false));
    app = undefined;
    await step(`the shuttle notices ${label} is gone`, 15_000, () =>
        expect.poll(() => logged('detached'), { timeout: 15_000 }).toBeGreaterThan(detachedBefore),
    );
}

test.describe.configure({ mode: 'serial' });

test('an agent’s MCP call survives Genie being replaced underneath it', async () => {
    test.setTimeout(240_000);
    fs.rmSync(STATE_DIR, { recursive: true, force: true });
    await withDiagnostics(async () => {
        // 1. Genie boots and serves THROUGH a shuttle it spawned.
        const { url, shuttle } = await bootWithShuttle('the first Genie');
        const geniePid = await app!.evaluate(() => process.pid);
        expect(shuttle.pid, 'the shuttle must be its own process').not.toBe(geniePid);
        expect(new URL(url).port).toBe(String(shuttle.port));
        const before = await step('a forwarded call through the first Genie', 15_000, () => call(url, prompt(1)));
        expect(before.status).toBe(200);
        expect(before.json.error, JSON.stringify(before.json)).toBeUndefined();
        expect(before.json.result?.messages?.length).toBeGreaterThan(0);

        // 2. That Genie is killed, as an update does. The shuttle is not, and the port answers.
        await killGenie('the first Genie');
        expect(alive(shuttle.pid), 'the shuttle must outlive the Genie that started it').toBe(true);
        const ping = await step('ping with no Genie', 10_000, () => call(url, { jsonrpc: '2.0', id: 2, method: 'ping' }));
        expect(ping.status).toBe(200);

        // 3. A call made while no Genie exists at all.
        const waiting = call(url, prompt(3));

        // 4. A new Genie boots, attaches to the SAME shuttle, and the waiting call completes.
        ({ app } = await step('launch the second Genie', 60_000, () => launchGenieE2E('issuewatch', SHUTTLE_ENV)));
        const answered = await step('the waiting call completes on the second Genie', 60_000, () => waiting);
        expect(answered.status).toBe(200);
        expect(answered.json.error, JSON.stringify(answered.json)).toBeUndefined();
        expect(answered.json.result?.messages?.length).toBeGreaterThan(0);
        expect(record()?.pid, 'the new Genie must attach, not start a second shuttle').toBe(shuttle.pid);
    });
});

test('a quit that leaves no terminal running takes the shuttle with it', async () => {
    // §3.3. The E2E build runs no terminals, so this quit keeps none — nothing is
    // left for the shuttle to serve. It is also why this close can return at all.
    test.setTimeout(120_000);
    await withDiagnostics(async () => {
        expect(app, 'the previous test leaves its second Genie running').toBeDefined();
        const shuttle = record()!;
        expect(alive(shuttle.pid)).toBe(true);

        const startsBefore = starts();
        await step('quit Genie', 60_000, () => closeGenieE2E(app));
        app = undefined;

        await step('the shuttle stops', 15_000, () => expect.poll(() => alive(shuttle.pid), { timeout: 15_000 }).toBe(false));
        // And none took its place: a quitting Genie's watchdog once started a fresh
        // shuttle as it exited, which kept running with nothing to serve.
        await new Promise((r) => setTimeout(r, 2_000));
        expect(starts(), 'no shuttle was started on the way out').toBe(startsBefore);
    });
});

test('a Genie that serves agents itself stops the shuttle left running, and serves the same port', async () => {
    // A shuttle outlives a killed Genie. A Genie that does not use it — every E2E
    // launch that did not opt in, which is how the specs after this one run — must
    // stop it. Otherwise this Genie loses the bind, falls back to a temporary port
    // no .mcp.json names, and every agent dials a shuttle with no Genie behind it.
    // (In the product the shuttle is always used; there is no setting to turn off.)
    test.setTimeout(180_000);
    await withDiagnostics(async () => {
        const { url, shuttle } = await bootWithShuttle('a Genie through the shuttle');
        await killGenie('that Genie');
        expect(alive(shuttle.pid), 'its shuttle is left running').toBe(true);

        ({ app } = await step('launch a Genie that serves in-process', 60_000, () => launchGenieE2E('issuewatch')));
        const offUrl = await step('read its endpoint', 15_000, () => endpointUrl(app!));

        await step('the leftover shuttle is stopped', 15_000, () =>
            expect.poll(() => alive(shuttle.pid), { timeout: 15_000 }).toBe(false),
        );
        expect(offUrl).toBe(url);
        const answered = await step('the same URL answers in-process', 15_000, () => call(offUrl, prompt(1)));
        expect(answered.status).toBe(200);
        expect(answered.json.error, JSON.stringify(answered.json)).toBeUndefined();
    });
});
