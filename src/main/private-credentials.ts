import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, readdir, rename, rm, rmdir } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { AsyncLocalStorage } from 'node:async_hooks';
import { HelperLost, WindowsHelper, type HelperChild, type WindowsHelperOptions } from './windows-helper.js';

const run = promisify(execFile);
const REFUSED = 'Private Tynn credential permissions could not be secured.';
// Healthy cold Windows calls reached9.84s; leave bounded headroom for slow PowerShell startup/disk access.
const NATIVE_ACL_TIMEOUT_MS = 60_000;
let failureLog: ((line: string) => void) | undefined;

/** The composition root supplies its existing rotating log; credential paths never choose a log destination. */
export function setPrivateCredentialFailureLog(log: (line: string) => void): () => void {
    const previous = failureLog;
    failureLog = log;
    return () => { if (failureLog === log) failureLog = previous; };
}

function recordNativeFailure(error: unknown, began: number): void {
    try {
        const native = error as { code?: unknown; errno?: unknown; killed?: unknown; signal?: unknown } | null;
        const code = typeof native?.code === 'number' && Number.isInteger(native.code) ? native.code
            : typeof native?.code === 'string' && /^E[A-Z0-9_]{1,63}$/.test(native.code) ? native.code : null;
        const errno = typeof native?.errno === 'number' && Number.isInteger(native.errno) ? native.errno : null;
        const signal = typeof native?.signal === 'string' && /^SIG[A-Z]{1,12}$/.test(native.signal) ? native.signal : null;
        const killed = native?.killed === true;
        const elapsedMs = Math.max(0, Math.round(performance.now() - began));
        // Node does not expose a distinct timeout errno. Preserve the observed termination signature,
        // rather than claiming that a generic refusal identifies a historical failure's cause.
        const reason = code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'output-limit'
            : killed ? (code === null && signal === 'SIGTERM' && elapsedMs >= NATIVE_ACL_TIMEOUT_MS ? 'terminated-after-deadline' : 'terminated')
                : typeof code === 'number' ? 'process-exit' : code ? 'spawn-error' : 'unknown';
        const diagnostic = { operation: 'restrict-private-credential-acl', elapsedMs, timeoutMs: NATIVE_ACL_TIMEOUT_MS, reason, code, errno, killed, signal };
        // Never log the native Error: it carries encoded commands, paths, stdout and stderr.
        try { console.warn('PRIVATE_CREDENTIAL_ACL_FAILURE', diagnostic); } catch { /* Diagnostic sinks cannot change refusal/cleanup. */ }
        try { failureLog?.(`PRIVATE_CREDENTIAL_ACL_FAILURE ${JSON.stringify(diagnostic)}`); } catch { /* Keep the original refusal. */ }
    } catch { /* Even malformed diagnostic metadata cannot replace the storage refusal. */ }
}

type Target = { path: string; directory: boolean };
class SharedCredentialDirectoryError extends Error {
    constructor() { super('Private Tynn credential directory contains unrelated entries; refusing to change its permissions.'); }
}

function temporaryCredentialName(name: string, fileName: string): boolean {
    const normalize = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
    const candidate = normalize(name);
    const prefix = `${normalize(fileName)}.`;
    return candidate.startsWith(prefix) && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/i.test(candidate.slice(prefix.length));
}

async function assertPrivateDirectory(directory: string, file: string): Promise<void> {
    const normalize = (name: string) => process.platform === 'win32' ? name.toLowerCase() : name;
    const own = normalize(basename(file));
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const name = normalize(entry.name);
        const temporary = temporaryCredentialName(entry.name, basename(file));
        if (!entry.isFile() || (name !== own && !temporary)) throw new SharedCredentialDirectoryError();
    }
}

async function inspect(target: Target) {
    try {
        const entry = await lstat(target.path);
        if (entry.isSymbolicLink() || (target.directory ? !entry.isDirectory() : !entry.isFile())) throw new Error(REFUSED);
        return entry;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
    }
}

