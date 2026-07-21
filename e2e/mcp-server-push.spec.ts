import { test, expect, type ElectronApplication } from '@playwright/test';
import http from 'node:http';
import { launchGenieE2E, readMcpPushHandle } from './helpers/launch';

/**
 * MCP server-push (SSE) — proven against the REAL COMPILED APP.
 *
 * WHY THIS EXISTS: the unit tests wire the broker's notify sink BY HAND, so they
 * prove the registry and the routing but say nothing about whether the app's BOOT
 * actually connects them. If someone deleted the `setNotifySink(...)` block in
 * background.ts, every unit test would still pass and server-push would silently
 * stop delivering — the exact shape of bug this codebase keeps producing (a dead
 * path that looks healthy).
 *
 * So this drives the whole chain in a booted Electron app with no mocks:
 *
 *   real MCP server (GET /mcp/<token> → SSE)
 *     → real AgentInbox broker delivery (a DM between two agents)
 *       → the boot-wired notify sink
 *         → pushToTerminal (no session correlated → 0)
 *           → pushToWorkspace fallback
 *             → a notification arriving on a real HTTP stream
 *
 * The one thing it CANNOT prove is whether a third-party TUI (claude/codex) opens
 * the stream and acts on a push — that binary isn't in CI. Everything up to the
 * client's doorstep is covered here.
 */

let app: ElectronApplication;

test.beforeAll(async () => {
    ({ app } = await launchGenieE2E('issuewatch'));
});

test.afterAll(async () => {
    await app?.close();
});

/** Open a GET SSE stream and collect bytes; caller closes it. */
function openStream(url: string, headers: Record<string, string> = {}) {
    return new Promise<{ status: number; contentType: string; read: () => string; close: () => void }>(
        (resolve, reject) => {
            const u = new URL(url);
            const req = http.request(
                {
                    host: u.hostname,
                    port: u.port,
                    path: u.pathname,
                    method: 'GET',
                    headers: { Accept: 'text/event-stream', ...headers },
                },
                (res) => {
                    let bytes = '';
                    res.on('data', (c) => (bytes += c));
                    res.on('error', () => {});
                    resolve({
                        status: res.statusCode ?? 0,
                        contentType: String(res.headers['content-type'] ?? ''),
                        read: () => bytes,
                        close: () => req.destroy(),
                    });
                },
            );
            req.on('error', reject);
            req.end();
        },
    );
}

const until = async (fn: () => boolean, ms = 8000): Promise<void> => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if (fn()) return;
        await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('condition not met in time');
};

test('the booted app serves the GET stream and pushes a real AgentInbox DM onto it', async () => {
    const handle = await readMcpPushHandle(app);
    expect(handle, 'the booted app must publish its MCP endpoint for E2E').not.toBeNull();

    const url = handle!.endpointUrl;
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/[a-f0-9]+$/);

    const stream = await openStream(url);
    try {
        // The GET stream is served by the real server (not 405).
        expect(stream.status).toBe(200);
        expect(stream.contentType).toContain('text/event-stream');
        await until(() => stream.read().includes(': open'));

        // Deliver a REAL DM through the REAL broker in the booted app. Nothing is
        // stubbed: this is the same send() path an agent's `agentinbox` call takes.
        const delivered = await app.evaluate(() =>
            (globalThis as Record<string, any>).__GENIE_E2E_MCP__.sendSelfTestDm(),
        );
        expect(delivered, 'the broker must report the DM delivered').toBe(true);

        // ...and the boot-wired notify sink must put it on the stream. Without the
        // background.ts wiring this never arrives, which is the regression this
        // whole spec exists to catch.
        await until(() => stream.read().includes('notifications/message'));
        expect(stream.read()).toContain('AgentInbox');
    } finally {
        stream.close();
    }
});

test('the push diagnostics count what actually happened', async () => {
    // The Settings readout reads these; if the counters lie, the measurement the
    // whole probe depends on lies with them.
    const stats = await app.evaluate(() =>
        (globalThis as Record<string, any>).__GENIE_E2E_MCP__.diagnostics(),
    );
    expect(stats.streamsOpened).toBeGreaterThan(0); // the stream above
    expect(stats.pushesSent).toBeGreaterThan(0); // the DM above
    expect(stats.pushesReached).toBeGreaterThan(0); // and it landed
});
