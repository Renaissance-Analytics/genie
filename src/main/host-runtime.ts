import { chmod, copyFile, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/**
 * THE HOST RUNS FROM A COPY (the host split, P6; Genie 1's beta.174 and .181: an installer kills a process that holds a file
 * of the install). Measured on Electron 45.2.2: with the host on a copy, it holds 0 files of the install and the install's
 * binary can be overwritten beside it; with the host on the install, that is refused (EBUSY, ETXTBSY).
 *
 *   <home>/host/runtime-<Electron version>/   the binary and what it needs, about 240 MB: copied only when Electron changes
 *   <home>/host/<host hash>/                  the host's bundle and native packages, laid out so its imports find them
 *
 * Each is committed by a `.complete` marker, written last, so a torn copy is never run. Never throws: a copy that can't be
 * made answers the install, with the reason, and Genie still starts (it goes down at the next update, as it always did).
 */

/** What Electron needs beside its binary to run as Node, measured by removing each file in turn on both systems. */
export function runtimeFiles(platform: NodeJS.Platform): readonly string[] {
    return platform === 'linux' ? ['icudtl.dat', 'v8_context_snapshot.bin', 'libffmpeg.so'] : ['icudtl.dat', 'v8_context_snapshot.bin'];
}

/** The host's externals (vite.main.config.ts) and the helper a pty needs: by package, with their native files beside them. */
const HOST_PACKAGES: readonly RegExp[] = [/^node-pty$/, /^@napi-rs\/keyring(-.*)?$/, /^@particle-academy\/fancy-pty(-.*)?$/];

export interface HostRuntimeInput {
    readonly packaged: boolean;
    readonly platform: NodeJS.Platform;
    readonly execPath: string;
    readonly electronVersion: string;
    /** The app inside the install: `resources/app.asar`, which reads as a folder in Electron. */
    readonly appRoot: string;
    /** Its unpacked side: `resources/app.asar.unpacked`, where the native files are. */
    readonly unpackedRoot: string;
    readonly hostHash: string;
    readonly genieHome: string;
    readonly log: (line: string) => void;
    /** Each file as it lands. For the test of the marker's order. */
    readonly onWrite?: (file: string) => void;
}

export interface HostRuntime {
    readonly execPath: string;
    readonly hostScript: string;
    readonly copied: boolean;
    readonly error: string | null;
}

const COMPLETE = '.complete';
const exists = (path: string): Promise<boolean> => stat(path).then(() => true, () => false);

async function copyTree(from: string, to: string, onWrite: (file: string) => void): Promise<void> {
    const info = await stat(from);
    if (!info.isDirectory()) {
        await mkdir(dirname(to), { recursive: true });
        await copyFile(from, to);
        // An asar's copy loses its mode, and a helper has to run.
        await chmod(to, info.mode & 0o111 ? 0o755 : 0o644).catch(() => undefined);
        onWrite(to);
        return;
    }
    for (const name of await readdir(from)) await copyTree(join(from, name), join(to, name), onWrite);
}

/** Every package folder directly under node_modules, scoped ones by their whole name. */
async function packagesIn(root: string): Promise<string[]> {
    const modules = join(root, 'node_modules');
    const found: string[] = [];
    for (const name of await readdir(modules).catch(() => [] as string[])) {
        if (!name.startsWith('@')) { found.push(name); continue; }
        for (const inner of await readdir(join(modules, name)).catch(() => [] as string[])) found.push(`${name}/${inner}`);
    }
    return found;
}

/** A folder is replaced whole: what a torn copy left must not survive into the next. */
async function committed(dir: string, fill: () => Promise<void>, onWrite: (file: string) => void): Promise<boolean> {
    const marker = join(dir, COMPLETE);
    if (await exists(marker)) return false;
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    await fill();
    await writeFile(marker, '', 'utf8');
    onWrite(marker);
    return true;
}

export async function materializeHostRuntime(input: HostRuntimeInput): Promise<HostRuntime> {
    const inPlace = { execPath: input.execPath, hostScript: join(input.appRoot, 'dist', 'main', 'host.js') };
    if (!input.packaged) return { ...inPlace, copied: false, error: null };
    const onWrite = input.onWrite ?? (() => {});
    const base = join(input.genieHome, 'host');
    const runtime = join(base, `runtime-${input.electronVersion}`);
    const app = join(base, input.hostHash);
    const exe = basename(input.execPath);
    try {
        const copiedRuntime = await committed(runtime, async () => {
            const install = dirname(input.execPath);
            for (const name of [exe, ...runtimeFiles(input.platform)]) {
                if (!(await exists(join(install, name)))) throw new Error(`${name} is not in the install`);
            }
            for (const name of [exe, ...runtimeFiles(input.platform)]) await copyTree(join(install, name), join(runtime, name), onWrite);
            await chmod(join(runtime, exe), 0o755).catch(() => undefined);
        }, onWrite);
        const copiedApp = await committed(app, async () => {
            await copyTree(join(input.appRoot, 'dist'), join(app, 'dist'), onWrite);
            await copyTree(join(input.appRoot, 'package.json'), join(app, 'package.json'), onWrite);
            // The unpacked side after the packed one: a native file wins, and an asar holds only a stub of it.
            for (const root of [input.appRoot, input.unpackedRoot]) {
                for (const name of await packagesIn(root)) {
                    if (HOST_PACKAGES.some((p) => p.test(name))) await copyTree(join(root, 'node_modules', name), join(app, 'node_modules', name), onWrite);
                }
            }
        }, onWrite);
        // Other hosts' folders go when nothing holds them; a locked one waits. Other runtimes stay: an old host may run on one.
        for (const name of await readdir(base)) {
            if (name !== input.hostHash && !name.startsWith('runtime-')) await rm(join(base, name), { recursive: true, force: true }).catch(() => undefined);
        }
        return { execPath: join(runtime, exe), hostScript: join(app, 'dist', 'main', 'host.js'), copied: copiedRuntime || copiedApp, error: null };
    } catch (error) {
        const reason = `Genie runs its host from the install this session; the copy could not be made: ${error instanceof Error ? error.message : String(error)}`;
        input.log(reason);
        return { ...inPlace, copied: false, error: reason };
    }
}