function windowsAcl(targets: readonly Target[]): string {
    // A fresh protected DACL replaces explicit foreign grants as well as inherited ones.
    // Never /reset an existing credential directory: that would temporarily restore parent grants.
    const paths = targets.map((target) => `@{Path=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${Buffer.from(target.path, 'utf16le').toString('base64')}'));Directory=$${target.directory}}`).join(',');
    return `
    $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
    foreach($target in @(${paths})) {
        $path=$target.Path
        $attributes=[IO.File]::GetAttributes($path)
        if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse point' }
        if ((($attributes -band [IO.FileAttributes]::Directory) -ne 0) -ne $target.Directory) { throw 'Wrong kind' }
        $inheritance=[Security.AccessControl.InheritanceFlags]::None
        if ($target.Directory) {
            $acl=[Security.AccessControl.DirectorySecurity]::new()
            $inheritance=[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
        } else { $acl=[Security.AccessControl.FileSecurity]::new() }
        $acl.SetAccessRuleProtection($true,$false)
        $acl.SetOwner($sid)
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::FullControl,$inheritance,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow))
        if ($target.Directory) {
            [IO.Directory]::SetAccessControl($path,$acl)
            $actual=[IO.Directory]::GetAccessControl($path)
        } else {
            [IO.File]::SetAccessControl($path,$acl)
            $actual=[IO.File]::GetAccessControl($path)
        }
        $rules=@($actual.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
        if (-not $actual.AreAccessRulesProtected -or $actual.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value -or $rules.Count -ne 1) { throw 'Unsafe ACL' }
        $rule=$rules[0]
        if ($rule.IsInherited -or $rule.IdentityReference.Value -ne $sid.Value -or $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or $rule.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl -or $rule.InheritanceFlags -ne $inheritance -or $rule.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None) { throw 'Unsafe rule' }
        if (([IO.File]::GetAttributes($path) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse point' }
    }
`;
}

function windowsScript(body: string): string {
    return `$ErrorActionPreference='Stop'\ntry {\n${body}\nexit 0\n} catch { exit 1 }`;
}

interface NativeAcl {
    readonly child: ChildProcess;
    readonly completed: Promise<{ stdout: string | Buffer; stderr: string | Buffer }>;
}

/**
 * THE HELPER (windows-helper.ts): the same script, the same read-back, with no launch. One per process, started on first need, and never on Electron main, which keeps a launch per write: main never
 * holds a process of its own for this, and a window with a host writes none of these. `undefined` is that default, a test can name its own, and `null` is a launch per write, which is what the
 * launch-count test's fault injection drives.
 */
