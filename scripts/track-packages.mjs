/**
 * PACKAGES PER TRACK (Tynn #1058 L3; spec: the envelope's .ai/plans/genie-2-host-split-2026-10-31.md, "Launcher build
 * spec", slice L3). What each package holds, made from ONE electron-builder build of the client:
 *
 *   client    electron-builder's unpacked app, its program named genie-client, with no host bundle (no dist/main/host.js),
 *             no copy of the launcher and no Caddy (the host's)
 *   browser   browser.json alone: the Genie browser on its own track (the owner, 2026-11-26: each part updates on its own),
 *             with no second copy of the app. Its manifest names the client build it runs on, and the launcher starts that
 *             installed client with --genie-browser (the coordinator, 2026-11-26). It becomes a full package of its own
 *             only once its code differs from the client's.
 *   host      P6-1's copy, laid out at build time instead of at each start (src/main/host-runtime.ts): genie-host (Electron's
 *             binary, run as Node), its runtime files, the bundle under app/ (dist, package.json, node_modules with the
 *             unpacked natives over the packed ones), the bundled Caddy under resources/runtime, and no app.asar
 *   launcher  the launcher alone (Genie.exe / genie)
 *
 * The names are the launcher's (native/launcher/src/layout.rs); the host's runtime files are host-runtime.ts's
 * `runtimeFiles` (test/track-packages.test.ts holds both). scripts/build-track-packages.mjs runs these on a real build.
 */
