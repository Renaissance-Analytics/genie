/**
 * ACCEPTANCE — GENIE'S OWN PYTHON ON WINDOWS, FOR REAL (plan `.ai/plans/genie-2-toolchain-rest.md`, TC4a). Runs in the
 * Windows test VM with the PRODUCT's functions and real effects: python.org's real zip, its real `index-windows.json`
 * for the sha256, the real Expand-Archive, and the real python.
 *
 *   1. a tampered index (wrong sha256) is refused, and nothing of it is left;
 *   2. Install Python: installed; it names the version; a venv is made and pip installs a package into it;
 *   2b. Python as the DEFAULT (TC4a-2): through the product's setDefault + restoreDefaultsEnv, `python` and `pip`
 *       resolve BY NAME to Genie's copy (ahead of the Store alias), and a console script pip installs runs by name;
 *   3. nothing was registered: HKCU\Software\Python does not exist — with a POSITIVE CONTROL first, proving the same
 *      `reg query` sees a key that does exist;
 *   4. listed as managed; Remove deletes it and it is no longer listed.
 *
 * On LINUX (TC4b) it builds python.org's source for real: a tampered sha256 refused with nothing left; the build
 * installed and proven; `python` and `pip` (the links) answer; a venv + pip install; as the DEFAULT, `python`, `pip`
 * and a console script pip installs resolve BY NAME through current/python/bin; removed. On macOS: refused by name.
 *
 * Usage (in the VM, from the repo): npx tsx scripts/acceptance-python.ts
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';
import { PYTHON_RECIPES } from '../src/core/python-versions.js';
import { nodeLinkFs, restoreDefaultsEnv, setDefault } from '../src/main/toolchain-defaults.js';
import { installPythonVersion, listPythonVersions, managedPython, removePythonVersion, type PythonVersionsPorts } from '../src/main/python-versions.js';
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
        platform, arch: process.arch === 'arm64' ? 'arm64' : 'x64', root, fs: nodePhpVersionsFs(), run, cpus: availableParallelism(),
        fetchBytes: async (u) => { downloads += 1; return httpFetch.bytes(u); }, fetchText: httpFetch.text, progress: (s) => { if (s) console.log(`    … ${s}`); },
    };
    const V = PYTHON_RECIPES[0]!.version;

    if (platform === 'darwin') {
        console.log('macOS: refused by name until it can be proven on a Mac');
        const r = await installPythonVersion(V, true, ports);
        check(r.kind === 'refused' && /macOS/.test(r.reason), 'install refused by name', r.kind === 'refused' ? r.reason : r.kind);
        check(downloads === 0, 'nothing was downloaded', String(downloads));
        check((await listPythonVersions(ports)).available.length === 0, 'nothing is offered');
    } else if (platform === 'linux') {
        console.log("1. a tampered release-files API");
        const tampered = await installPythonVersion(V, true, { ...ports, fetchText: async (u) => { const r = await httpFetch.text(u); return r.ok ? { ok: true, body: r.body.replace(/"sha256_sum":\s*"[0-9a-f]{64}"/g, `"sha256_sum":"${'f'.repeat(64)}"`) } : r; } });
        check(tampered.kind === 'not-installed' && /does not match the sha256 python\.org publishes/.test(tampered.kind === 'not-installed' ? tampered.reason : ''), 'refused on a checksum mismatch', tampered.kind === 'not-installed' ? tampered.reason.slice(0, 140) : tampered.kind);
        check(nodePhpVersionsFs().list(root).length === 0, 'nothing of it is left', nodePhpVersionsFs().list(root).join(', '));

        console.log(`2. Build Python ${V} from python.org's source`);
        const t0 = Date.now();
        const installed = await installPythonVersion(V, true, ports);
        check(installed.kind === 'installed', `built and installed in ${Math.round((Date.now() - t0) / 1000)} s`, installed.kind === 'installed' ? installed.dir : JSON.stringify(installed));
        if (installed.kind !== 'installed') return;
        const bin = join(installed.dir, 'bin');
        check(execFileSync(join(bin, 'python'), ['--version'], { encoding: 'utf8' }).trim() === `Python ${V}`, '`bin/python` (the link) names it');
        check(execFileSync(join(bin, 'pip'), ['--version'], { encoding: 'utf8' }).includes(installed.dir), '`bin/pip` (the link) is its pip');
        check(nodePhpVersionsFs().list(root).every((e) => !e.startsWith('.')), 'no staging or tarball left', nodePhpVersionsFs().list(root).join(', '));
        const venv = join(mkdtempSync(join(tmpdir(), 'genie-python-venv-')), 'venv');
        execFileSync(join(bin, 'python'), ['-m', 'venv', venv]);
        execFileSync(join(venv, 'bin', 'pip'), ['install', '-q', '--disable-pip-version-check', 'six']);
        const six = execFileSync(join(venv, 'bin', 'python'), ['-c', 'import six, sys; print(six.__version__, sys.base_prefix)'], { encoding: 'utf8' }).trim();
        check(six.endsWith(installed.dir), 'a venv is made from it, and pip installs into the venv', six);

        console.log('2b. Python as the default');
        const toolchainDir = join(base, 'genie2-toolchain');
        const linkPorts = { platform, toolchainDir, fs: nodeLinkFs(platform) };
        check(setDefault('python', V, { ...linkPorts, managed: () => managedPython(ports).map((m) => m.version) }).kind === 'set', 'setDefault python');
        const childEnv: Record<string, string> = { ...(process.env as Record<string, string>) };
        const applied = restoreDefaultsEnv({ ...linkPorts, env: { get: () => childEnv.PATH, set: (_n, v) => { childEnv.PATH = v; } } });
        check(applied.length === 1 && applied[0] === join(toolchainDir, 'current', 'python', 'bin'), 'current/python/bin first on the PATH', applied.join(' ; '));
        const byName = (cmd: string, ...args: string[]) => execFileSync(cmd, args, { encoding: 'utf8', env: childEnv }).trim();
        check(byName('sh', '-c', 'command -v python') === join(toolchainDir, 'current', 'python', 'bin', 'python'), '`python` by name is current/python/bin/python', byName('sh', '-c', 'command -v python'));
        check(byName('sh', '-c', 'python --version') === `Python ${V}`, '`python --version` names it');
        check(byName('sh', '-c', 'pip --version').includes(installed.dir), '`pip` by name is its pip');
        byName('sh', '-c', 'pip install -q --disable-pip-version-check pyflakes');
        check(byName('sh', '-c', 'pyflakes --version').includes(`Python ${V}`), 'a console script pip installs runs by name');
        check(setDefault('python', null, { ...linkPorts, managed: () => [] }).kind === 'cleared', 'the default cleared');

        console.log('3. list and Remove');
        check((await listPythonVersions(ports)).managed.some((m) => m.version === V), 'listed as managed');
        check(removePythonVersion(V, ports).kind === 'removed' && !(await listPythonVersions(ports)).managed.some((m) => m.version === V), 'removed, and no longer listed');
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

        console.log('2b. Python as the default');
        const toolchainDir = join(base, 'genie2-toolchain');
        const linkPorts = { platform, toolchainDir, fs: nodeLinkFs(platform) };
        const set = setDefault('python', V, { ...linkPorts, managed: () => managedPython(ports).map((m) => m.version) });
        check(set.kind === 'set', 'setDefault python', JSON.stringify(set));
        const childEnv: Record<string, string> = { ...(process.env as Record<string, string>) };
        const pathKey = Object.keys(childEnv).find((k) => k.toLowerCase() === 'path') ?? 'Path';
        const applied = restoreDefaultsEnv({ ...linkPorts, env: { get: () => childEnv[pathKey], set: (_n, v) => { childEnv[pathKey] = v; } } });
        check(applied.length === 2 && applied[1]!.endsWith('Scripts'), 'two entries first on the PATH: python, then Scripts', applied.join(' ; '));
        const byName = (cmd: string) => execFileSync('cmd.exe', ['/d', '/c', cmd], { encoding: 'utf8', env: childEnv }).trim();
        const wherePy = byName('where python').split(/\r?\n/)[0] ?? '';
        check(wherePy.toLowerCase() === join(toolchainDir, 'current', 'python', 'python.exe').toLowerCase(), '`python` by name is current\\python', wherePy);
        check(byName('python --version') === `Python ${V}`, '`python --version` names it', byName('python --version'));
        const pipSays = byName('pip --version');
        check(pipSays.startsWith('pip ') && pipSays.includes(installed.dir), '`pip` by name is that python\'s pip', pipSays);
        byName('pip install --no-input --disable-pip-version-check --quiet pyflakes');
        const flakes = byName('pyflakes --version');
        check(flakes.includes(`Python ${V}`), 'a console script pip installs runs by name', flakes);
        check(setDefault('python', null, { ...linkPorts, managed: () => [] }).kind === 'cleared', 'the default cleared (the link goes, the version stays)');

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