let helper: WindowsHelper | null | undefined;
export function useAclHelper(chosen: WindowsHelper | null | undefined): void { helper = chosen; }
export function windowsHelper(options: Partial<Pick<WindowsHelperOptions, 'deadlineMs' | 'log'>> & { onStart?: (pid: number | null) => void } = {}): WindowsHelper {
    return new WindowsHelper({
        ...options,
        // Its reasons are a host's log line: paths and secrets never reach these words.
        log: options.log ?? ((line) => sayDiagnostic(line)),
        spawn: (file, args, env) => {
            const child = spawn(file, [...args], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
            try { options.onStart?.(child.pid ?? null); } catch { /* An observer cannot change private verification. */ }
            // Idle, it must not hold its owner open. While a request runs, the helper refs it again.
            child.unref();
            for (const pipe of [child.stdin, child.stdout] as Array<{ unref?: () => void } | null>) pipe?.unref?.();
            return child as unknown as HelperChild;
        },
    });
}
export function sharedWindowsHelper(): WindowsHelper | null {
    if (helper === undefined) helper = (process as { type?: string }).type === 'browser' ? null : windowsHelper();
    return helper;
}
// Its own clock, held from load: these timings must not take readings from anything a failure's diagnostic reads.
const timingClock = performance.now.bind(performance);
const SLOW_WRITE_MS = 5_000;
const HELD_THREAD_MS = 1_000;
/** A write a person would feel, said with which way it went. No path and no value. A window's or a host's stderr is its log. */
export function slowWriteLine(ms: number, way: string, why: string | null): string | null {
    return ms < SLOW_WRITE_MS ? null : `PRIVATE_FILE_SLOW_WRITE ${Math.round(ms)} ms through the ${way}${why ? `: ${why}` : ''}`;
}
const sayDiagnostic = (line: string | null): void => { if (line === null) return; try { console.error(line); failureLog?.(line); } catch { /* A diagnostic cannot change a write. */ } };

/** This attempt's: whether to skip the helper, and whether the helper was lost under it. */
const attempt = new AsyncLocalStorage<{ oneShot: boolean; lost: boolean; why?: string | null }>();

/**
 * THE VERIFICATION IS NEVER SKIPPED. A helper dead, hung or unstartable loses its request, and the whole attempt runs again by a launch, with the same script and the same read-back. A script that
 * refused is a refusal, and is not tried again: that is the answer, not a failure to get one. If the launch fails too, so does the write.
 */
async function withHelperOrALaunch<T>(work: () => Promise<T>): Promise<T> {
    const state: { oneShot: boolean; lost: boolean; why?: string | null } = { oneShot: false, lost: false };
    const began = timingClock();
    const way = () => (process.platform === 'win32' && sharedWindowsHelper() ? 'helper' : 'launch');
    try {
        const done = await attempt.run(state, work);
        sayDiagnostic(slowWriteLine(timingClock() - began, way(), null));
        return done;
    } catch (error) {
        if (!state.lost) { sayDiagnostic(slowWriteLine(timingClock() - began, way(), 'refused')); throw error; }
        try {
            return await attempt.run({ oneShot: true, lost: false }, work);
        } finally {
            sayDiagnostic(slowWriteLine(timingClock() - began, 'helper, then a launch', state.why ?? null));
        }
    }
}

function startWindowsAcl(body: string): NativeAcl {
    const state = attempt.getStore();
    const through = state?.oneShot ? null : sharedWindowsHelper();
    if (through) {
        const began = performance.now();
        const request = through.run(body);
        return {
            child: { stdin: request.stdin, stdout: request.stdout, kill: () => request.kill() } as unknown as ChildProcess,
            completed: request.completed.catch((error: unknown) => {
                if (error instanceof HelperLost) { if (state) { state.lost = true; state.why = error.message; } }
                else recordNativeFailure(error, began);
                throw new Error(REFUSED);
            }),
        };
    }
    const script = windowsScript(body);
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.toUpperCase() === 'PSMODULEPATH') delete env[key];
    const began = performance.now();
    try {
        const held = timingClock();
        const work = run(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), [
            '-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
        ], { env, windowsHide: true, timeout: NATIVE_ACL_TIMEOUT_MS, maxBuffer: 65_536 });
        // CreateProcess runs on this thread, and no timer can fire while it does.
        if (timingClock() - held >= HELD_THREAD_MS) sayDiagnostic(`PRIVATE_FILE_LAUNCH starting it held this thread ${Math.round(timingClock() - held)} ms`);
        return { child: work.child, completed: work.catch((error: unknown) => {
            recordNativeFailure(error, began);
            throw new Error(REFUSED);
        }) };
    } catch (error) {
        recordNativeFailure(error, began);
        throw new Error(REFUSED);
    }
}

async function restrict(targets: readonly Target[]): Promise<void> {
    if (process.platform !== 'win32') {
        for (const target of targets) {
            const mode = target.directory ? 0o700 : 0o600;
            await chmod(target.path, mode);
            const entry = await inspect(target);
            if (!entry || (entry.mode & 0o777) !== mode || entry.uid !== process.getuid?.()) throw new Error(REFUSED);
        }
        return;
    }
    await startWindowsAcl(windowsAcl(targets)).completed;
}

const PREPARED = 'PRIVATE_CREDENTIAL_PREPARED\n';
const VERIFIED = 'PRIVATE_CREDENTIAL_VERIFIED:';
const STAGED = 'PRIVATE_CREDENTIAL_STAGED';

