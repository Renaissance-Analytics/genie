import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { EngineInstall } from './toolchain-versions';

export async function repairManagedPhpExtensions(
    installs: EngineInstall[], platform: string,
    ensure: (dir: string, exe: string) => Promise<PhpExtensionResult>,
): Promise<Array<PhpExtensionResult & { dir: string }>> {
    const reports: Array<PhpExtensionResult & { dir: string }> = [];
    if (platform !== 'win32') return reports;
    for (const install of installs) {
        if (install.source !== 'genie' || install.tool !== 'php') continue;
        try { reports.push({ dir: install.dir, ...await ensure(install.dir, install.exe) }); }
        catch { reports.push({ dir: install.dir, ok: false, error: 'PHP extension repair failed.' }); }
    }
    return reports;
}

export interface PhpAbi { version: string; zts: boolean; bits: number; debug: boolean; build: string }
export interface PhpExtensionInstall { dir: string; exe: string; platform: string }
export interface PhpExtensionArtifact { name: string; version: string; file: string; url: string; sha256: string }
export interface PhpExtensionEffects {
    inspect(exe: string): Promise<PhpAbi | null>;
    verify(install: PhpExtensionInstall, dll?: string): Promise<boolean>;
    stage(artifact: PhpExtensionArtifact): Promise<{ dll: string; dispose(): Promise<void> }>;
}
// Official PECL Windows archives, downloaded and SHA-256 pinned for this release.
// A new ABI requires a reviewed artifact; never substitute NTS, x86 or another compiler.
const REDIS_BUILDS: Record<string, { build: string; compiler: string; sha256: string }> = {
    '8.2': { build: 'API20220829,TS,VS16', compiler: 'vs16', sha256: '92ddf1e09011ada452c481e0c0e3551c6979d5ea865e2042651cd88216e5c4bf' },
    '8.3': { build: 'API20230831,TS,VS16', compiler: 'vs16', sha256: '6d04d2b5db80c7c88e504c6fc8b969d42e4f9866eefccb08e949944107a501d3' },
    '8.4': { build: 'API20240924,TS,VS17', compiler: 'vs17', sha256: 'ab63ee174ce18766179af7b9fcb540207817fb4187b8178795468cfbf0e277b5' },
};

export function redisArtifactFor(abi: PhpAbi): PhpExtensionArtifact | null {
    if (abi.zts !== true || abi.bits !== 64 || abi.debug !== false || typeof abi.version !== 'string') return null;
    const minor = /^(8\.\d+)\.\d+$/.exec(abi.version)?.[1];
    const target = minor ? REDIS_BUILDS[minor] : undefined;
    if (!target || abi.build !== target.build) return null;
    return {
        name: 'redis', version: '6.3.0', file: 'php_redis.dll', sha256: target.sha256,
        url: `https://downloads.php.net/~windows/pecl/releases/redis/6.3.0/php_redis-6.3.0-${minor}-ts-${target.compiler}-x64.zip`,
    };
}

export type PhpExtensionResult = { ok: true; changed: boolean } | { ok: false; error: string };
const installing = new Map<string, Promise<PhpExtensionResult>>();

/** One transaction per version directory, shared by concurrent repair/install requests. */
export function installPhpExtensions(install: PhpExtensionInstall, fx: PhpExtensionEffects): Promise<PhpExtensionResult> {
    const key = resolve(install.dir).toLowerCase();
    const existing = installing.get(key);
    if (existing) return existing;
    const pending = installExtensions(install, fx).finally(() => installing.delete(key));
    installing.set(key, pending);
    return pending;
}

async function readOptional(file: string): Promise<Buffer | null> {
    try { return await readFile(file); }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
    }
}

async function atomicWrite(file: string, contents: Buffer | string): Promise<void> {
    const temp = `${file}.genie-${randomUUID()}`;
    try {
        await writeFile(temp, contents);
        await rename(temp, file);
    } finally { await rm(temp, { force: true }); }
}

async function restore(file: string, contents: Buffer | null): Promise<void> {
    if (contents === null) await rm(file, { force: true });
    else await atomicWrite(file, contents);
}

async function installExtensions(install: PhpExtensionInstall, fx: PhpExtensionEffects): Promise<PhpExtensionResult> {
    let staged: Awaited<ReturnType<PhpExtensionEffects['stage']>> | undefined;
    try {
        if (install.platform !== 'win32') throw new Error('Managed PECL installation currently supports Windows PHP only.');
        const abi = await fx.inspect(install.exe);
        const artifact = abi && redisArtifactFor(abi);
        if (!artifact) throw new Error('No compatible Redis build for this PHP ABI. Genie requires a supported non-debug ZTS x64 PHP build with its matching compiler and extension API.');
        if (await fx.verify(install)) return { ok: true, changed: false };

        staged = await fx.stage(artifact);
        if (!await fx.verify(install, staged.dll)) throw new Error('Redis DLL did not load in both PHP CLI and CGI; the installation was left unchanged.');

        const dll = join(install.dir, 'ext', artifact.file);
        const ini = join(install.dir, 'php.ini');
        const [oldDll, oldIni] = await Promise.all([readOptional(dll), readOptional(ini)]);
        if (oldIni === null) throw new Error('The managed php.ini is missing; repair the PHP configuration before installing extensions.');
        let dllChanged = false;
        let iniChanged = false;
        try {
            await mkdir(join(install.dir, 'ext'), { recursive: true });
            // Rename a sibling temp file so a partial copy is never offered to a new worker.
            const temp = `${dll}.genie-${randomUUID()}`;
            try { await copyFile(staged.dll, temp); await rename(temp, dll); }
            finally { await rm(temp, { force: true }); }
            dllChanged = true;
            const contents = oldIni.toString('utf8');
            if (!/^\s*extension\s*=\s*"?(?:php_)?redis(?:\.dll)?"?\s*(?:;[^\r\n]*)?$/m.test(contents)) {
                await atomicWrite(ini, `${contents.replace(/\s*$/, '')}\nextension=redis\n`);
                iniChanged = true;
            }
            if (!await fx.verify(install)) throw new Error('Redis did not load from the managed configuration in both PHP CLI and CGI.');
            return { ok: true, changed: true };
        } catch (error) {
            const rollbackErrors: string[] = [];
            for (const [changed, file, original] of [[iniChanged, ini, oldIni], [dllChanged, dll, oldDll]] as const) {
                if (!changed) continue;
                try { await restore(file, original); }
                catch { rollbackErrors.push(file); }
            }
            throw new Error(`${error instanceof Error ? error.message : 'Extension activation failed'}${rollbackErrors.length ? ` Rollback failed for: ${rollbackErrors.join(', ')}.` : ''}`);
        }
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : 'PHP extension installation failed' };
    } finally {
        if (staged) await staged.dispose();
    }
}
