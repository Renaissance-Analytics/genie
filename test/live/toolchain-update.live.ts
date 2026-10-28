/**
 * genie#1306 — A REAL LANGUAGE UPDATE, END TO END, ON A TEST VM (never on the owner's desktop).
 *
 *   Windows (genie-test-windows):  npx tsx test/live/toolchain-update.live.ts php
 *   Linux   (omarchy-test):        npx tsx test/live/toolchain-update.live.ts node go python
 *
 * For each language it builds the owner's starting point — an OLD version that Genie did not install through any package
 * manager, first on PATH (PHP 8.4.24 in Genie 1's `%APPDATA%\genie\toolchain\php\8.4.24` layout, the owner's exact case;
 * Node 24.19.0 and Go 1.25.6 from their official archives; Python: the system's own) — then runs THE SAME update main.ts
 * runs (`runUpdate` with Genie's own installers and `current/<lang>` link: real downloads, real checksums, real unpacks
 * and builds) and measures:
 *
 *   1. the outcome is `repaired` from the old version to the target the panel offers first (the patch);
 *   2. no package manager ran (no `winget upgrade`, no apt/dnf/brew);
 *   3. `<lang>` on Genie's PATH now answers the target, and a process started afresh (what a restart gets) runs it;
 *   4. `current/<lang>` is a link into `<lang>-versions/<target>` — the default moved;
 *   5. the row's steps were reported (downloading/verifying …, switching …).
 *
 * The OLD versions are fixtures. PHP 8.4.24 is archived, and windows.php.net publishes no checksum for archived builds
 * (the very thing #1306 found), so the fixture zip is unverified — it is never served, only asked for `php -v`.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { updateChoices, type LanguageTool } from '../../src/core/toolchain-update.js';
import { versionDir, currentLinkDir } from '../../src/core/toolchain-defaults.js';
import { installGoVersion, goVersionsRoot, managedGo } from '../../src/main/go-versions.js';
import { installNodeVersion, managedNode, nodeVersionsRoot } from '../../src/main/node-versions.js';
import { httpFetch, installPhpVersion, managedPhp, nodePhpVersionsFs, phpVersionsRoot } from '../../src/main/php-versions.js';
import { installPythonVersion, managedPython, pythonVersionsRoot } from '../../src/main/python-versions.js';
import { listDefaults, nodeLinkFs, restoreDefaultsEnv, setDefault } from '../../src/main/toolchain-defaults.js';
import { installTool, nodeToolchainFs, processEnv } from '../../src/main/toolchain-ops.js';
import { runUpdate, type CommandRunner, type LanguageUpdatePorts } from '../../src/main/toolchain-prober.js';
import { execFileRunner } from '../../src/main/toolchain-runner.js';
import type { Platform } from '../../src/core/toolchain.js';

const platform = process.platform as Platform;
const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
const results: boolean[] = [];
const check = (ok: boolean, label: string, detail = '') => { results.push(ok); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`); };

const base = mkdtempSync(join(tmpdir(), 'genie-1306-'));
const toolchainDir = join(base, 'genie2-toolchain');
const ran: string[][] = [];
const run: CommandRunner = async (binary, args, options) => {
    ran.push([binary, ...args]);
    return execFileRunner(binary, args, { timeoutMs: 45 * 60_000, ...(options?.env ? { env: options.env } : {}) });
};
const fs = nodePhpVersionsFs();
const linkFs = nodeLinkFs(platform);
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

async function bytes(url: string): Promise<Uint8Array> {
    const r = await httpFetch.bytes(url);
    if (!r.ok) throw new Error(`${url}: ${r.error}`);
    return r.body;
}
async function text(url: string): Promise<string> {
    const r = await httpFetch.text(url);
    if (!r.ok) throw new Error(`${url}: ${r.error}`);
    return r.body;
}
function unpack(archive: string, into: string): void {
    mkdirSync(into, { recursive: true });
    if (archive.endsWith('.zip') && platform === 'win32') execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${into}' -Force`]);
    else execFileSync('tar', ['-xzf', archive, '-C', into]);
}
const prependPath = (dir: string) => { process.env['PATH'] = `${dir}${platform === 'win32' ? ';' : ':'}${process.env['PATH'] ?? ''}`; };

/** The owner's starting point for each language: the old version, first on PATH, installed by no package manager. */
async function oldVersion(lang: LanguageTool): Promise<string> {
    const legacy = join(base, platform === 'win32' ? 'AppData/Roaming/genie/toolchain' : 'legacy', lang);
    if (lang === 'php') {
        // Genie 1's layout and build (ZTS), as on the owner's machine: %APPDATA%\genie\toolchain\php\8.4.24.
        const file = 'php-8.4.24-Win32-vs17-x64.zip';
        const zip = join(base, file);
        writeFileSync(zip, await bytes(`https://windows.php.net/downloads/releases/archives/${file}`));
        const dir = join(legacy, '8.4.24');
        unpack(zip, dir);
        prependPath(dir);
        return '8.4.24';
    }
    if (lang === 'node') {
        const v = '24.19.0';
        const os = platform === 'win32' ? 'win' : 'linux';
        const file = `node-v${v}-${os}-${arch}.${platform === 'win32' ? 'zip' : 'tar.gz'}`;
        const body = await bytes(`https://nodejs.org/dist/v${v}/${file}`);
        const sums = await text(`https://nodejs.org/dist/v${v}/SHASUMS256.txt`);
        if (!sums.split('\n').some((l) => l.startsWith(sha(body)) && l.trim().endsWith(file))) throw new Error(`${file} does not match nodejs.org's SHASUMS256`);
        const archive = join(base, file);
        writeFileSync(archive, body);
        unpack(archive, legacy);
        prependPath(join(legacy, file.replace(/\.(zip|tar\.gz)$/, ''), platform === 'win32' ? '' : 'bin'));
        return v;
    }
    if (lang === 'go') {
        const v = '1.25.6';
        const file = `go${v}.${platform === 'win32' ? 'windows' : 'linux'}-${arch === 'x64' ? 'amd64' : 'arm64'}.${platform === 'win32' ? 'zip' : 'tar.gz'}`;
        const body = await bytes(`https://go.dev/dl/${file}`);
        const index = JSON.parse(await text('https://go.dev/dl/?mode=json&include=all')) as Array<{ files: Array<{ filename: string; sha256: string }> }>;
        const want = index.flatMap((r) => r.files).find((f) => f.filename === file)?.sha256;
        if (want !== sha(body)) throw new Error(`${file} does not match go.dev's sha256`);
        const archive = join(base, file);
        writeFileSync(archive, body);
        unpack(archive, legacy);
        prependPath(join(legacy, 'go', 'bin'));
        return v;
    }
    // Python: the system's own interpreter is the old version.
    const out = execFileSync('python', ['--version'], { encoding: 'utf8' });
    return /Python (\d+\.\d+\.\d+)/.exec(out)![1]!;
}

