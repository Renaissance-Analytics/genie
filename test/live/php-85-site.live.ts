/**
 * PHP 8.5 INSTALLS THROUGH GENIE AND SERVES A SITE, WITH OPCACHE ON (genie#1394). On a TEST VM only:
 *
 *   Windows (genie-test-windows):  npx tsx scripts/fetch-caddy.ts; npx tsx test/live/php-85-site.live.ts
 *
 * 8.5.12 failed to install on Windows: Genie's php.ini loaded opcache as a zend_extension, and 8.5 has it built in (there
 * is nothing to load), so php-cgi's start-up check refused the version. For each of 8.5.12 and 8.4.27 (the control: the
 * version that always installed), this installs it through Genie's own installer, then serves one PHP site through
 * Genie's real composition on that php-cgi and asks the site which PHP answered and whether opcache is on in it.
 *
 * Exits 1 on any FAIL.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PhpPlatform } from '../../src/core/php-versions.js';
import { httpFetch, installPhpVersion, managedPhp, nodePhpVersionsFs, phpVersionsRoot, resolvePhpCgi } from '../../src/main/php-versions.js';
import { execFileRunner } from '../../src/main/toolchain-runner.js';
import type { CommandRunner } from '../../src/main/toolchain-prober.js';
import { composeServices } from '../../src/main/compose.js';
import { realFancyTermPort } from '../../src/main/fancy-term-port.js';
import { siteAnswers } from '../../src/main/port-probe.js';

const platform = process.platform as PhpPlatform;
const failures: string[] = [];
function check(ok: boolean, label: string, detail = ''): void {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
    if (!ok) failures.push(label);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const get = (port: number) => new Promise<{ status: number; body: string }>((resolve) => {
    const req = request({ host: '127.0.0.1', port, path: '/', timeout: 30_000, agent: false }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', () => resolve({ status: 0, body: '' }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '' }); });
    req.end();
});

async function main(): Promise<void> {
    const caddyBin = join(process.cwd(), 'build', 'runtime', platform === 'win32' ? 'caddy.exe' : 'caddy');
    check(existsSync(caddyBin), '0. CONTROL: Genie’s pinned Caddy is here', caddyBin);
    const base = mkdtempSync(join(tmpdir(), 'genie-1394-'));
    const root = phpVersionsRoot(join(base, 'toolchain'));
    const run: CommandRunner = (binary, args, options) => execFileRunner(binary, args, { timeoutMs: 45 * 60_000, ...(options?.env ? { env: options.env } : {}) });
    const ports = { platform, root, fs: nodePhpVersionsFs(), run, fetchBytes: httpFetch.bytes, fetchText: httpFetch.text, cpus: availableParallelism(), progress: () => {} } as Parameters<typeof installPhpVersion>[2];

    const userData = join(base, 'home');
    const ws = join(base, 'acme');
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, 'project.json'), `${JSON.stringify({ name: 'acme', repos: [] }, null, 2)}\n`);
    const encryptor = { isAvailable: () => true, encrypt: (b: Buffer) => b, decrypt: (b: Buffer) => b };
    const cgiPorts: Parameters<typeof resolvePhpCgi>[1] = { platform, root, fs: nodePhpVersionsFs() };
    const composed = await composeServices({
        userData, pty: realFancyTermPort(userData, encryptor as never), v1Settings: () => null, caddyBin, frontDoorPort: 0,
        docker: async () => ({ stdout: '', exitCode: 0 }), portFree: async () => true,
        workspaces: () => [{ id: 'acme', path: ws }],
        siteProbe: (port, options) => siteAnswers(port, options),
        // A PINNED site runs that managed version's php-cgi with its own php.ini (-c), as main.ts wires it.
        resolvePhpCgi: (pin) => resolvePhpCgi(pin, cgiPorts),
    });

    try {
        console.log(`\ngenie#1394 live — ${platform}\n`);
        for (const version of ['8.5.12', '8.4.27']) {
            const outcome = await installPhpVersion(version, true, ports);
            check(outcome.kind === 'installed', `${version}: installs through Genie's installer`, outcome.kind === 'installed' ? outcome.dir : JSON.stringify(outcome).slice(0, 400));
            if (outcome.kind !== 'installed') continue;
            const ini = readFileSync(join(outcome.dir, 'php.ini'), 'utf8');
            console.log(`    php.ini opcache lines: ${ini.split(/\r?\n/).filter((l) => /opcache/.test(l) && !l.startsWith(';')).slice(0, 3).join(' | ')}`);
            check(managedPhp(ports).some((m) => m.version === version), `${version}: listed as a managed version a site can pin`);
            const name = `v${version.replaceAll('.', '')}`;
            const dir = join(ws, name);
            mkdirSync(join(dir, 'public'), { recursive: true });
            writeFileSync(join(dir, 'public', 'index.php'), `<?php $s = function_exists('opcache_get_status') ? opcache_get_status(false) : false; echo PHP_VERSION, ' opcache=', is_array($s) && !empty($s['opcache_enabled']) ? 'on' : 'off';\n`);
            const site = composed.sites.create({ name, workspaceId: 'acme', repoPath: dir, serve: { mode: 'php', root: 'public', version } });
            let answer = { status: 0, body: '' };
            for (let i = 0; i < 120 && answer.status !== 200; i += 1) { await sleep(500); answer = await get(composed.sites.get(site.id)!.port!); }
            console.log(`    ${name}.gen answered ${answer.status}: ${answer.body.slice(0, 120)}`);
            check(answer.status === 200 && answer.body.startsWith(`${version} `), `${version}: a PHP site pinned to it serves, on that version`, answer.body.slice(0, 80));
            check(/opcache=on/.test(answer.body), `${version}: opcache is ON in the site's php-cgi`, answer.body.slice(0, 80));
            await sleep(1_000);
            check(composed.sites.get(site.id)?.state === 'running', `${version}: Genie reads the site running`, composed.sites.get(site.id)?.state ?? 'gone');
            composed.sites.remove(site.id);
            await sleep(2_000);
        }
    } finally {
        await composed.shutdown();
        console.log(`\n${failures.length === 0 ? 'ALL PASS' : `${failures.length} FAIL: ${failures.join('; ')}`}`);
    }
}

main().then(() => process.exit(failures.length === 0 ? 0 : 1), (error: unknown) => { console.error(error); process.exit(1); });
