import { join } from 'node:path';
import { RUBY_BUILD_LIBRARIES, RUBY_INDEX, RUBY_PROOF_ARGS, RUBY_RECIPES, missingRubyLibrariesAdvice, parseRubyProof, rubyPlatform, rubyShaFromIndex, rubySourceName, rubySourceUrl, type RubyArch, type RubyPlatform } from '../core/ruby-versions.js';
import { managedVersions, type ManagedPhp } from '../core/php-versions.js';
import { buildFromSource } from './source-build.js';
import type { Fetched, PhpVersionsFs } from './php-versions.js';
import type { CommandRunner } from './toolchain-prober.js';

/**
 * GENIE'S OWN RUBY — list, install, remove (plan `.ai/plans/genie-2-toolchain-rest.md`, TC6c). On Linux, built from
 * ruby-lang.org's source through the shared source builder: the build tools and every library Ruby needs asked for
 * BEFORE anything is downloaded, the sha256 from index.txt, configured into its final directory, proven — the
 * extensions a person needs load, the version and platform are this, and gem answers — or nothing is kept. Windows
 * (RubyInstaller is community-run) and macOS wait on the owner.
 */

export interface RubyVersionsPorts {
    readonly platform: RubyPlatform;
    readonly arch: RubyArch;
    /** `<toolchain data>/ruby-versions` — one directory per version. */
    readonly root: string;
    readonly fs: PhpVersionsFs;
    readonly run: CommandRunner;
    readonly fetchBytes: (url: string) => Promise<Fetched<Uint8Array>>;
    readonly fetchText: (url: string) => Promise<Fetched<string>>;
    readonly progress?: (step: string | null) => void;
    readonly cpus?: number;
}

export interface RubyVersionsView {
    readonly managed: ReadonlyArray<{ readonly version: string; readonly dir: string }>;
    readonly system: { readonly version: string } | null;
    readonly available: ReadonlyArray<{ readonly version: string; readonly installed: boolean }>;
    readonly installRefused?: string;
}

export type RubyInstallOutcome =
    | { readonly kind: 'refused'; readonly reason: string }
    | { readonly kind: 'already-installed'; readonly version: string }
    | { readonly kind: 'installed'; readonly version: string; readonly dir: string }
    | { readonly kind: 'not-installed'; readonly reason: string };

export type RubyRemoveOutcome = { readonly kind: 'refused'; readonly reason: string } | { readonly kind: 'removed'; readonly version: string };

const NOT_ON: Record<'win32' | 'darwin', string> = {
    win32: 'Genie does not install its own Ruby on Windows yet: ruby-lang.org publishes no Windows build (RubyInstaller is community-run), and which to use is the owner\'s decision; the ruby on your PATH is used',
    darwin: 'Genie does not install its own Ruby on macOS yet (it has not been proven on a Mac); the ruby on your PATH is used',
};
const NO_BUILD_TOOLS = "Genie builds Ruby from ruby-lang.org's source here, which needs a C compiler, make and pkg-config — install them first (Debian/Ubuntu: sudo apt install build-essential pkg-config; Fedora: sudo dnf install gcc make pkgconf; Arch: sudo pacman -S base-devel) and install again";

export function rubyVersionsRoot(toolchainDataDir: string): string {
    return join(toolchainDataDir, 'ruby-versions');
}

const rubyOf = (dir: string) => join(dir, 'bin', 'ruby');

export function managedRuby(ports: Pick<RubyVersionsPorts, 'root' | 'fs'>): ManagedPhp[] {
    return managedVersions(ports.fs.list(ports.root), (v) => ports.fs.exists(rubyOf(join(ports.root, v))), (v) => join(ports.root, v));
}

export async function listRubyVersions(ports: RubyVersionsPorts): Promise<RubyVersionsView> {
    const managed = managedRuby(ports);
    let system: RubyVersionsView['system'] = null;
    try {
        const said = await ports.run('ruby', ['-v']);
        const v = said.exitCode === 0 ? /^ruby (\d+\.\d+\.\d+)/m.exec(said.stdout.trim())?.[1] : undefined;
        if (v) system = { version: v };
    } catch {
        // no ruby on PATH
    }
    if (ports.platform !== 'linux') return { managed, system, available: [], installRefused: NOT_ON[ports.platform] };
    const have = new Set(managed.map((m) => m.version));
    return { managed, system, available: RUBY_RECIPES.map((r) => ({ version: r.version, installed: have.has(r.version) })) };
}

