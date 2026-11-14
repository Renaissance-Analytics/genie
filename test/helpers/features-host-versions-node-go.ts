import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { GO_DL_INDEX, GO_RECIPES, goArchiveName, goDownloadUrl } from '../../src/core/go-versions.js';
import { NODE_RECIPES, nodeArchiveName, nodeBinaryRel, nodeDownloadSources, nodeNpmCliRel, nodeTopFolder } from '../../src/core/node-versions.js';
import { currentLinkDir, type DefaultLang } from '../../src/core/toolchain-defaults.js';
import { installGoVersion, listGoVersions, managedGo, removeGoVersion, type GoVersionsPorts } from '../../src/main/go-versions.js';
import { installNodeVersion, listNodeVersions, managedNode, removeNodeVersion, type NodeVersionsPorts } from '../../src/main/node-versions.js';
import type { PhpVersionsFs } from '../../src/main/php-versions.js';
import { listDefaults, restoreDefaultsEnv, setDefault, type DefaultsPorts } from '../../src/main/toolchain-defaults.js';
import type { CommandRunner } from '../../src/main/toolchain-prober.js';
import { groupThreeFixture } from './features-host-group3.js';

export const LANGUAGE_PAIR = [
    { lang: 'node', label: 'Node', install: 'toolchain.installNode', remove: 'toolchain.removeNode', publisher: 'nodejs.org' },
    { lang: 'go', label: 'Go', install: 'toolchain.installGo', remove: 'toolchain.removeGo', publisher: 'go.dev' },
] as const;
type Lang = (typeof LANGUAGE_PAIR)[number]['lang'];

