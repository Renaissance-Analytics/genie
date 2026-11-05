#!/usr/bin/env node
/**
 * ONE REQUEST TO THE TEST VM'S TYNN ALIAS, FOR THE ACCEPTANCE SCRIPTS ON WINDOWS (scripts/upgrade-acceptance-cdp.mjs). Windows' curl refused the alias's answer to a login (batch II: `schannel: server closed abruptly`). This is Node's
 * own HTTPS client, with the certificate checks on: only the alias's CA is trusted, and the name is checked. A separate process, so the callers stay synchronous.
 *
 * Takes JSON on stdin: `{ url, method?, headers?, form?, jar, ca }`. `jar` is a JSON file of cookies, read and written here. Prints `{ status, framing, body }`. A failure exits 1 with its reason on stderr, and never says a header's value.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:https';

const input = JSON.parse(readFileSync(0, 'utf8'));
const jar = existsSync(input.jar) ? JSON.parse(readFileSync(input.jar, 'utf8')) : {};
const body = input.form ? new URLSearchParams(input.form).toString() : null;
const cookie = Object.entries(jar).map(([name, value]) => `${name}=${value}`).join('; ');
const headers = {
    'User-Agent': 'Genie-upgrade-acceptance',
    ...(input.headers ?? {}),
    ...(cookie ? { Cookie: cookie } : {}),
    ...(body === null ? {} : { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }),
};
const fail = (why) => { console.error(`${input.method ?? 'GET'} ${new URL(input.url).pathname}: ${why}`); process.exit(1); };

const req = request(input.url, { method: input.method ?? 'GET', headers, ca: readFileSync(input.ca), agent: false, timeout: 25_000 }, (res) => {
    for (const line of res.headers['set-cookie'] ?? []) {
        const [pair, ...attributes] = line.split(';').map((part) => part.trim());
        const at = pair.indexOf('=');
        const gone = attributes.some((a) => /^max-age=0$/i.test(a));
        if (gone) delete jar[pair.slice(0, at)];
        else jar[pair.slice(0, at)] = pair.slice(at + 1);
    }
    writeFileSync(input.jar, JSON.stringify(jar), { mode: 0o600 });
    const chunks = [];
    res.on('data', (chunk) => chunks.push(chunk));
    res.on('error', (error) => fail(error.message));
    res.on('aborted', () => fail('the answer stopped before it was complete'));
    res.on('end', () => {
        const framing = `connection=${res.headers.connection ?? 'none'} content-length=${res.headers['content-length'] ?? 'none'} transfer-encoding=${res.headers['transfer-encoding'] ?? 'none'}`;
        process.stdout.write(JSON.stringify({ status: res.statusCode, framing, body: Buffer.concat(chunks).toString('utf8') }));
    });
});
req.on('timeout', () => req.destroy(new Error('no answer within 25 s')));
req.on('error', (error) => fail(error.message));
req.end(body ?? undefined);
