#!/usr/bin/env node
/**
 * DOES GENIE'S RUNTIME REALLY SEND THE ORIGIN? (genie#1478) `src/main/tynn-socket.ts` passes the header through the
 * WebSocket that main has: the one bundled inside Electron, not `node_modules/undici`. Nothing but running it under that
 * binary can say whether the header goes out, so this does, with the same constructor call.
 *
 * Run it in a test VM, from a Genie checkout with its dependencies installed:
 *
 *   ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron scripts/perf-lag/reverb-origin-probe.mjs
 *   # Windows VM, from Git Bash: ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe scripts/perf-lag/reverb-origin-probe.mjs
 *
 * Exit 0 = every check passed; the last line of output is the whole result as JSON. It needs no account and changes nothing:
 *
 *  - LOCAL, against scripts/perf-lag/fake-reverb.mjs: what arrives on the wire with no Origin (the control), with Genie's
 *    and with a wrong one, and what each is answered.
 *  - PRODUCTION, on the same three dials unauthenticated: the Reverb host and public key come from Tynn's
 *    `/api/v1/broadcasting-config` or, as that answers 404 with no account, its public JS bundle. It never subscribes.
 *  - TLS: the default verification is still on. A server with a self-signed certificate must not open.
 *
 * `--local` skips production and TLS (what `npm test` runs on CI, so CI does not depend on production's being up).
 * `--tynn <url>` names another Tynn. `--any-runtime` allows plain Node; otherwise this refuses to run outside Electron,
 * because a pass under Node says nothing about what Genie ships.
 */
import { connect } from 'node:tls';
import { startFakeReverb } from './fake-reverb.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const LOCAL_ONLY = flag('--local');
const ORIGIN = new URL(flag('--tynn') ? args[args.indexOf('--tynn') + 1] : 'https://tynn.ai').origin;
const DIAL_MS = 10_000;

