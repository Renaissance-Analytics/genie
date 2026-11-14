import { dirname, join } from 'node:path';
import { DEFAULT_LANGS, currentLinkDir, defaultPathEntries, versionDir, type DefaultLang } from '../../src/core/toolchain-defaults.js';
import { listDefaults, restoreDefaultsEnv, setDefault, type DefaultsPorts, type LinkFs } from '../../src/main/toolchain-defaults.js';
import { applyMachinePath, machinePathStatus, removeMachinePath, type MachinePathPorts } from '../../src/main/machine-path.js';
import { groupThreeFixture } from './features-host-group3.js';

/** The real default/PATH planners, with managed inventory and OS effects confined to memory. */
export async function defaultsPathFixture() {
    const base = await groupThreeFixture();
    const toolchainDir = join('/fixture', 'toolchain'), home = join('/fixture', 'home');
    const versions: Record<DefaultLang, string> = { node: '24.22.1', go: '1.27.3', php: '8.4.27', python: '3.15.1',
        dotnet: '10.0.100', rust: '1.92.0', ruby: '3.4.2', java: '25.0.1' };
    // This checkpoint tests choosing among an owner's existing inventory, not downloading/installing it.
    const managed = new Set(DEFAULT_LANGS.map(lang => versionDir(toolchainDir, lang, versions[lang])));
    const links = new Map<string, string>(), linkOps: string[] = [];
    const directories = new Set<string>();
    const linkFs: LinkFs = {
        exists: path => directories.has(path) || managed.has(path) || (links.has(path) && managed.has(links.get(path)!)),
        readLink: path => links.get(path) ?? null,
        mkdirp: path => { directories.add(path); },
        link: (target, path) => {
            if (!directories.has(dirname(path)) || !managed.has(target)) throw new Error('fixture link parent or target is missing');
            if (links.has(path)) throw new Error('fixture link exists'); linkOps.push(`link ${path}`); links.set(path, target);
        },
        unlink: path => { linkOps.push(`unlink ${path}`); links.delete(path); },
    };
    const defaultsPorts: DefaultsPorts = { platform: 'linux', toolchainDir, fs: linkFs,
        managed: lang => managed.has(versionDir(toolchainDir, lang, versions[lang])) ? [versions[lang]] : [] };
    const environment = new Map([['PATH', '/usr/bin']]);
    const defaults = {
        list: () => listDefaults(defaultsPorts),
        set: (lang: DefaultLang, version: string | null) => {
            const result = setDefault(lang, version, defaultsPorts);
            if (result.kind !== 'refused') restoreDefaultsEnv({ ...defaultsPorts,
                env: { get: name => environment.get(name), set: (name, value) => { environment.set(name, value); } } });
            base.changed(); return result;
        },
    };
    const originalText = new Map([[join(home, '.profile'), 'export FIXTURE=1\n'], [join(home, '.bashrc'), 'alias fixture=true']]);
    const text = new Map(originalText), writes: Array<[string, string]> = [];
    const rawPath = '%USERPROFILE%\\Apps;C:\\Tools';
    const registry = { value: rawPath, writes: 0, broadcasts: 0, type: 'ExpandString', fail: false, ignore: false };
    const io = { readOnly: false, failRead: false };
    const commands: Array<{ binary: string; args: readonly string[] }> = [];
    let pathPlatform: 'linux' | 'win32' = 'linux';
    const pathPorts = (): MachinePathPorts => ({ platform: pathPlatform, home,
        entries: defaultPathEntries(toolchainDir, pathPlatform),
        fs: { exists: path => text.has(path), readText: path => text.get(path) ?? null,
            writeText: (path, value) => { if (io.readOnly) throw new Error('fixture startup file is read only'); writes.push([path, value]); text.set(path, value); } },
        run: async (binary, args) => {
            commands.push({ binary, args });
            const command = args.join(' ');
            if (command.includes("GetValue('Path'")) return { stdout: `${registry.value}\n`, exitCode: io.failRead ? 1 : 0 };
            const write = /Set-ItemProperty -Path 'HKCU:\\Environment' -Name 'Path' -Value '((?:[^']|'')*)' -Type ExpandString/.exec(command);
            if (write) {
                registry.writes++;
                if (registry.fail) return { stdout: 'fixture registry write denied', exitCode: 5 };
                if (!registry.ignore) registry.value = write[1]!.replace(/''/g, "'");
                registry.type = 'ExpandString'; if (command.includes('SendMessageTimeout')) registry.broadcasts++;
                return { stdout: '', exitCode: 0 };
            }
            throw new Error(`unexpected inert PATH command ${binary}`);
        },
    });
    const machinePath = {
        status: async () => ({ ...(await machinePathStatus(pathPorts())), entries: pathPorts().entries,
            targets: pathPlatform === 'win32' ? ['the user PATH (HKCU\\Environment)'] : [...originalText.keys()] }),
        apply: (consent: boolean) => applyMachinePath(consent, pathPorts()),
        remove: () => removeMachinePath(pathPorts()),
    };
    // These are existing optional ports. The host's production implementation is unchanged in this RED.
    base.toolchain.defaults = defaults; base.toolchain.machinePath = machinePath;
    return { ...base, defaults, defaultsPorts, machinePath, pathPorts, toolchainDir, home, versions, managed, links, linkOps,
        environment, text, originalText, writes, rawPath, registry, io, pathCommands: commands,
        pathPlatform: (platform: 'linux' | 'win32') => { pathPlatform = platform; },
        defaultTarget: (lang: DefaultLang) => links.get(currentLinkDir(toolchainDir, lang)) };
}
export type DefaultsPathFixture = Awaited<ReturnType<typeof defaultsPathFixture>>;