/** Keep the native verifier alive across Node's exclusive staging, without sending it credential bytes. */
async function restrictStagedWrite(targets: readonly Target[], temp: string, stage: () => Promise<void>, cleanup: () => Promise<void>): Promise<void> {
    const native = startWindowsAcl(`
        $pipe=[Console]::OpenStandardOutput()
        function Send-PrivateSignal([string]$message) {
            $bytes=[Text.Encoding]::UTF8.GetBytes($message+[Environment]::NewLine)
            $pipe.Write($bytes,0,$bytes.Length)
            $pipe.Flush()
        }
        ${windowsAcl(targets)}
        Send-PrivateSignal 'PRIVATE_CREDENTIAL_PREPARED'
        $reader=[IO.StreamReader]::new([Console]::OpenStandardInput(),[Text.UTF8Encoding]::new($false,$true))
        try {
            if ($reader.ReadLine() -cnotmatch '^${STAGED}:([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$') { throw 'Staging refused' }
            $stageId=$Matches[1]
            ${windowsAcl([{ path: temp, directory: false }])}
            Send-PrivateSignal ('PRIVATE_CREDENTIAL_VERIFIED:'+$stageId)
        } finally { $reader.Dispose() }
    `);
    const input = native.child.stdin;
    const output = native.child.stdout;
    const stop = () => { try { native.child.kill(); } catch { /* The bounded native call still owns its deadline. */ } };
    if (!input || !output) {
        stop();
        await native.completed.catch(() => {});
        throw new Error(REFUSED);
    }
    let received = '';
    let exited = false;
    let staged = false;
    let verification = '';
    let refused = false;
    let prepared!: () => void;
    let rejectPreparation!: (error: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => { prepared = resolve; rejectPreparation = reject; });
    const refuse = () => { refused = true; rejectPreparation(new Error(REFUSED)); stop(); };
    const onOutput = (chunk: Buffer | string) => {
        received += chunk.toString();
        const text = received.replace(/\r/g, '');
        if (!(PREPARED + verification).startsWith(text) || (!staged && text.length > PREPARED.length)) { refuse(); return; }
        if (text === PREPARED) prepared();
    };
    // Observe termination immediately, including a successful exit that never acknowledged preparation.
    void native.completed.then(() => { exited = true; rejectPreparation(new Error(REFUSED)); }, (error: unknown) => {
        exited = true; rejectPreparation(error);
    });
    try {
        output.on('data', onOutput);
        input.on('error', refuse);
        await ready;
        if (exited || refused) throw new Error(REFUSED);
        await stage();
        if (exited || refused) throw new Error(REFUSED);
        // A delayed, premature verification cannot know a challenge created only after staging completed.
        const challenge = randomUUID();
        verification = `${VERIFIED}${challenge}\n`;
        staged = true;
        input.end(`${STAGED}:${challenge}\n`);
        const result = await native.completed;
        if (refused || result.stdout.toString().replace(/\r/g, '') !== PREPARED + verification) throw new Error(REFUSED);
    } catch {
        stop();
        try { input?.destroy(); } catch { /* Preserve refusal and wait for this child to finish. */ }
        await native.completed.catch(() => {});
        await cleanup();
        throw new Error(REFUSED);
    } finally {
        output?.off('data', onOutput);
        input?.off('error', refuse);
    }
}

async function preparePrivateStorage(file: string, staged?: { temp: string; write: () => Promise<void>; cleanup: () => Promise<void> }): Promise<void> {
    const path = resolve(file);
    const directory = { path: dirname(path), directory: true };
    let created = false;
    try {
        if (!await inspect(directory)) created = (await mkdir(directory.path, { recursive: true, mode: 0o700 })) !== undefined;
        if (!await inspect(directory)) throw new Error(REFUSED);
        const target = { path, directory: false };
        const existing = await inspect(target);
        // A previous process may have died before it could verify or clean its stage. Never adopt or delete it.
        if (process.platform === 'win32' && (await readdir(directory.path)).some((name) => temporaryCredentialName(name, basename(path)))) throw new Error(REFUSED);
        await assertPrivateDirectory(directory.path, path);
        if (staged) {
            await restrictStagedWrite(existing ? [directory, target] : [directory], staged.temp, staged.write, staged.cleanup);
        } else {
            await restrict(existing ? [directory, target] : [directory]);
        }
    } catch (error) {
        // Only our new empty leaf may be removed. Existing data and parent directories are never deleted.
        if (created) await rmdir(directory.path).catch(() => {});
        throw error instanceof SharedCredentialDirectoryError ? error : new Error(REFUSED);
    }
}