/** Real managers and archive/checksum/proof pipeline; all filesystem, download and executable effects are inert. */
export async function nodeGoVersionsFixture() {
    const base = await groupThreeFixture(), toolchainDir = join('/fixture', 'toolchain');
    const versions = { node: NODE_RECIPES[0]!.version, go: GO_RECIPES[0]!.version };
    const otherVersions = { node: NODE_RECIPES[1]!.version, go: GO_RECIPES[1]!.version };
    const roots = { node: join(toolchainDir, 'node-versions'), go: join(toolchainDir, 'go-versions') };
    const archives = { node: nodeArchiveName(versions.node, 'linux', 'x64'), go: goArchiveName(versions.go, 'linux', 'x64') };
    const urls = { node: nodeDownloadSources(versions.node, 'linux', 'x64').zipUrl, go: goDownloadUrl(archives.go) };
    const bytes = { node: new TextEncoder().encode('fixture Node archive'), go: new TextEncoder().encode('fixture Go archive') };
    const hashes = { node: createHash('sha256').update(bytes.node).digest('hex'), go: createHash('sha256').update(bytes.go).digest('hex') };
    const files = new Set<string>(), texts = new Map<string, string>();
    const removals: string[] = [], writtenBytes: Array<{ path: string; bytes: Uint8Array }> = [];
    const under = (file: string, path: string) => file === path || file.startsWith(`${path}/`) || file.startsWith(`${path}\\`);
    const fs: PhpVersionsFs = {
        exists: path => [...files].some(file => under(file, path)),
        list: path => [...new Set([...files].filter(file => file !== path && under(file, path)).map(file => file.slice(path.length + 1).split(/[\\/]/)[0]!))],
        mkdirp: path => { files.add(path); }, writeText: (path, value) => { files.add(path); texts.set(path, value); }, readText: path => texts.get(path) ?? null,
        writeBytes: (path, value) => { files.add(path); writtenBytes.push({ path, bytes: value.slice() }); },
        rename: (from, to) => {
            if (!fs.exists(from) || fs.exists(to)) throw new Error('fixture rename source missing or target exists');
            for (const file of [...files]) if (under(file, from)) { files.delete(file); files.add(to + file.slice(from.length)); }
        },
        removeTree: path => { removals.push(path); for (const file of [...files]) if (under(file, path)) { files.delete(file); texts.delete(file); } },
    };
    const badHash = { node: false, go: false }, proofVersion = { ...versions };
    const downloads: Array<{ lang: Lang; url: string }> = [], metadata: Array<{ lang: Lang; url: string }> = [];
    const commands: Array<{ binary: string; args: readonly string[] }> = [], progress: Array<string | null> = [];
    const binary = (lang: Lang, version = versions[lang]) => join(roots[lang], version, lang === 'node' ? nodeBinaryRel('linux') : join('bin', 'go'));
    const run: CommandRunner = async (executable, args) => {
        commands.push({ binary: executable, args });
        if (executable === 'tar') {
            const destination = args[args.indexOf('-C') + 1];
            const lang = destination?.startsWith(roots.node) ? 'node' : destination?.startsWith(roots.go) ? 'go' : null;
            if (!lang || !destination) throw new Error('unexpected inert archive destination');
            const top = join(destination, lang === 'node' ? nodeTopFolder(versions.node, 'linux', 'x64') : 'go');
            files.add(join(top, lang === 'node' ? nodeBinaryRel('linux') : join('bin', 'go')));
            if (lang === 'node') files.add(join(top, nodeNpmCliRel('linux')));
            return { stdout: '', exitCode: 0 };
        }
        if (executable === 'node' && args[0] === '-v') return { stdout: `v${base.versions.node}\n`, exitCode: 0 };
        if (executable === 'go' && args[0] === 'version') return { stdout: 'go version go1.20.0 linux/amd64\n', exitCode: 0 };
        if (executable === binary('node')) {
            if (args[0] === '-v') return { stdout: `v${proofVersion.node}\n`, exitCode: 0 };
            if (args[0] === join(roots.node, versions.node, nodeNpmCliRel('linux')) && args[1] === '-v') return { stdout: '11.19.1\n', exitCode: 0 };
        }
        if (executable === binary('go') && args[0] === 'version') return { stdout: `go version go${proofVersion.go} linux/amd64\n`, exitCode: 0 };
        throw new Error(`unexpected inert version command ${executable}`);
    };
    const portsFor = (lang: Lang) => ({ platform: 'linux' as const, arch: 'x64' as const, root: roots[lang], fs, run,
        fetchBytes: async (url: string) => {
            if (url !== urls[lang]) throw new Error('unexpected fixture archive URL');
            downloads.push({ lang, url }); return { ok: true as const, body: bytes[lang] };
        },
        fetchText: async (url: string) => {
            const expected = lang === 'node' ? nodeDownloadSources(versions.node, 'linux', 'x64').sumsUrl : GO_DL_INDEX;
            if (url !== expected) throw new Error('unexpected fixture metadata URL');
            metadata.push({ lang, url }); const hash = badHash[lang] ? '0'.repeat(64) : hashes[lang];
            return { ok: true as const, body: lang === 'node' ? `${hash}  ${archives.node}\n` : JSON.stringify([
                { version: `go${versions.go}`, stable: true, files: [{ filename: archives.go, os: 'linux', arch: 'amd64', kind: 'archive', sha256: hash }] },
            ]) };
        },
        progress: (step: string | null) => { progress.push(step); base.changed(); },
    });
    const nodePorts: NodeVersionsPorts = portsFor('node'), goPorts: GoVersionsPorts = portsFor('go');
    const managers = {
        node: { list: () => listNodeVersions(nodePorts), install: (version: string, consent: boolean) => installNodeVersion(version, consent, nodePorts), remove: (version: string) => removeNodeVersion(version, nodePorts) },
        go: { list: () => listGoVersions(goPorts), install: (version: string, consent: boolean) => installGoVersion(version, consent, goPorts), remove: (version: string) => removeGoVersion(version, goPorts) },
    };
    const links = new Map<string, string>();
    const defaultsPorts: DefaultsPorts = { platform: 'linux', toolchainDir, managed: (lang: DefaultLang) =>
        lang === 'node' ? managedNode(nodePorts).map(row => row.version) : lang === 'go' ? managedGo(goPorts).map(row => row.version) : [],
        fs: { exists: path => fs.exists(path) || (links.has(path) && fs.exists(links.get(path)!)), readLink: path => links.get(path) ?? null,
            mkdirp: path => fs.mkdirp(path), unlink: path => { links.delete(path); },
            link: (target, path) => { if (!fs.exists(dirname(path)) || !fs.exists(target) || links.has(path)) throw new Error('fixture link rejected'); links.set(path, target); } } };
    const environment = new Map([['PATH', '/usr/bin']]);
    const defaults = { list: () => listDefaults(defaultsPorts), set: (lang: DefaultLang, version: string | null) => {
        const result = setDefault(lang, version, defaultsPorts);
        if (result.kind !== 'refused') restoreDefaultsEnv({ ...defaultsPorts, env: { get: name => environment.get(name), set: (name, value) => { environment.set(name, value); } } });
        return result;
    } };
    base.toolchain.node = managers.node; base.toolchain.go = managers.go; base.toolchain.defaults = defaults;
    const seed = (lang: Lang, version = versions[lang]) => {
        files.add(binary(lang, version)); if (lang === 'node') files.add(join(roots.node, version, nodeNpmCliRel('linux')));
    };
    return { ...base, managers, versions, otherVersions, roots, archives, urls, bytes, hashes, binary, seed, files, fs, removals,
        writtenBytes, downloads, metadata, versionCommands: commands, versionProgress: progress, badHash, proofVersion, defaults,
        defaultTarget: (lang: Lang) => links.get(currentLinkDir(toolchainDir, lang)) };
}
export type NodeGoVersionsFixture = Awaited<ReturnType<typeof nodeGoVersionsFixture>>;