const checks = [];
function check(name, pass, detail) {
    checks.push({ name, pass, detail });
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}\n      ${detail}`);
}

/** One dial: resolves with the first thing the server says (or that it closed, errored, or said nothing in time). */
function dial(url, init) {
    return new Promise((resolve) => {
        let opened = false;
        let settled = false;
        // The same call as src/main/tynn-socket.ts.
        const socket = init === undefined ? new WebSocket(url) : new WebSocket(url, init);
        const done = (result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try { socket.close(); } catch { /* already closing */ }
            resolve({ opened, ...result });
        };
        const timer = setTimeout(() => { done({ silent: true }); }, DIAL_MS);
        socket.addEventListener('open', () => { opened = true; });
        socket.addEventListener('message', (e) => { done({ frame: String(e.data) }); });
        socket.addEventListener('error', (e) => { done({ error: String(e.message ?? e.error?.message ?? 'error') }); });
        socket.addEventListener('close', (e) => { done({ closed: e.code }); });
    });
}

const eventOf = (r) => { try { return JSON.parse(r.frame ?? '{}').event ?? null; } catch { return null; } };
const refused = (r) => eventOf(r) === 'pusher:error' && /4009/.test(r.frame) && /Origin not allowed/.test(r.frame);
const said = (r) => JSON.stringify(r);

async function local() {
    const reverb = await startFakeReverb({ allowedOrigins: [ORIGIN] });
    try {
        const none = await dial(reverb.url());
        check('local CONTROL: no option, no Origin on the wire, refused', reverb.connections[0]?.origin === null && refused(none), `wire: ${reverb.connections[0]?.origin}; answer: ${said(none)}`);
        const genie = await dial(reverb.url(), { headers: { Origin: ORIGIN } });
        check(`local: the declared Origin is on the wire, exactly, and accepted`, reverb.connections[1]?.origin === ORIGIN && eventOf(genie) === 'pusher:connection_established', `wire: ${reverb.connections[1]?.origin}; answer: ${said(genie)}`);
        const wrong = await dial(reverb.url(), { headers: { Origin: 'https://example.com' } });
        check('local CONTROL: a wrong Origin is on the wire, and refused', reverb.connections[2]?.origin === 'https://example.com' && refused(wrong), `wire: ${reverb.connections[2]?.origin}; answer: ${said(wrong)}`);
    } finally {
        await reverb.close();
    }
}

/** Where production's Reverb is: its config route (a 404 with no account, as every refusal is), else its public bundle. */
async function productionSocket() {
    const config = await fetch(`${ORIGIN}/api/v1/broadcasting-config`).catch(() => null);
    if (config?.ok) {
        const c = await config.json();
        if (c.host && c.key) return { key: c.key, host: c.host, port: Number(c.port ?? 443), from: 'broadcasting-config' };
    }
    const home = await (await fetch(`${ORIGIN}/`)).text();
    const scripts = [...home.matchAll(/src="([^"]*\/build\/assets\/[^"]+\.js)"/g)].map((m) => new URL(m[1], ORIGIN).href);
    for (const script of scripts) {
        const bundle = await (await fetch(script)).text();
        const key = /VITE_REVERB_APP_KEY:"([^"]+)"/.exec(bundle)?.[1];
        const host = /VITE_REVERB_HOST:"([^"]+)"/.exec(bundle)?.[1];
        if (key && host) return { key, host, port: Number(/VITE_REVERB_PORT:"([^"]+)"/.exec(bundle)?.[1] ?? 443), from: script };
    }
    return null;
}

async function production() {
    let where = null;
    try { where = await productionSocket(); } catch (error) { check('production: found its Reverb', false, String(error)); return; }
    if (where === null) { check('production: found its Reverb', false, 'neither the config route nor the public bundle names it'); return; }
    check('production: found its Reverb', true, `${where.host}:${where.port} (from ${where.from})`);
    const url = `wss://${where.host}:${where.port}/app/${encodeURIComponent(where.key)}?protocol=7&client=genie&version=2.0`;
    const none = await dial(url);
    check('production CONTROL: no Origin is refused with 4009', refused(none), said(none));
    const genie = await dial(url, { headers: { Origin: ORIGIN } });
    check(`production: Origin ${ORIGIN} gets connection_established, with no account`, eventOf(genie) === 'pusher:connection_established', said(genie));
    const wrong = await dial(url, { headers: { Origin: 'https://example.com' } });
    check('production CONTROL: a wrong Origin is refused with 4009', refused(wrong), said(wrong));
}

async function tls() {
    check('TLS: nothing has switched verification off', process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0', `NODE_TLS_REJECT_UNAUTHORIZED=${process.env.NODE_TLS_REJECT_UNAUTHORIZED ?? '<unset>'}`);
    // CONTROL: the server is there and its certificate is the reason, so "did not open" cannot mean "no network".
    const reached = await new Promise((resolve) => {
        const raw = connect({ host: 'self-signed.badssl.com', port: 443, servername: 'self-signed.badssl.com' });
        raw.once('secureConnect', () => { raw.destroy(); resolve('verified'); });
        raw.once('error', (error) => { raw.destroy(); resolve(error.code ?? String(error)); });
    });
    check('TLS CONTROL: the self-signed server is reachable, and its certificate is what fails', /SELF_SIGNED/.test(reached), reached);
    const bad = await dial('wss://self-signed.badssl.com/', { headers: { Origin: ORIGIN } });
    check('TLS: that server does not open, with the same call', !bad.opened && bad.silent !== true, `${said(bad)} (the production dial above, on this same call, is the control that a good certificate opens)`);
}

const runtime = { electron: process.versions.electron ?? null, node: process.versions.node, undici: process.versions.undici ?? null, runAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null, webSocket: typeof WebSocket };
console.log(`runtime ${JSON.stringify(runtime)}`);
if (runtime.electron === null && !flag('--any-runtime')) {
    check('the runtime is Electron', false, 'run this with ELECTRON_RUN_AS_NODE=1 and Electron\'s binary; a pass under Node says nothing about what Genie ships');
} else {
    await local();
    if (!LOCAL_ONLY) {
        await production();
        await tls();
    }
}
const pass = checks.length > 0 && checks.every((c) => c.pass);
console.log(JSON.stringify({ pass, runtime, checks }));
process.exit(pass ? 0 : 1);
