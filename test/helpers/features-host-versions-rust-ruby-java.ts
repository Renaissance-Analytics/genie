import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { JAVA_RECIPES, javaArchiveName, javaDownloadUrl, javaIdOf, javaRelease, javaReleaseApiUrl } from '../../src/core/java-versions.js';
import { RUBY_PROOF_ARGS, RUBY_RECIPES, RUBYINSTALLER_DOWNLOADS, rubyInstallerAsset, rubyInstallerTopFolder, rubyInstallerUrl, rubyWindowsPlatform } from '../../src/core/ruby-versions.js';
import { RUST_RECIPES, rustTriple, rustupInitUrl } from '../../src/core/rust-versions.js';
import { currentLinkDir, type DefaultLang } from '../../src/core/toolchain-defaults.js';
import { installJavaVersion, listJavaVersions, managedJava, removeJavaVersion, type JavaVersionsPorts } from '../../src/main/java-versions.js';
import type { PhpVersionsFs } from '../../src/main/php-versions.js';
import { installRubyVersion, listRubyVersions, managedRuby, removeRubyVersion, type RubyVersionsPorts } from '../../src/main/ruby-versions.js';
import { installRustVersion, listRustVersions, managedRust, removeRustVersion, type RustVersionsPorts } from '../../src/main/rust-versions.js';
import { listDefaults, restoreDefaultsEnv, setDefault, type DefaultsPorts } from '../../src/main/toolchain-defaults.js';
import type { CommandRunner } from '../../src/main/toolchain-prober.js';
import { groupThreeFixture } from './features-host-group3.js';

export const LANGUAGE_TRIPLE = [
    { lang: 'rust', label: 'Rust', install: 'toolchain.installRust', remove: 'toolchain.removeRust', publisher: 'rust-lang.org' },
    { lang: 'ruby', label: 'Ruby', install: 'toolchain.installRuby', remove: 'toolchain.removeRuby', publisher: 'RubyInstaller' },
    { lang: 'java', label: 'Java', install: 'toolchain.installJava', remove: 'toolchain.removeJava', publisher: 'Adoptium' },
] as const;
type Lang = (typeof LANGUAGE_TRIPLE)[number]['lang'];