import { chmod, copyFile, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { asarTopProblems, leftovers } from './packed-tree-check.mjs';

/** The tracks packed from the app build, each its own package and manifest. GApps join as tracks of their own later. */
export const COMPONENT_TRACKS = ['client', 'browser', 'host'];

/** The program a package of `track` runs, on `platform`. Never `Genie`: that is the launcher, which installers end by name. */
export function programName(track, platform) {
    const win = platform === 'win32';
    switch (track) {
        case 'client': return win ? 'genie-client.exe' : 'genie-client';
        case 'host': return win ? 'genie-host.exe' : 'genie-host';
        case 'launcher': return win ? 'Genie.exe' : 'genie';
        default: throw new Error(`no such track: ${track}`);
    }
}

/** What Electron needs beside its binary to run as Node (src/main/host-runtime.ts `runtimeFiles`, measured there). */
export function hostRuntimeFiles(platform) {
    return platform === 'linux' ? ['icudtl.dat', 'v8_context_snapshot.bin', 'libffmpeg.so'] : ['icudtl.dat', 'v8_context_snapshot.bin'];
}

export const HOST_ENTRY = 'app/dist/main/host.js';
const CADDY = ['caddy', 'caddy.exe'];
const clone = (v) => JSON.parse(JSON.stringify(v));

/**
 * The electron-builder configuration of the client: electron-builder.yml's, with the program named genie-client, the host
 * bundle left out, and no genie-launch.exe (the launcher is its own program). Caddy stays in the build, so a signed release
 * signs it; layoutWindowApp moves it out of the client and layoutHost into the host.
 */
export function clientBuilderConfig(base) {
    const c = clone(base);
    c.executableName = 'genie-client';
    // Third-party sourcemaps are not shipped: nothing loads them at runtime (the Linux breakdown, item 1126-110558-adb0a2:
    // lucide-react's maps alone were 13 MiB). Genie's own dist maps stay, for its stack traces.
    c.files = [...(c.files ?? []), '!dist/main/host.js', '!dist/main/host.js.map', '!**/node_modules/**/*.map'];
    // A platform's own `files` TAKE THE PLACE of the top-level list for the app's files (electron-builder 26.15.3, measured:
    // the Windows build's builder-debug.yml had only `**/*` and win.files' exclusions, and the repository, its cargo output
    // and CI screenshots went into a 956 MiB asar: item 1126-191543-b3aa95). So each platform list carries the top-level
    // patterns first, then its own.
    for (const os of ['win', 'linux', 'mac']) {
        if (Array.isArray(c[os]?.files)) c[os].files = [...c.files, ...c[os].files];
    }
    c.extraResources = (c.extraResources ?? []).filter((e) => !JSON.stringify(e).includes('genie-launch.exe'));
    c.directories = { ...(c.directories ?? {}), output: 'release/tracks/client-app' };
    c.publish = null;
    return c;
}

/**
 * The launcher's installer: today's installer (the same appId, productName and folder, one-click, per user, never
 * elevated), built from a folder that holds Genie.exe (the launcher) and packages/ (electron-builder --prepackaged). Its
 * include asks the profile and runs `Genie.exe install --from` (build/launcher-installer.nsh).
 */
export function launcherInstallerConfig(base, { version }) {
    return {
        appId: base.appId,
        productName: base.productName,
        copyright: base.copyright,
        directories: { output: 'release/tracks/installer', buildResources: base.directories?.buildResources ?? 'build' },
        extraMetadata: { version },
        protocols: clone(base.protocols ?? []),
        win: {
            icon: base.win?.icon,
            target: ['nsis'],
            artifactName: 'Genie-${version}-launcher-setup.${ext}',
            ...(base.win?.azureSignOptions ? { azureSignOptions: clone(base.win.azureSignOptions) } : {}),
        },
        // packElevateHelper off: nothing of Genie elevates, and electron-builder would put elevate.exe in the NSIS folder,
        // which holds the launcher alone.
        nsis: { ...clone(base.nsis ?? {}), include: 'build/launcher-installer.nsh', packElevateHelper: false },
        publish: null,
    };
}

async function files(root) {
    const out = [];
    async function walk(rel) {
        for (const e of await readdir(join(root, rel), { withFileTypes: true })) {
            const path = rel ? `${rel}/${e.name}` : e.name;
            if (e.isDirectory()) await walk(path);
            else if (e.isFile()) out.push(path);
            else throw new Error(`${path} is not a plain file (a link?): a package is files only`);
        }
    }
    await walk('');
    return out.sort();
}

async function copyInto(from, to) {
    await mkdir(dirname(to), { recursive: true });
    await copyFile(from, to);
    const mode = (await stat(from)).mode;
    if (mode & 0o111) await chmod(to, 0o755);
}

/** What the browser's package holds: what is browser-only. Its manifest names the client build it runs on. */
export const BROWSER_JSON = { runs: 'client', args: ['--genie-browser'] };

/** The browser's package: browser.json alone (no second copy of the app). */
export async function layoutBrowser({ out }) {
    await rm(out, { recursive: true, force: true });
    await mkdir(out, { recursive: true });
    await writeFile(join(out, 'browser.json'), `${JSON.stringify(BROWSER_JSON)}\n`);
    return { files: 1 };
}

/** The client's package: the unpacked app, its program as built, nothing of the host or the launcher. */
export async function layoutWindowApp({ from, out, track, platform }) {
    if (track !== 'client') throw new Error(`not the client: ${track}`);
    const built = programName('client', platform);
    const all = await files(from);
    if (!all.includes(built)) throw new Error(`${built} is not in ${from}: the client build names its program genie-client`);
    await rm(out, { recursive: true, force: true });
    for (const f of all) {
        if (f === 'resources/bin/genie-launch.exe') continue;
        if (CADDY.some((c) => f === `resources/runtime/${c}`)) continue;
        await copyInto(join(from, f), join(out, f === built ? programName(track, platform) : f));
    }
    return { files: (await files(out)).length };
}

/** Paths a host package holds under app/node_modules, read by Tynn #437's rule as the single app's unpacked side is. */
const asUnpacked = (f) => (f.startsWith('app/node_modules/') ? `resources/app.asar.unpacked/${f.slice('app/'.length)}` : f);

/** Tynn #437's leftovers in a host tree: other platforms' binaries, build inputs, scripts, tests. */
function hostLeftovers(list, platform, arch) {
    const mapped = new Map(list.map((f) => [asUnpacked(f), f]));
    return leftovers([...mapped.keys()], { platform, arch }).map(({ file, why }) => ({ file: mapped.get(file), why }));
}

/**
 * The host's package: P6-1's copy, laid out at build time. `unpackedApp` is electron-builder's unpacked client (its binary
 * is genie-host's, its app.asar.unpacked the natives); `asarDir` is that app.asar extracted (package.json, node_modules);
 * `dist` the build's dist (host.js and all); `runtimeDir` where the build's Caddy is. Leftovers by Tynn #437's rule are not
 * copied (a host runs from loose files, which antivirus reads one by one). Returns what was left out.
 */
export async function layoutHost({ unpackedApp, asarDir, dist, runtimeDir, out, platform, arch = 'x64' }) {
    const exe = programName('client', platform);
    const have = await files(unpackedApp);
    if (!have.includes(exe)) throw new Error(`${exe} is not in ${unpackedApp}`);
    for (const f of hostRuntimeFiles(platform)) if (!have.includes(f)) throw new Error(`${f} is not in ${unpackedApp}: genie-host cannot run without it`);
    const distFiles = await files(dist);
    if (!distFiles.includes('main/host.js')) throw new Error(`there is no main/host.js in ${dist}: build the app first (npm run build)`);
    await rm(out, { recursive: true, force: true });
    const planned = new Map();
    planned.set(programName('host', platform), join(unpackedApp, exe));
    for (const f of hostRuntimeFiles(platform)) planned.set(f, join(unpackedApp, f));
    for (const f of distFiles) planned.set(`app/dist/${f}`, join(dist, f));
    planned.set('app/package.json', join(asarDir, 'package.json'));
    for (const f of await files(join(asarDir, 'node_modules')).catch(() => [])) planned.set(`app/node_modules/${f}`, join(asarDir, 'node_modules', f));
    // The unpacked side after the packed one: a native file wins, and an asar holds only a stub of it.
    const unpacked = join(unpackedApp, 'resources', 'app.asar.unpacked', 'node_modules');
    for (const f of await files(unpacked).catch(() => [])) planned.set(`app/node_modules/${f}`, join(unpacked, f));
    for (const c of CADDY) {
        const at = join(runtimeDir, c);
        if (await stat(at).then((s) => s.isFile(), () => false)) planned.set(`resources/runtime/${c}`, at);
    }
    // Third-party sourcemaps, as in the client (clientBuilderConfig): not shipped.
    for (const k of [...planned.keys()]) if (k.startsWith('app/node_modules/') && k.endsWith('.map')) planned.delete(k);
    const left = hostLeftovers([...planned.keys()], platform, arch);
    const skip = new Set(left.map((l) => l.file));
    for (const [to, from] of planned) if (!skip.has(to)) await copyInto(from, join(out, to));
    await chmod(join(out, programName('host', platform)), 0o755).catch(() => undefined);
    return { files: planned.size - skip.size, leftOut: left };
}

/** What a package of `track` must hold on `platform`-`arch`. */
function requiredOf(track, platform, arch) {
    const own = `${platform}-${arch}`;
    if (track === 'client') return [programName(track, platform), 'resources/app.asar'];
    if (track === 'browser') return ['browser.json'];
    if (track === 'launcher') return [programName('launcher', platform)];
    const base = [programName('host', platform), ...hostRuntimeFiles(platform), HOST_ENTRY, 'app/package.json', `resources/runtime/${platform === 'win32' ? 'caddy.exe' : 'caddy'}`];
    if (platform !== 'win32') return [...base, 'app/node_modules/node-pty/lib/index.js'];
    const pty = 'app/node_modules/node-pty/prebuilds/';
    return [
        ...base,
        ...['pty.node', 'conpty.node', 'conpty_console_list.node', 'winpty.dll', 'winpty-agent.exe', 'conpty/conpty.dll', 'conpty/OpenConsole.exe'].map((f) => `${pty}${own}/${f}`),
        `app/node_modules/@particle-academy/fancy-pty/bin/${own}/fancy-pty-helper.exe`,
        `app/node_modules/@napi-rs/keyring-${own}-msvc/keyring.${own}-msvc.node`,
        // Both architectures whatever this build's (Tynn #575): prism-acp picks by the machine.
        'app/node_modules/@particle-academy/prism-acp/native/win32-x64/prism-acp-supervisor.exe',
        'app/node_modules/@particle-academy/prism-acp/native/win32-arm64/prism-acp-supervisor.exe',
    ];
}

/**
 * Everything wrong with a package's tree: `[{file, why}]`, empty when it is right. `files` are its paths ('/'-separated);
 * `asarFiles` the paths inside its resources/app.asar (a client or a browser). A host holds no app.asar and no leftovers;
 * a client or browser holds no host.js, no launcher and no Caddy.
 */
export function trackTreeProblems({ track, platform, arch = 'x64', files: list, asarFiles = [] }) {
    const problems = [];
    const have = new Set(list);
    for (const f of requiredOf(track, platform, arch)) if (!have.has(f)) problems.push({ file: f, why: 'missing' });
    if (track === 'host') {
        for (const f of list) if (f === 'app.asar' || f.endsWith('/app.asar')) problems.push({ file: f, why: 'an app.asar: the host runs from files, never from the client\'s archive' });
        problems.push(...hostLeftovers(list, platform, arch));
    }
    if (track === 'browser') {
        // No second copy of the app: anything but browser.json is the client's, and the browser runs the client's build.
        for (const f of list) if (f !== 'browser.json') problems.push({ file: f, why: 'the client\'s: the browser runs the installed client build' });
    }
    if (track === 'client') {
        // What the client's app.asar may hold: the app (dist, package.json) and its production modules. Anything else at its
        // top is the repository packed by mistake (the Windows build, item 1126-183942-7000a7: a 956 MiB asar).
        problems.push(...asarTopProblems(asarFiles));
        for (const f of asarFiles.map((a) => a.replace(/\\/g, '/'))) {
            if (f === '/dist/main/host.js' || f === 'dist/main/host.js') problems.push({ file: `resources/app.asar:${f}`, why: 'the host bundle: the client package holds none' });
        }
        for (const f of list) {
            if (f === 'resources/bin/genie-launch.exe') problems.push({ file: f, why: 'a copy of the launcher: the launcher is its own program' });
            if (CADDY.some((c) => f === `resources/runtime/${c}`)) problems.push({ file: f, why: 'Caddy is the host\'s' });
        }
        if (platform === 'win32') problems.push(...leftovers(list, { platform, arch }));
    }
    return problems;
}

/** Every file under `root`, '/'-separated and sorted. */
export async function treeOf(root) {
    return files(root);
}

