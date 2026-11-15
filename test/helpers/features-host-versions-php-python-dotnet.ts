import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { DOTNET_RECIPES, dotnetArchiveName, dotnetDownloadUrl, dotnetReleasesUrl } from '../../src/core/dotnet-versions.js';
import { PHP_INI_EXTENSIONS, PHP_RECIPES, PHP_WINDOWS_RELEASES_JSON, phpBuildUrls, phpZipName } from '../../src/core/php-versions.js';
import { PYTHON_PROOF_ARGS, PYTHON_RECIPES, PYTHON_WIN_INDEX, pythonArchiveName, pythonDownloadUrl } from '../../src/core/python-versions.js';
import { currentLinkDir, type DefaultLang } from '../../src/core/toolchain-defaults.js';
import { installDotnetVersion, listDotnetVersions, managedDotnet, removeDotnetVersion, type DotnetVersionsPorts } from '../../src/main/dotnet-versions.js';
import { installPhpVersion, listPhpVersions, managedPhp, removePhpVersion, type PhpVersionsFs, type PhpVersionsPorts, type SitePin } from '../../src/main/php-versions.js';
import { installPythonVersion, listPythonVersions, managedPython, removePythonVersion, type PythonVersionsPorts } from '../../src/main/python-versions.js';
import { listDefaults, restoreDefaultsEnv, setDefault, type DefaultsPorts } from '../../src/main/toolchain-defaults.js';
import type { CommandRunner } from '../../src/main/toolchain-prober.js';
import { groupThreeFixture } from './features-host-group3.js';

export const LANGUAGE_TRIPLE = [
    { lang: 'php', label: 'PHP', defaultLabel: 'PHP', install: 'toolchain.installPhp', remove: 'toolchain.removePhp', publisher: 'windows.php.net', hash: 'sha256' },
    { lang: 'python', label: 'Python', defaultLabel: 'Python', install: 'toolchain.installPython', remove: 'toolchain.removePython', publisher: 'python.org', hash: 'sha256' },
    { lang: 'dotnet', label: '.NET SDK', defaultLabel: '.NET', install: 'toolchain.installDotnet', remove: 'toolchain.removeDotnet', publisher: 'Microsoft', hash: 'sha512' },
] as const;
type Lang = (typeof LANGUAGE_TRIPLE)[number]['lang'];