export async function installRubyVersion(version: string, consent: boolean, ports: RubyVersionsPorts): Promise<RubyInstallOutcome> {
    if (consent !== true) return { kind: 'refused', reason: `Genie installs nothing without your go-ahead; Ruby ${version} was not installed` };
    if (ports.platform !== 'linux') return { kind: 'refused', reason: NOT_ON[ports.platform] };
    if (!RUBY_RECIPES.some((r) => r.version === version)) return { kind: 'refused', reason: `Genie has no installer for Ruby ${version}; this release installs ${RUBY_RECIPES.map((r) => r.version).join(', ')}` };
    if (ports.fs.exists(rubyOf(join(ports.root, version)))) return { kind: 'already-installed', version };
    for (const tool of ['cc', 'make', 'pkg-config']) {
        try {
            if ((await ports.run(tool, ['--version'])).exitCode !== 0) return { kind: 'refused', reason: NO_BUILD_TOOLS };
        } catch {
            return { kind: 'refused', reason: NO_BUILD_TOOLS };
        }
    }
    const missing: string[] = [];
    for (const lib of RUBY_BUILD_LIBRARIES) {
        try {
            if ((await ports.run('pkg-config', ['--exists', lib.pkg])).exitCode !== 0) missing.push(lib.pkg);
        } catch {
            missing.push(lib.pkg);
        }
    }
    if (missing.length > 0) return { kind: 'refused', reason: missingRubyLibrariesAdvice(missing) };
    const file = rubySourceName(version);
    const platform = rubyPlatform(ports.arch);
    return buildFromSource({
        label: `Ruby ${version}`, version, file, url: rubySourceUrl(version), publisher: 'ruby-lang.org', srcFolder: `ruby-${version}`,
        expectedSha: async () => {
            const listed = await ports.fetchText(RUBY_INDEX);
            if (!listed.ok) return { ok: false, reason: `ruby-lang.org's index (${RUBY_INDEX}) could not be read (${listed.error})` };
            const sha = rubyShaFromIndex(listed.body, version);
            return sha ? { ok: true, sha } : { ok: false, reason: `ruby-lang.org's index lists no sha256 for ${file}` };
        },
        steps: (src, dir) => [
            { say: 'configuring', bin: 'env', args: ['-C', src, './configure', '-q', `--prefix=${dir}`, '--disable-install-doc'] },
            { say: 'compiling (a few minutes)', bin: 'make', args: ['-s', '-C', src, `-j${Math.max(1, ports.cpus ?? 1)}`] },
            { say: 'installing', bin: 'make', args: ['-s', '-C', src, 'install'] },
        ],
        prove: async (dir) => {
            const bin = rubyOf(dir);
            let said = '';
            try {
                said = (await ports.run(bin, RUBY_PROOF_ARGS)).stdout.trim();
            } catch (error) {
                return `Ruby ${version} built, but ${bin} did not run: ${error instanceof Error ? error.message : String(error)}`;
            }
            const got = parseRubyProof(said);
            if (!got) return `Ruby ${version} built, but ${bin} could not load openssl, psych, zlib and fiddle: ${said.slice(0, 200) || 'it said nothing'}`;
            if (got.version !== version) return `Ruby ${version} was asked for, but ${bin} reports ${got.version}`;
            if (got.platform !== platform) return `Ruby ${version} for ${platform} was asked for, but ${bin} reports ${got.platform}`;
            try {
                const gem = await ports.run(join(dir, 'bin', 'gem'), ['--version']);
                if (gem.exitCode !== 0 || !/^\d+\.\d+/.test(gem.stdout.trim())) return `Ruby ${version} built, but its gem did not answer: ${gem.stdout.trim().slice(0, 200)}`;
            } catch (error) {
                return `Ruby ${version} built, but its gem did not run: ${error instanceof Error ? error.message : String(error)}`;
            }
            return null;
        },
    }, { platform: 'linux', root: ports.root, fs: ports.fs, run: ports.run, fetchBytes: ports.fetchBytes, ...(ports.progress ? { progress: ports.progress } : {}) });
}

export function removeRubyVersion(version: string, ports: Pick<RubyVersionsPorts, 'root' | 'fs'>): RubyRemoveOutcome {
    const target = managedRuby(ports).find((m) => m.version === version);
    if (!target) return { kind: 'refused', reason: `Ruby ${version} is not a version Genie manages here; Genie removes only what it installed` };
    try {
        ports.fs.removeTree(target.dir);
    } catch (error) {
        return { kind: 'refused', reason: `Ruby ${version} could not be removed: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (ports.fs.exists(rubyOf(target.dir))) return { kind: 'refused', reason: `Ruby ${version} is still there after the delete (something running holds it); stop what uses it and try again` };
    return { kind: 'removed', version };
}
