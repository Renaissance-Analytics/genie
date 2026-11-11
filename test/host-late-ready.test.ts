import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ENGINE_PROTOCOL } from '../src/core/engine-protocol.js';
import { linkToHost, type EngineLaunchPorts } from '../src/main/engine-launch.js';
import { HOST_WAIT_SHOW_AFTER_MS, HostWait, hostWaitWords, testReadyDelayMs } from '../src/main/host-wait-window.js';

/**
 * A HOST THAT IS STILL STARTING IS WAITED FOR (Tynn #700). Measured on the Azure Windows gate, a fresh home: the window
 * gave up on genie-host after a fixed 20 s ("the host did not become ready within 20 s", 23:29:07.975) and the host served
 * its pipe 8 ms later. The window then showed the "could not start its host" dialog before it had made its main window,
 * so there was no page at all. The host is the window's own child: it is waited for until it is ready or it exits.
 */
const src = (p: string) => readFileSync(p, 'utf8').split(/\r?\n/).map((l) => l.replace(/^\s*(\/\/|\*|\/\*).*$/, '')).join('\n');

function rig(options: { readyAt?: number; exitAt?: number }) {
    let clock = 0;
    const waited: number[] = [];
    const runtimeDir = '/rt';
    const record = JSON.stringify({ pid: 42, endpoint: 'pipe-42', protocol: ENGINE_PROTOCOL, build: 'b1', startedAt: 1 });
    const ports: EngineLaunchPorts & { onWaiting?: (elapsedMs: number) => void } = {
        runtimeDir, logsDir: '/logs', build: 'b1', hostScript: '/h.js', execPath: '/e', genieHome: '/home', env: {},
        now: () => clock,
        sleep: async (ms) => { clock += ms; },
        alive: (pid) => pid === 42 && (options.exitAt === undefined || clock < options.exitAt),
        readFile: (file) => {
            if (file === join(runtimeDir, 'host.token')) return clock >= (options.readyAt ?? Infinity) ? 'token' : null;
            if (file === join(runtimeDir, 'host.json')) return clock >= (options.readyAt ?? Infinity) ? record : null;
            return null;
        },
        spawnHost: () => 42,
        connectTo: async () => ({ send: () => {}, onLine: () => {}, onClose: () => {}, close: () => {} }) as never,
        onWaiting: (elapsedMs) => waited.push(elapsedMs),
    };
    return { ports, waited, clock: () => clock };
}

describe('the window waits for its own host', () => {
    it('a host ready after 25 s is linked, not given up on at 20 s', async () => {
        const r = rig({ readyAt: 25_000 });
        await expect(linkToHost(r.ports)).resolves.toMatchObject({ how: 'started', token: 'token' });
        expect(r.clock()).toBeGreaterThanOrEqual(25_000);
    });

    it('a host ready after 3 minutes is linked too: the bound is its exit, not a clock', async () => {
        const r = rig({ readyAt: 180_000 });
        await expect(linkToHost(r.ports)).resolves.toMatchObject({ how: 'started' });
    });

    it('CONTROL: a host that exits before it is ready is said, at once', async () => {
        const r = rig({ exitAt: 5_000 });
        await expect(linkToHost(r.ports)).rejects.toThrow('the host process exited before it was ready (see logs/genie-host.log)');
        expect(r.clock()).toBeLessThan(6_000);
    });

    it('says how long it has waited, about once a second, while it waits', async () => {
        const r = rig({ readyAt: 4_500 });
        await linkToHost(r.ports);
        expect(r.waited.length).toBeGreaterThanOrEqual(4);
        expect(r.waited.every((ms, i) => i === 0 || ms > r.waited[i - 1]!)).toBe(true);
    });
});