/** Real Windows archive planners on inert OS ports. No native binary, PowerShell or download runs in this fixture. */
export async function phpPythonDotnetVersionsFixture() {
    const base = await groupThreeFixture(), toolchainDir = join('/fixture', 'toolchain');
    const versions = { php: PHP_RECIPES[0]!.version, python: PYTHON_RECIPES[0]!.version, dotnet: DOTNET_RECIPES[0]!.version };
    // Installed inventory is independent of the recipes this release offers; no second-entry assumption.
    const otherVersions = { php: '8.4.27', python: '3.14.9', dotnet: '9.0.319' };
    const roots = { php: join(toolchainDir, 'php-versions'), python: join(toolchainDir, 'python-versions'), dotnet: join(toolchainDir, 'dotnet-versions') };
    const archives = { php: phpZipName(PHP_RECIPES[0]!), python: pythonArchiveName(versions.python, 'x64'), dotnet: dotnetArchiveName(versions.dotnet, 'win-x64') };
    const urls = { php: phpBuildUrls(archives.php)[0]!, python: pythonDownloadUrl(versions.python, 'x64'), dotnet: dotnetDownloadUrl(versions.dotnet, archives.dotnet) };
    const bytes = { php: new TextEncoder().encode('fixture PHP archive'), python: new TextEncoder().encode('fixture Python archive'), dotnet: new TextEncoder().encode('fixture .NET archive') };
    const hashes = { php: createHash('sha256').update(bytes.php).digest('hex'), python: createHash('sha256').update(bytes.python).digest('hex'), dotnet: createHash('sha512').update(bytes.dotnet).digest('hex') };
    const files = new Set<string>(), texts = new Map<string, string>(), events: string[] = [];
    const removals: string[] = [], writtenBytes: Array<{ path: string; bytes: Uint8Array }> = [];
    const under = (file: string, path: string) => file === path || file.startsWith(path + '/') || file.startsWith(path + '\\');
    const fs: PhpVersionsFs = {
        exists: path => [...files].some(file => under(file, path)),
        list: path => [...new Set([...files].filter(file => file !== path && under(file, path)).map(file => file.slice(path.length + 1).split(/[\\/]/)[0]!))],
        mkdirp: path => { files.add(path); },
        writeText: (path, value) => { files.add(path); texts.set(path, value); }, readText: path => texts.get(path) ?? null,
        writeBytes: (path, value) => { files.add(path); writtenBytes.push({ path, bytes: value.slice() }); },
        rename: (from, to) => {
            if (!fs.exists(from) || fs.exists(to)) throw new Error('fixture rename source missing or target exists');
            for (const file of [...files]) if (under(file, from)) {
                files.delete(file); files.add(to + file.slice(from.length));
                if (texts.has(file)) { texts.set(to + file.slice(from.length), texts.get(file)!); texts.delete(file); }
            }
        },
        removeTree: path => { removals.push(path); events.push('remove:' + path); for (const file of [...files]) if (under(file, path)) { files.delete(file); texts.delete(file); } },
    };
    const badHash = { php: false, python: false, dotnet: false }, proofVersion = { ...versions };
    const faults = { phpNts: true, phpModules: [...PHP_INI_EXTENSIONS], vcReason: null as string | null, pipFailure: false, dotnetSdkPath: null as string | null };
    const downloads: Array<{ lang: Lang; url: string }> = [], metadata: Array<{ lang: Lang; url: string }> = [];
    const commands: Array<{ binary: string; args: readonly string[] }> = [], progress: Array<string | null> = [];
    let vcCalls = 0;
    const binary = (lang: Lang, version = versions[lang]) => join(roots[lang], version, lang === 'php' ? 'php-cgi.exe' : lang === 'python' ? 'python.exe' : 'dotnet.exe');
    const banner = () => 'PHP ' + proofVersion.php + ' (cgi-fcgi) (built: Oct 22 2026) (' + (faults.phpNts ? 'NTS' : 'ZTS') + ' Visual C++ 2022 x64)\n';
    const pipArgs = () => ['-I', '-m', 'pip', 'install', '--no-index', '--find-links', join(roots.python, versions.python, 'Lib', 'ensurepip', '_bundled'), '--force-reinstall', '--no-deps', '--disable-pip-version-check', '--no-warn-script-location', 'pip'];
    const run: CommandRunner = async (executable, args) => {
        commands.push({ binary: executable, args }); events.push('run:' + executable + ':' + args.join(' '));
        const destination = executable === 'powershell.exe' ? args.join(' ').match(/-DestinationPath '([^']+)'/)?.[1] : undefined;
        if (destination) {
            const lang = LANGUAGE_TRIPLE.find(row => destination === join(roots[row.lang], '.staging-' + versions[row.lang]))?.lang;
            if (!lang || !args.join(' ').includes(join(roots[lang], '.' + archives[lang]))) throw new Error('unexpected inert archive command');
            files.add(join(destination, lang === 'php' ? 'php-cgi.exe' : lang === 'python' ? 'python.exe' : 'dotnet.exe'));
            if (lang === 'php') files.add(join(destination, 'php.exe'));
            if (lang === 'python') files.add(join(destination, 'Lib', 'ensurepip', '_bundled', 'pip-fixture.whl'));
            if (lang === 'dotnet') files.add(join(destination, 'sdk', versions.dotnet));
            return { stdout: '', exitCode: 0 };
        }
        if (executable === 'php-cgi' && args.join(' ') === '-v') return { stdout: 'PHP 8.4.27 (cgi-fcgi) (NTS)\n', exitCode: 0 };
        if (executable === 'python' && args.join(' ') === '--version') return { stdout: 'Python was not found', exitCode: 9009 };
        if (executable === 'dotnet' && args.join(' ') === '--version') return { stdout: '8.0.426\n', exitCode: 0 };
        if (executable === binary('php') && JSON.stringify(args) === JSON.stringify(['-c', join(roots.php, versions.php, 'php.ini'), '-v'])) return { stdout: banner(), exitCode: 0 };
        if (executable === join(roots.php, versions.php, 'php.exe') && JSON.stringify(args) === JSON.stringify(['-c', join(roots.php, versions.php, 'php.ini'), '-m'])) return { stdout: ['[PHP Modules]', ...faults.phpModules].join('\n'), exitCode: 0 };
        if (executable === binary('python') && JSON.stringify(args) === JSON.stringify(pipArgs())) {
            if (faults.pipFailure) return { stdout: 'fixture bundled pip failed', exitCode: 1 };
            files.add(join(roots.python, versions.python, 'Scripts', 'pip.exe')); return { stdout: 'Successfully installed pip-26.0.1', exitCode: 0 };
        }
        if (executable === binary('python') && JSON.stringify(args) === JSON.stringify(PYTHON_PROOF_ARGS)) return { stdout: proofVersion.python + ' AMD64 26.0.1\n', exitCode: 0 };
        if (executable === binary('dotnet') && args.join(' ') === '--list-sdks') return { stdout: proofVersion.dotnet + ' [' + (faults.dotnetSdkPath ?? join(roots.dotnet, versions.dotnet, 'sdk')) + ']\n', exitCode: 0 };
        if (executable.startsWith(roots.dotnet + '/') && executable.endsWith('/dotnet.exe') && args.join(' ') === 'build-server shutdown') return { stdout: 'Build servers shut down', exitCode: 0 };
        throw new Error('unexpected inert version command ' + executable + ' ' + args.join(' '));
    };
    const portsFor = (lang: Lang) => ({ platform: 'win32' as const, arch: 'x64' as const, root: roots[lang], fs, run,
        fetchBytes: async (url: string) => { if (url !== urls[lang]) throw new Error('unexpected fixture archive URL'); downloads.push({ lang, url }); return { ok: true as const, body: bytes[lang] }; },
        fetchText: async (url: string) => {
            const expected = lang === 'php' ? PHP_WINDOWS_RELEASES_JSON : lang === 'python' ? PYTHON_WIN_INDEX : dotnetReleasesUrl(DOTNET_RECIPES[0]!.channel);
            if (url !== expected) throw new Error('unexpected fixture metadata URL');
            metadata.push({ lang, url }); const hash = badHash[lang] ? '0'.repeat(lang === 'dotnet' ? 128 : 64) : hashes[lang];
            const body = lang === 'php' ? { [versions.php.split('.').slice(0, 2).join('.')]: { version: versions.php, ['nts-' + PHP_RECIPES[0]!.vs + '-x64']: { zip: { path: archives.php, sha256: hash } } } }
                : lang === 'python' ? { versions: [{ id: 'pythoncore-' + versions.python.split('.').slice(0, 2).join('.') + '-64', 'sort-version': versions.python, url: urls.python, hash: { sha256: hash } }] }
                : { releases: [{ sdk: { version: versions.dotnet, files: [{ rid: 'win-x64', url: urls.dotnet, hash }] } }] };
            return { ok: true as const, body: JSON.stringify(body) };
        },
        progress: (step: string | null) => { progress.push(step); base.changed(); },
    });
    const phpPorts: PhpVersionsPorts = { ...portsFor('php'), ensureVcRuntime: async () => { vcCalls++; return faults.vcReason === null ? { ok: true } : { ok: false, reason: faults.vcReason }; } };
    const pythonPorts: PythonVersionsPorts = portsFor('python'), dotnetPorts: DotnetVersionsPorts = portsFor('dotnet');
    const managers = {
        php: { list: (pins: readonly SitePin[] = []) => listPhpVersions(phpPorts, pins), install: (v: string, consent: boolean) => installPhpVersion(v, consent, phpPorts), remove: (v: string, pins: readonly SitePin[] = []) => removePhpVersion(v, pins, phpPorts) },
        python: { list: () => listPythonVersions(pythonPorts), install: (v: string, consent: boolean) => installPythonVersion(v, consent, pythonPorts), remove: (v: string) => removePythonVersion(v, pythonPorts) },
        dotnet: { list: () => listDotnetVersions(dotnetPorts), install: (v: string, consent: boolean) => installDotnetVersion(v, consent, dotnetPorts), remove: (v: string) => removeDotnetVersion(v, dotnetPorts) },
    };
    const links = new Map<string, string>();
    const defaultsPorts: DefaultsPorts = { platform: 'win32', toolchainDir, managed: (lang: DefaultLang) =>
        (lang === 'php' ? managedPhp(phpPorts) : lang === 'python' ? managedPython(pythonPorts) : lang === 'dotnet' ? managedDotnet(dotnetPorts) : []).map(row => row.version),
        fs: { exists: path => fs.exists(path) || (links.has(path) && fs.exists(links.get(path)!)), readLink: path => links.get(path) ?? null,
            mkdirp: path => fs.mkdirp(path), unlink: path => { links.delete(path); },
            link: (target, path) => { if (!fs.exists(dirname(path)) || !fs.exists(target) || links.has(path)) throw new Error('fixture link rejected'); links.set(path, target); } } };
    const environment = new Map([['PATH', 'C:\\Windows']]);
    const defaults = { list: () => listDefaults(defaultsPorts), set: (lang: DefaultLang, version: string | null) => {
        const result = setDefault(lang, version, defaultsPorts);
        if (result.kind !== 'refused') restoreDefaultsEnv({ ...defaultsPorts, env: { get: name => environment.get(name), set: (name, value) => { environment.set(name, value); } } });
        return result;
    } };
    base.toolchain.php = managers.php; base.toolchain.python = managers.python; base.toolchain.dotnet = managers.dotnet; base.toolchain.defaults = defaults;
    const seed = (lang: Lang, version = versions[lang]) => { files.add(binary(lang, version)); };
    const pinPhp = () => base.hosting.sites.declare({ name: 'php-fixture', workspaceId: 'work', repoPath: base.workspace, serve: { mode: 'php', root: 'public', version: versions.php } });
    return { ...base, managers, versions, otherVersions, roots, archives, urls, bytes, hashes, binary, seed, pinPhp, files, fs, removals, events, faults,
        writtenBytes, downloads, metadata, versionCommands: commands, versionProgress: progress, badHash, proofVersion, defaults, pipArgs,
        vcCalls: () => vcCalls, defaultTarget: (lang: Lang) => links.get(currentLinkDir(toolchainDir, lang)) };
}
export type PhpPythonDotnetVersionsFixture = Awaited<ReturnType<typeof phpPythonDotnetVersionsFixture>>;
