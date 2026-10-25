/**
 * ACCEPTANCE — GENIE'S OWN PYTHON ON WINDOWS, FOR REAL (plan `.ai/plans/genie-2-toolchain-rest.md`, TC4a). Runs in the
 * Windows test VM with the PRODUCT's functions and real effects: python.org's real zip, its real `index-windows.json`
 * for the sha256, the real Expand-Archive, and the real python.
 *
 *   1. a tampered index (wrong sha256) is refused, and nothing of it is left;
 *   2. Install Python: installed; it names the version; a venv is made and pip installs a package into it;
 *   3. nothing was registered: HKCU\Software\Python does not exist — with a POSITIVE CONTROL first, proving the same
 *      `reg query` sees a key that does exist;
 *   4. listed as managed; Remove deletes it and it is no longer listed.
 *
 * On macOS/Linux it checks the other contract: install is refused by name and nothing is downloaded.
 *
 * Usage (in the VM, from the repo): npx tsx scripts/acceptance-python.ts
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PYTHON_RECIPES } from '../src/core/python-versions.js';
import { installPythonVersion, listPythonVersions, removePythonVersion, type PythonVersionsPorts } from '../src/main/python-versions.js';
import { httpFetch, nodePhpVersionsFs } from '../src/main/php-versions.js';
import { execFileRunner } from '../src/main/toolchain-runner.js';

const results: boolean[] = [];
const check = (ok: boolean, label: string, detail = '') => { results.push(ok); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`); };
// The product's runner for installs (main.ts `longRunner`): an unpack takes longer than the prober's 20 s default.
const run = async (bin: string, args: readonly string[]) => { const r = await execFileRunner(bin, args, { timeoutMs: 30 * 60_000 }); return { stdout: r.stdout, exitCode: r.exitCode }; };
const regHas = (key: string) => spawnSync('reg', ['query', key], { encoding: 'utf8' }).status === 0;

async function main(): Promise<void> {
    const base = mkdtempSync(join(tmpdir(), 'genie-python-accept-'));
    const root = join(base, 'genie2-toolchain', 'python-versions');
    nodePhpVersionsFs().mkdirp(root);
    const platform = process.platform as PythonVersionsPorts['platform'];
    let downloads = 0;
    const ports: PythonVersionsPorts = {
        platform, arch: process.arch === 'arm64' ? 'arm64' : 'x64', root, fs: nodePhpVersionsFs(), run,
        fetchBytes: async (u) => { downloads += 1; return httpFetch.bytes(u); }, fetchText: httpFetch.text, progress: (s) => { if (s) console.log(`    … ${s}`); },
    };
    const V = PYTHON_RECIPES[0]!.version;

    if (platform !== 'win32') {
        console.log(`${platform}: Python is TC4b (from source) — refused by name until then`);
        const r = await installPythonVersion(V, true, ports);
        check(r.kind === 'refused' && /Windows/.test(r.reason), 'install refused by name', r.kind === 'refused' ? r.reason : r.kind);
        check(downloads === 0, 'nothing was downloaded', String(downloads));
        check((await listPythonVersions(ports)).available.length === 0, 'nothing is offered');
    } else {
        console.log('1. a tampered index');
        const tampered = await installPythonVersion(V, true, { ...ports, fetchText: async (u) => { const r = await httpFetch.text(u); return r.ok ? { ok: true, body: r.body.replace(/"sha256":\s*"[0-9a-f]{64}"/g, `"sha256": "${'f'.repeat(64)}"`) } : r; } });
        check(tampered.kind === 'not-installed' && /does not match the sha256 python\.org publishes/.test(tampered.kind === 'not-installed' ? tampered.reason : ''), 'refused on a checksum mismatch', tampered.kind === 'not-installed' ? tampered.reason.slice(0, 140) : tampered.kind);
        check(nodePhpVersionsFs().list(root).length === 0, 'nothing of it is left', nodePhpVersionsFs().list(root).join(', '));

        console.log(`2. Install Python ${V}`);
        const t0 = Date.now();
        const installed = await installPythonVersion(V, true, ports);
        check(installed.kind === 'installed', `installed in ${Math.round((Date.now() - t0) / 1000)} s`, installed.kind === 'installed' ? installed.dir : JSON.stringify(installed));
        if (installed.kind !== 'installed') return;
        const py = join(installed.dir, 'python.exe');
        const said = execFileSync(py, ['--version'], { encoding: 'utf8' }).trim();
        check(said === `Python ${V}`, 'it names the version', said);
        const venv = join(mkdtempSync(join(tmpdir(), 'genie-python-venv-')), 'venv');
        execFileSync(py, ['-m', 'venv', venv]);
        const vpy = join(venv, 'Scripts', 'python.exe');
        execFileSync(vpy, ['-m', 'pip', 'install', '--no-input', '--disable-pip-version-check', 'six'], { encoding: 'utf8' });
        const six = execFileSync(vpy, ['-c', 'import six, sys; print(six.__version__, sys.base_prefix)'], { encoding: 'utf8' }).trim();
        check(six.endsWith(installed.dir), 'a venv is made from it, and pip installs into the venv', six);

        console.log('3. nothing registered');
        const control = 'HKCU\\Software\\GenieAcceptanceControl';
        execFileSync('reg', ['add', control, '/f']);
        check(regHas(control), 'CONTROL: reg query sees a key that exists');
        execFileSync('reg', ['delete', control, '/f']);
        check(!regHas('HKCU\\Software\\Python'), 'HKCU\\Software\\Python does not exist');

        console.log('4. list and Remove');
        check((await listPythonVersions(ports)).managed.some((m) => m.version === V), 'listed as managed');
        check(removePythonVersion(V, ports).kind === 'removed' && !(await listPythonVersions(ports)).managed.some((m) => m.version === V), 'removed, and no longer listed');
    }

    console.log(`\n${results.every(Boolean) ? 'ACCEPTANCE PASSED' : 'ACCEPTANCE FAILED'} (${results.filter(Boolean).length}/${results.length})`);
    if (!results.every(Boolean)) process.exitCode = 1;
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