/** Real win32/x64 planners with inert OS ports: no executable, rustup, extraction or network operation runs here. */
export async function rustRubyJavaVersionsFixture() {
    const base = await groupThreeFixture(), toolchainDir = join('/fixture', 'toolchain');
    const release = javaRelease(JAVA_RECIPES[0]!, 'win32');
    if (release === null) throw new Error('fixture needs the offered Windows Java release');
    const versions = { rust: RUST_RECIPES[0]!.version, ruby: RUBY_RECIPES[0]!.version, java: javaIdOf(release) };
    // Installed inventory need not be offered by this release; never assume a second recipe exists.
    const otherVersions = { rust: '1.98.1', ruby: '3.4.12', java: '21.0.12.1+1' };
    const roots = { rust: join(toolchainDir, 'rust-versions'), ruby: join(toolchainDir, 'ruby-versions'), java: join(toolchainDir, 'java-versions') };
    const triple = rustTriple('win32', 'x64');
    const archives = { rust: 'rustup-init.exe', ruby: rubyInstallerAsset(versions.ruby, 'x64'), java: javaArchiveName(JAVA_RECIPES[0]!.line, release, 'win32', 'x64') };
    const urls = { rust: rustupInitUrl(triple), ruby: rubyInstallerUrl(versions.ruby, 'x64'), java: javaDownloadUrl(JAVA_RECIPES[0]!.line, release, 'win32', 'x64') };
    const bytes = { rust: new TextEncoder().encode('fixture rustup-init'), ruby: new TextEncoder().encode('fixture Ruby archive'), java: new TextEncoder().encode('fixture JDK archive') };
    const hashes = { rust: createHash('sha256').update(bytes.rust).digest('hex'), ruby: createHash('sha256').update(bytes.ruby).digest('hex'), java: createHash('sha256').update(bytes.java).digest('hex') };
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
    const badHash = { rust: false, ruby: false, java: false }, proofVersion = { ...versions };
    const faults = { rustHost: triple, cargo: 'cargo ' + versions.rust, rubyPlatform: rubyWindowsPlatform('x64'), gem: '4.0.1', missingTar: false, javaVendor: false, javac: 'javac ' + versions.java.split('+')[0] };
    const downloads: Array<{ lang: Lang; url: string }> = [], metadata: Array<{ lang: Lang; url: string }> = [];
    const commands: Array<{ binary: string; args: readonly string[]; env?: Readonly<Record<string, string>> }> = [], progress: Array<string | null> = [];
    const binary = (lang: Lang, version = versions[lang]) => join(roots[lang], version, 'bin', lang === 'rust' ? 'rustc.exe' : lang === 'ruby' ? 'ruby.exe' : 'java.exe');
    const rustStage = join(roots.rust, '.staging-' + versions.rust);
    const homes = { RUSTUP_HOME: join(rustStage, 'rustup'), CARGO_HOME: join(rustStage, 'cargo') };
    const rustInit = join(rustStage, 'rustup-init.exe'), rustup = join(rustStage, 'cargo', 'bin', 'rustup.exe');
    const rustInitArgs = ['-y', '--no-modify-path', '--default-toolchain', 'none', '--profile', 'minimal'];
    const rustupArgs = ['toolchain', 'install', versions.rust + '-' + triple, '--profile', 'minimal', '--no-self-update'];
    const windowsTar = join('/fixture', 'Windows', 'System32', 'tar.exe');
    const writePath = (lang: Lang) => lang === 'rust' ? rustInit : join(roots[lang], '.' + archives[lang]);
    const run: CommandRunner = async (executable, args, options) => {
        commands.push({ binary: executable, args, ...(options?.env ? { env: options.env } : {}) });
        events.push('run:' + executable + ':' + args.join(' '));
        if (executable === rustInit || executable === rustup) {
            const expected = executable === rustInit ? rustInitArgs : rustupArgs;
            if (JSON.stringify(args) !== JSON.stringify(expected) || !options?.env || Object.keys(options.env).length !== 2
                || Object.entries(homes).some(([key, value]) => options.env?.[key] !== value)) throw new Error('unexpected inert rustup command or homes');
            if (executable === rustInit) files.add(rustup);
            else for (const name of ['rustc.exe', 'cargo.exe']) files.add(join(rustStage, 'rustup', 'toolchains', versions.rust + '-' + triple, 'bin', name));
            return { stdout: '', exitCode: 0 };
        }
        if (executable === windowsTar) {
            const staging = join(roots.ruby, '.staging-' + versions.ruby);
            if (JSON.stringify(args) !== JSON.stringify(['-xf', writePath('ruby'), '-C', staging])) throw new Error('unexpected inert Ruby extraction arguments');
            files.add(join(staging, rubyInstallerTopFolder(versions.ruby, 'x64'), 'bin', 'ruby.exe'));
            return { stdout: '', exitCode: 0 };
        }
        const destination = executable === 'powershell.exe' ? args.join(' ').match(/-DestinationPath '([^']+)'/)?.[1] : undefined;
        if (destination === join(roots.java, '.staging-' + versions.java) && args.join(' ').includes(writePath('java'))) {
            for (const name of ['java.exe', 'javac.exe']) files.add(join(destination, release, 'bin', name));
            return { stdout: '', exitCode: 0 };
        }
        if (executable === 'rustc' && args.join(' ') === '--version') return { stdout: 'rustc 1.90.0 (fixture)\n', exitCode: 0 };
        if (executable === 'ruby' && args.join(' ') === '-v') return { stdout: 'ruby 3.3.0 (fixture)\n', exitCode: 0 };
        if (executable === 'java' && args.join(' ') === '-version') return { stdout: 'openjdk version "17.0.1"\n', exitCode: 0 };
        if (executable === binary('rust') && args.join(' ') === '-vV') return { stdout: 'rustc ' + proofVersion.rust + ' (fixture)\nhost: ' + faults.rustHost + '\n', exitCode: 0 };
        if (executable === join(roots.rust, versions.rust, 'bin', 'cargo.exe') && args.join(' ') === '--version') return { stdout: faults.cargo + '\n', exitCode: 0 };
        if (executable === binary('ruby') && JSON.stringify(args) === JSON.stringify(RUBY_PROOF_ARGS)) return { stdout: proofVersion.ruby + ' ' + faults.rubyPlatform, exitCode: 0 };
        if (executable === binary('ruby') && JSON.stringify(args) === JSON.stringify(['-e', "require 'rubygems'; print Gem::VERSION"])) return { stdout: faults.gem, exitCode: 0 };
        if (executable === binary('java') && args.join(' ') === '-version') return { stdout: 'openjdk version "' + proofVersion.java.split('+')[0] + '"\nOpenJDK Runtime Environment ' + (faults.javaVendor ? 'OtherVendor-' : 'Temurin-') + proofVersion.java + ' (fixture)\n', exitCode: 0 };
        if (executable === join(roots.java, versions.java, 'bin', 'javac.exe') && args.join(' ') === '-version') return { stdout: faults.javac + '\n', exitCode: 0 };
        throw new Error('unexpected inert version command ' + executable + ' ' + args.join(' '));
    };
    const portsFor = (lang: Lang) => ({ platform: 'win32' as const, arch: 'x64' as const, root: roots[lang], fs, run,
        fetchBytes: async (url: string) => { if (url !== urls[lang]) throw new Error('unexpected fixture archive URL'); downloads.push({ lang, url }); return { ok: true as const, body: bytes[lang] }; },
        fetchText: async (url: string) => {
            const expected = lang === 'rust' ? urls.rust + '.sha256' : lang === 'ruby' ? RUBYINSTALLER_DOWNLOADS : javaReleaseApiUrl(release, 'win32', 'x64');
            if (url !== expected) throw new Error('unexpected fixture metadata URL');
            metadata.push({ lang, url }); const hash = badHash[lang] ? '0'.repeat(64) : hashes[lang];
            const body = lang === 'rust' ? hash + '  rustup-init.exe\n' : lang === 'ruby' ? '<a class="downloadlink" href="' + urls.ruby + '">Ruby</a> SHA256: <input value="' + hash + '">'
                : JSON.stringify({ binaries: [{ image_type: 'jdk', package: { link: urls.java, checksum: hash } }] });
            return { ok: true as const, body };
        }, progress: (step: string | null) => { progress.push(step); base.changed(); },
    });
    const rustPorts: RustVersionsPorts = portsFor('rust'), rubyPorts: RubyVersionsPorts = portsFor('ruby'), javaPorts: JavaVersionsPorts = portsFor('java');
    const managers = {
        rust: { list: () => listRustVersions(rustPorts), install: (v: string, consent: boolean) => installRustVersion(v, consent, rustPorts), remove: (v: string) => removeRustVersion(v, rustPorts) },
        ruby: { list: () => listRubyVersions(rubyPorts), install: (v: string, consent: boolean) => installRubyVersion(v, consent, { ...rubyPorts, ...(faults.missingTar ? {} : { windowsTar }) }), remove: (v: string) => removeRubyVersion(v, rubyPorts) },
        java: { list: () => listJavaVersions(javaPorts), install: (v: string, consent: boolean) => installJavaVersion(v, consent, javaPorts), remove: (v: string) => removeJavaVersion(v, javaPorts) },
    };
    const links = new Map<string, string>();
    const defaultsPorts: DefaultsPorts = { platform: 'win32', toolchainDir, managed: (lang: DefaultLang) =>
        (lang === 'rust' ? managedRust(rustPorts) : lang === 'ruby' ? managedRuby(rubyPorts) : lang === 'java' ? managedJava(javaPorts) : []).map(row => row.version),
        fs: { exists: path => fs.exists(path) || (links.has(path) && fs.exists(links.get(path)!)), readLink: path => links.get(path) ?? null,
            mkdirp: path => fs.mkdirp(path), unlink: path => { links.delete(path); },
            link: (target, path) => { if (!fs.exists(dirname(path)) || !fs.exists(target) || links.has(path)) throw new Error('fixture link rejected'); links.set(path, target); } } };
    const environment = new Map([['PATH', 'C:\\Windows']]);
    const defaults = { list: () => listDefaults(defaultsPorts), set: (lang: DefaultLang, version: string | null) => {
        const result = setDefault(lang, version, defaultsPorts);
        if (result.kind !== 'refused') restoreDefaultsEnv({ ...defaultsPorts, env: { get: name => environment.get(name), set: (name, value) => { environment.set(name, value); } } });
        return result;
    } };
    base.toolchain.rust = managers.rust; base.toolchain.ruby = managers.ruby; base.toolchain.java = managers.java; base.toolchain.defaults = defaults;
    const seed = (lang: Lang, version = versions[lang]) => { files.add(binary(lang, version)); };
    return { ...base, managers, versions, otherVersions, roots, archives, urls, bytes, hashes, binary, seed, files, fs, removals, events, faults, writePath,
        writtenBytes, downloads, metadata, versionCommands: commands, versionProgress: progress, badHash, proofVersion, defaults,
        homes, rustStage, rustInit, rustup, rustInitArgs, rustupArgs, triple, windowsTar,
        defaultTarget: (lang: Lang) => links.get(currentLinkDir(toolchainDir, lang)) };
}
export type RustRubyJavaVersionsFixture = Awaited<ReturnType<typeof rustRubyJavaVersionsFixture>>;