const ports = (lang: LanguageTool) => {
    const root = lang === 'php' ? phpVersionsRoot(toolchainDir) : lang === 'node' ? nodeVersionsRoot(toolchainDir) : lang === 'go' ? goVersionsRoot(toolchainDir) : pythonVersionsRoot(toolchainDir);
    return { platform, arch, root, fs, run, fetchBytes: httpFetch.bytes, fetchText: httpFetch.text, cpus: availableParallelism() } as const;
};
const steps: string[] = [];
const languages: LanguageUpdatePorts = {
    install: async (tool, version) => {
        const progress = (s: string | null) => { if (s) steps.push(s); };
        if (tool === 'php') {
            return installPhpVersion(version, true, {
                ...ports('php'), progress,
                // As main.ts: the Visual C++ runtime PHP links, through T1's consented install, only when it is missing.
                ensureVcRuntime: async () => {
                    const r = await installTool('vcredist', true, { platform, run, env: processEnv, fs: nodeToolchainFs(), dataDir: toolchainDir, systemRoot: process.env['SystemRoot'] ?? 'C:\\Windows', packageManager: async () => 'winget' });
                    return r.kind === 'installed' || r.kind === 'already-installed' ? { ok: true } : { ok: false, reason: r.reason };
                },
            });
        }
        if (tool === 'node') return installNodeVersion(version, true, { ...ports('node'), progress });
        if (tool === 'go') return installGoVersion(version, true, { ...ports('go'), progress });
        return installPythonVersion(version, true, { ...ports('python'), progress });
    },
    setDefault: (tool, version) => {
        const managed = (l: string) => (l === 'php' ? managedPhp(ports('php')) : l === 'node' ? managedNode(ports('node')) : l === 'go' ? managedGo(ports('go')) : managedPython(ports('python'))).map((m) => m.version);
        const outcome = setDefault(tool, version, { platform, toolchainDir, fs: linkFs, managed });
        if (outcome.kind !== 'refused') restoreDefaultsEnv({ platform, toolchainDir, fs: linkFs, env: processEnv });
        return outcome;
    },
    progress: (s) => { if (s) steps.push(s); },
};