/**
 * A FILE THAT IS NOT A CREDENTIAL'S, BUT HOLDS A SECRET (services.json, host.token). On Windows a mode means nothing: such a file inherited SYSTEM and Administrators from the folder. It gets the same
 * owner-only ACL and the same read-back. A file that is not there is a refusal: the caller knows which files it means.
 */
export async function restrictPrivateFile(file: string): Promise<void> {
    if (process.platform !== 'win32') return;
    const target = { path: resolve(file), directory: false };
    if (!await inspect(target)) throw new Error(REFUSED);
    await withHelperOrALaunch(() => restrict([target]));
}

/** Dedicated host-owned directories, using the same owner-only ACL and read-back as private files. */
export async function restrictPrivateDirectories(directories: readonly string[]): Promise<void> {
    const targets = directories.map(directory => ({ path: resolve(directory), directory: true }));
    for (const target of targets) if (!await inspect(target)) throw new Error(REFUSED);
    await withHelperOrALaunch(() => restrict(targets));
}

/** Staging's worker keeps this exact owner/DACL read-back, without the credential path's launch fallback. */
export async function restrictPrivateStagingTargets(targets: readonly Target[], through: WindowsHelper): Promise<void> {
    for (const target of targets) if (!await inspect(target)) throw new Error(REFUSED);
    if (process.platform !== 'win32') { await restrict(targets); return; }
    const began = performance.now();
    try { await through.run(windowsAcl(targets)).completed; }
    catch (error) { recordNativeFailure(error, began); throw new Error(REFUSED); }
}

/** Restrict existing storage before reading it or issuing a credential. Final links are refused. */
export async function preparePrivateCredential(file: string): Promise<void> {
    await withHelperOrALaunch(() => preparePrivateStorage(file));
}

/** Secure only the legacy FILE, never its shared parent, before moving into a private leaf. */
export async function migratePrivateCredential(legacyFile: string, file: string): Promise<void> {
    const legacy = { path: resolve(legacyFile), directory: false };
    const destination = { path: resolve(file), directory: false };
    try {
        if (legacy.path === destination.path) throw new Error(REFUSED);
        if (!await inspect(legacy)) return;
        await restrict([legacy]);
        await preparePrivateCredential(destination.path);
        // Two existing stores are ambiguous. Preserve both and require explicit recovery.
        if (await inspect(destination)) throw new Error(REFUSED);
        // Atomic rename removes the old name only on success. Failures retain the restricted old file.
        await rename(legacy.path, destination.path);
    } catch (error) { throw error instanceof SharedCredentialDirectoryError ? error : new Error(REFUSED); }
}

/** Where a private credential is kept: prepared before it is read, migrated from a legacy file, written in place. */
export interface PrivateCredentialStore {
    prepare(file: string): Promise<void>;
    migrate(legacyFile: string, file: string): Promise<void>;
    write(file: string, text: string): Promise<void>;
}

/** Genie's private store: an owner-only ACL on Windows (PowerShell), 0700/0600 elsewhere. */
export const PRIVATE_CREDENTIAL_STORE: PrivateCredentialStore = {
    prepare: (file) => preparePrivateCredential(file),
    migrate: (legacyFile, file) => migratePrivateCredential(legacyFile, file),
    write: (file, text) => writePrivateCredential(file, text),
};

/** Encrypted JSON is staged exclusively inside its private parent and restricted before replacement. */
export async function writePrivateCredential(file: string, text: string): Promise<void> {
    await withHelperOrALaunch(() => writePrivateCredentialOnce(file, text));
}

async function writePrivateCredentialOnce(file: string, text: string): Promise<void> {
    const temp = `${resolve(file)}.${randomUUID()}.tmp`;
    let created = false;
    const cleanup = async () => {
        if (created) await rm(temp, { force: true }).then(() => { created = false; }, () => {});
    };
    const stage = async () => {
        const handle = await open(temp, 'wx', 0o600);
        created = true;
        try { await handle.writeFile(text, 'utf8'); } finally { await handle.close(); }
    };
    try {
        if (process.platform === 'win32') {
            await preparePrivateStorage(file, { temp, write: stage, cleanup });
        } else {
            await preparePrivateCredential(file);
            await stage();
            await restrict([{ path: temp, directory: false }]);
        }
        await rename(temp, file);
    } finally { await cleanup(); }
}