describe('what the person sees while it waits', () => {
    it('“Starting Genie’s host…” and how long, in seconds', () => {
        expect(hostWaitWords(12_400)).toEqual({ title: 'Starting Genie’s host…', detail: 'The first start can take a minute. 12 s so far.' });
        expect(hostWaitWords(0).title).toBe('Starting Genie’s host…');
    });

    it('nothing for a quick start; shown once it takes longer, updated, and closed when the host is ready', () => {
        const seen: string[] = [];
        const wait = new HostWait({ open: (t, d) => seen.push(`open ${t} | ${d}`), update: (d) => seen.push(`update ${d}`), close: () => seen.push('close') });
        wait.progress(HOST_WAIT_SHOW_AFTER_MS - 1);
        expect(seen).toEqual([]);
        wait.progress(HOST_WAIT_SHOW_AFTER_MS);
        wait.progress(HOST_WAIT_SHOW_AFTER_MS + 1_000);
        wait.done();
        wait.done();
        expect(seen).toEqual([
            `open Starting Genie’s host… | ${hostWaitWords(HOST_WAIT_SHOW_AFTER_MS).detail}`,
            `update ${hostWaitWords(HOST_WAIT_SHOW_AFTER_MS + 1_000).detail}`,
            'close',
        ]);
        expect(HOST_WAIT_SHOW_AFTER_MS).toBeGreaterThan(0);
        expect(HOST_WAIT_SHOW_AFTER_MS).toBeLessThanOrEqual(3_000);
    });

    it('CONTROL: a quick start never opens it, and done() closes nothing', () => {
        const seen: string[] = [];
        const wait = new HostWait({ open: () => seen.push('open'), update: () => seen.push('update'), close: () => seen.push('close') });
        wait.progress(200);
        wait.done();
        expect(seen).toEqual([]);
    });
});

describe('the window is wired to it', () => {
    it('the window shows the wait while it links, and closes it before anything else is shown', () => {
        const main = src('src/main/main.ts');
        expect(main).toMatch(/const hostWait = new HostWait\(/);
        expect(main).toMatch(/onWaiting: \(elapsedMs\) => hostWait\.progress\(elapsedMs\)/);
        const linked = main.indexOf('agentEngineLink = await connectAgentEngine(');
        const closed = main.indexOf('hostWait.done();', linked);
        expect(closed).toBeGreaterThan(linked);
        expect(closed).toBeLessThan(main.indexOf('if (agentEngineLink === null) {', linked));
    });

    it('no fixed start deadline is given to the link', () => {
        expect(src('src/main/agent-engine.ts')).not.toMatch(/startTimeoutMs: (?!1\b)\d/);
        expect(src('src/main/main.ts')).not.toMatch(/startTimeoutMs/);
    });
});

describe('a host that starts late, for the real-window test', () => {
    it('delays its readiness only when the test asks, and never past two minutes', () => {
        expect(testReadyDelayMs({})).toBe(0);
        expect(testReadyDelayMs({ GENIE_TEST_HOST_READY_DELAY_MS: '25000' })).toBe(25_000);
        expect(testReadyDelayMs({ GENIE_TEST_HOST_READY_DELAY_MS: 'soon' })).toBe(0);
        expect(testReadyDelayMs({ GENIE_TEST_HOST_READY_DELAY_MS: '999999' })).toBe(120_000);
    });

    it('genie-host waits for it just before it writes the record a window links to', () => {
        const host = src('src/main/genie-host.ts');
        const delay = host.indexOf('await sleepFor(testReadyDelayMs(process.env));');
        expect(delay).toBeGreaterThan(-1);
        expect(delay).toBeLessThan(host.indexOf('await writeTextPrivate(recordFile, JSON.stringify(record));'));
    });

    it('the real-window script starts the host 25 s late and passes only when the window reaches its page', () => {
        const script = readFileSync('scripts/host-late-ready-cdp.mjs', 'utf8');
        expect(script).toMatch(/GENIE_TEST_HOST_READY_DELAY_MS: '25000'/);
        expect(script).toMatch(/page target/);
    });
});

describe('what takes the time is measured', () => {
    it('each boot step up to serving is timed in the lifecycle log, and so is making the CA', () => {
        const host = src('src/main/genie-host.ts');
        for (const step of ['settings', 'agent stores', 'registry', 'app door', 'hosting', 'mcp', 'spawn hosts']) expect(host, step).toContain(`bootStep('${step}'`);
        expect(src('src/main/gen-ca.ts')).toMatch(/created a new CA in \$\{/);
    });
});
