import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
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
    /** This machine's architecture (`process.arch`): which supervisor the copy must hold. Absent = this process's. */
    readonly arch?: string;
    /** How a file is copied: Electron's own, which reads the archive. For the test of a listed file that is not on disk. */
    readonly copyFile?: typeof copyFile;
}

export interface HostRuntime {
    readonly execPath: string;
    readonly hostScript: string;
    readonly copied: boolean;
    readonly error: string | null;
}

const COMPLETE = '.complete';
const exists = (path: string): Promise<boolean> => stat(path).then(() => true, () => false);

/** What a copy is made with: how a file is copied, each file as it lands, and each file the archive listed that is not on disk. */
interface CopyPorts {
    readonly copy: typeof copyFile;
    readonly onWrite: (file: string) => void;
    readonly notShipped: (file: string) => void;
}

/**
 * A LISTED FILE THAT IS NOT ON DISK IS NOT COPIED, AND SAID (beta.61, measured). The app's archive lists every packed file,
 * the unpacked ones too. The build ships no other platform's binaries, so prism-acp's supervisor for the other architecture
 * is listed and absent: copying it failed (ENOENT) and the whole copy was abandoned at every start. What the host needs is
 * checked afterwards, before the marker (`appProblem`), so a missing file that matters still stops the copy.
 */
async function copyTree(from: string, to: string, ports: CopyPorts): Promise<void> {
    const info = await stat(from);
    if (!info.isDirectory()) {
        await mkdir(dirname(to), { recursive: true });
        try {
            await ports.copy(from, to);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            ports.notShipped(from);
            return;
        }
        // An asar's copy loses its mode, and a helper has to run.
        await chmod(to, info.mode & 0o111 ? 0o755 : 0o644).catch(() => undefined);
        ports.onWrite(to);
        return;
    }
    for (const name of await readdir(from)) await copyTree(join(from, name), join(to, name), ports);
}

const SUPERVISOR = ['node_modules', '@particle-academy', 'prism-acp', 'native'] as const;
const sha256 = async (file: string): Promise<string | null> => readFile(file).then((bytes) => createHash('sha256').update(bytes).digest('hex'), () => null);

/**
 * WHAT THE HOST'S COPY MUST HOLD, checked before its marker is written and again at every start (so a bad copy is never
 * made permanent by its marker): the host's entry, and on Windows prism-acp's supervisor for THIS architecture, byte for
 * byte the install's. Its pinned digest is prism-acp's own check at every use (an Authenticode hash: a signed build's file
 * is not the manifest's raw bytes), so it is not repeated here. `null` = good; otherwise why not, in words.
 */
async function appProblem(app: string, input: HostRuntimeInput): Promise<string | null> {
    if (!(await exists(join(app, 'dist', 'main', 'host.js')))) return 'the host’s entry (dist/main/host.js) is not in it';
    if (input.platform !== 'win32') return null;
    const rel = [...SUPERVISOR, `win32-${input.arch ?? process.arch}`, 'prism-acp-supervisor.exe'];
    const shipped = await sha256(join(input.unpackedRoot, ...rel));
    if (shipped === null) return `the install has no process supervisor for this machine (${rel.slice(-2).join('/')})`;
    const copied = await sha256(join(app, ...rel));
    if (copied === null) return `the process supervisor for this machine (${rel.slice(-2).join('/')}) is not in it`;
    return copied === shipped ? null : `its process supervisor (${rel.slice(-2).join('/')}) is not the install’s`;
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
async function committed(dir: string, fill: () => Promise<void>, onWrite: (file: string) => void, problem: () => Promise<string | null> = async () => null, log: (line: string) => void = () => {}): Promise<boolean> {
    const marker = join(dir, COMPLETE);
    if (await exists(marker)) {
        // A marker is not proof: a copy that lost what the host needs is made again, now.
        const bad = await problem();
        if (bad === null) return false;
        log(`genie-host's copy at ${dir} is made again: ${bad}`);
    }
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    await fill();
    const bad = await problem();
    if (bad !== null) throw new Error(bad);
    await writeFile(marker, '', 'utf8');
    onWrite(marker);
    return true;
}

export async function materializeHostRuntime(input: HostRuntimeInput): Promise<HostRuntime> {
    const inPlace = { execPath: input.execPath, hostScript: join(input.appRoot, 'dist', 'main', 'host.js') };
    if (!input.packaged) return { ...inPlace, copied: false, error: null };
    const onWrite = input.onWrite ?? (() => {});
    const notShipped: string[] = [];
    const ports: CopyPorts = { copy: input.copyFile ?? copyFile, onWrite, notShipped: (file) => { notShipped.push(file); } };
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
            for (const name of [exe, ...runtimeFiles(input.platform)]) await copyTree(join(install, name), join(runtime, name), ports);
            await chmod(join(runtime, exe), 0o755).catch(() => undefined);
        }, onWrite);
        const copiedApp = await committed(app, async () => {
            await copyTree(join(input.appRoot, 'dist'), join(app, 'dist'), ports);
            await copyTree(join(input.appRoot, 'package.json'), join(app, 'package.json'), ports);
            // EVERY package the install ships (Tynn #597): the main build is ssr, so all of its dependencies stay external, and a
            // hand list fell behind (fancy-file-commons, prism-acp). The unpacked side after the packed one: a native file wins,
            // and an asar holds only a stub of it.
            for (const root of [input.appRoot, input.unpackedRoot]) {
                for (const name of await packagesIn(root)) await copyTree(join(root, 'node_modules', name), join(app, 'node_modules', name), ports);
            }
        }, onWrite, () => appProblem(app, input), input.log);
        if (notShipped.length > 0) input.log(`genie-host's copy: ${notShipped.length} file(s) the app lists are not in this build, so not copied: ${notShipped.join(', ')}`);
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