const answers = (lang: LanguageTool): string => {
    const [bin, args] = lang === 'go' ? ['go', ['version']] : lang === 'php' ? ['php', ['-r', 'echo PHP_VERSION;']] : [lang, ['--version']];
    // A process started afresh with the environment Genie now gives its children — what a restart gets.
    return execFileSync(bin, args, { encoding: 'utf8', env: process.env, shell: false }).trim();
};

async function updateOne(lang: LanguageTool): Promise<void> {
    console.log(`\n=== ${lang} (${platform}) ===`);
    const from = await oldVersion(lang);
    const started = Date.now();
    console.log(`  before: ${answers(lang)}`);
    const choices = updateChoices(lang, from);
    const target = choices.patch ?? choices.upgrade;
    console.log(`  offered: patch ${choices.patch ?? '—'}, upgrade ${choices.upgrade ?? '—'}; target ${target}`);
    if (!target) { check(false, `${lang}: Genie offers a version to update ${from} to`); return; }
    ran.length = 0;
    steps.length = 0;
    const r = await runUpdate(lang, { platform, packageManager: platform === 'win32' ? 'winget' : 'apt' }, run, null, languages);
    console.log(`  outcome: ${JSON.stringify(r)}  (${Math.round((Date.now() - started) / 1000)} s)`);
    check(r.kind === 'repaired' && 'from' in r && r.from === from && r.to === target, `${lang}: repaired ${from} → ${target}`);
    const pm = ran.filter(([b, ...a]) => (/winget/i.test(b!) && a.includes('upgrade')) || /^(apt|apt-get|dnf|brew|pkexec)$/.test(b!));
    check(pm.length === 0, `${lang}: no package manager ran`, pm.map((c) => c.join(' ')).join('; '));
    const now = answers(lang);
    check(now.includes(target), `${lang}: a fresh process answers ${target}`, now);
    const link = currentLinkDir(toolchainDir, lang);
    let points = '';
    try { points = resolve(dirname(link), readlinkSync(link).replace(/^\\\\\?\\/, '')); } catch (e) { points = String(e); }
    check(points.toLowerCase() === versionDir(toolchainDir, lang, target).toLowerCase() && listDefaults({ platform, toolchainDir, fs: linkFs })[lang] === target, `${lang}: current/${lang} → ${lang}-versions/${target}`, points);
    check(steps.some((s) => /download/i.test(s)) && steps.some((s) => /verif|checking/i.test(s)) && steps.some((s) => /switch/i.test(s)), `${lang}: progress steps reported`, steps.join(' | '));
}

const langs = process.argv.slice(2) as LanguageTool[];
try {
    for (const lang of langs) {
        try {
            await updateOne(lang);
        } catch (error) {
            check(false, `${lang}: ran to the end`, error instanceof Error ? error.stack ?? error.message : String(error));
        }
    }
} finally {
    if (existsSync(base)) rmSync(base, { recursive: true, force: true });
}
const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 && results.length > 0 ? 0 : 1);
