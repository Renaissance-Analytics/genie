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
 * really spawns on plain Node, and a client on the real port:
 *
 *   1. Genie boots with the shuttle on, spawns it, and serves through it.
 *   2. That Genie exits. The shuttle does not — the port keeps answering.
 *   3. A call made while NO Genie exists waits in the shuttle.
 *   4. A new Genie boots, attaches to the SAME shuttle, and that waiting call
 *      completes on the response the client opened before the new Genie existed.
 */

const STATE_DIR = path.join(E2E_USERDATA, 'genie', 'mcp-shuttle');
const SHUTTLE_ENV = { GENIE_E2E_MCP_SHUTTLE: '1' };

let app: ElectronApplication | undefined;
let shuttlePid: number | null = null;

/** What each Genie printed — its `[mcp-endpoint]` / `[mcp-shuttle]` lines say which state it reached. */
const genieOutput: string[] = [];
function capture(target: ElectronApplication, label: string): void {
    const proc = target.process();
    const tag = (chunk: unknown) => {
        for (const line of String(chunk).split(/\r?\n/)) {
            if (/mcp/i.test(line)) genieOutput.push(`${label}: ${line}`);
        }
    };
    proc.stdout?.on('data', tag);
    proc.stderr?.on('data', tag);
}

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
    return [
        `shuttle.json: ${read('shuttle.json')}`,
        `refused.json: ${read('refused.json')}`,
        `shuttle.log: ${read('shuttle.log')}`,
        `genie output:\n${genieOutput.join('\n') || '(none)'}`,
    ].join('\n');
}

test.afterAll(async () => {
    await closeGenieE2E(app);
    // Nothing else in the run may inherit a shuttle holding the MCP port.
    if (shuttlePid) {
        try {
            process.kill(shuttlePid);
        } catch {
            /* already gone */
        }
    }
});

function record(): { pid: number; port: number } | null {
    try {
        return JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'shuttle.json'), 'utf8'));
    } catch {
        return null;
    }
}

const alive = (pid: number) => {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
};

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
                    } catch (e) {
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

test('an agent’s MCP call survives Genie being replaced underneath it', async () => {
    test.setTimeout(240_000);
    fs.rmSync(STATE_DIR, { recursive: true, force: true });
    try {
        // 1. Genie boots and serves THROUGH a shuttle it spawned.
        ({ app } = await step('launch the first Genie', 60_000, () => launchGenieE2E('issuewatch', SHUTTLE_ENV)));
        capture(app, 'first');
        const url = await step('read its endpoint', 15_000, () => endpointUrl(app!));
        await step('the shuttle records itself', 30_000, () =>
            expect.poll(() => record()?.pid ?? null, { timeout: 30_000 }).not.toBeNull(),
        );
        const first = record()!;
        shuttlePid = first.pid;
        const geniePid = await app.evaluate(() => process.pid);
        expect(first.pid, 'the shuttle must be its own process').not.toBe(geniePid);
        expect(new URL(url).port).toBe(String(first.port));

        // The routes reach the shuttle a moment after the token is minted.
        await step('the shuttle routes the endpoint', 15_000, () =>
            expect
                .poll(async () => (await call(url, { jsonrpc: '2.0', id: 0, method: 'ping' })).status, { timeout: 10_000 })
                .toBe(200),
        );
        const before = await step('a forwarded call through the first Genie', 15_000, () => call(url, prompt(1)));
        expect(before.status).toBe(200);
        expect(before.json.error, JSON.stringify(before.json)).toBeUndefined();
        expect(before.json.result?.messages?.length).toBeGreaterThan(0);

        // 2. That Genie is gone. The shuttle is not, and neither is the port.
        await step('close the first Genie', 60_000, () => closeGenieE2E(app));
        app = undefined;
        expect(alive(first.pid), 'the shuttle must outlive the Genie that started it').toBe(true);
        const ping = await step('ping with no Genie', 10_000, () => call(url, { jsonrpc: '2.0', id: 2, method: 'ping' }));
        expect(ping.status).toBe(200);

        // 3. A call made while no Genie exists at all.
        const waiting = call(url, prompt(3));

        // 4. A new Genie boots, attaches to the SAME shuttle, and the call completes.
        ({ app } = await step('launch the second Genie', 60_000, () => launchGenieE2E('issuewatch', SHUTTLE_ENV)));
        capture(app, 'second');
        const answered = await step('the waiting call completes on the second Genie', 60_000, () => waiting);
        expect(answered.status).toBe(200);
        expect(answered.json.error, JSON.stringify(answered.json)).toBeUndefined();
        expect(answered.json.result?.messages?.length).toBeGreaterThan(0);
        expect(record()?.pid, 'the new Genie must attach, not start a second shuttle').toBe(first.pid);
    } catch (e) {
        console.log(`[mcp-shuttle-swap] diagnostics:\n${diagnostics()}`);
        throw e;
    }
});

test('turning the shuttle off stops the one left running, and Genie serves the port itself', async () => {
    // A shuttle from the session above is still running and holding the port.
    // Booting with the setting off must stop it — otherwise this Genie loses the
    // bind, falls back to a temporary port no .mcp.json names, and every agent
    // dials a shuttle with no Genie behind it.
    await closeGenieE2E(app);
    app = undefined;
    const leftover = record();
    expect(leftover && alive(leftover.pid), 'the previous test must leave its shuttle running').toBe(true);

    ({ app } = await launchGenieE2E('issuewatch'));
    const url = await endpointUrl(app);

    await expect.poll(() => alive(leftover!.pid), { timeout: 15_000 }).toBe(false);
    shuttlePid = null;
    const answered = await call(url, prompt(1));
    expect(answered.status).toBe(200);
    expect(answered.json.error, JSON.stringify(answered.json)).toBeUndefined();
    expect(new URL(url).port).toBe(String(leftover!.port));
});
