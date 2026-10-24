import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, rename, rm, rmdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const REFUSED = 'Private Tynn credential permissions could not be secured.';
type Target = { path: string; directory: boolean };

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
    // A fresh protected DACL replaces explicit foreign grants as well as inherited ones.
    // Never /reset an existing credential directory: that would temporarily restore parent grants.
    const paths = targets.map((target) => `@{Path=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${Buffer.from(target.path, 'utf16le').toString('base64')}'));Directory=$${target.directory}}`).join(',');
    const script = `
$ErrorActionPreference='Stop'
try {
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
    exit 0
} catch { exit 1 }
`;
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.toUpperCase() === 'PSMODULEPATH') delete env[key];
    await run(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
    ], { env, windowsHide: true, timeout: 15_000, maxBuffer: 65_536 }).catch(() => { throw new Error(REFUSED); });
}

/** Restrict existing storage before reading it or issuing a credential. Final links are refused. */
export async function preparePrivateCredential(file: string): Promise<void> {
    const path = resolve(file);
    const directory = { path: dirname(path), directory: true };
    let created = false;
    try {
        if (!await inspect(directory)) created = (await mkdir(directory.path, { recursive: true, mode: 0o700 })) !== undefined;
        if (!await inspect(directory)) throw new Error(REFUSED);
        const target = { path, directory: false };
        const existing = await inspect(target);
        await restrict(existing ? [directory, target] : [directory]);
    } catch {
        // Only our new empty leaf may be removed. Existing data and parent directories are never deleted.
        if (created) await rmdir(directory.path).catch(() => {});
        throw new Error(REFUSED);
    }
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
    } catch { throw new Error(REFUSED); }
}

/** Encrypted JSON is staged exclusively inside its private parent and restricted before replacement. */
export async function writePrivateCredential(file: string, text: string): Promise<void> {
    await preparePrivateCredential(file);
    const temp = `${resolve(file)}.${randomUUID()}.tmp`;
    let created = false;
    try {
        const handle = await open(temp, 'wx', 0o600);
        created = true;
        try { await handle.writeFile(text, 'utf8'); } finally { await handle.close(); }
        await restrict([{ path: temp, directory: false }]);
        await rename(temp, file);
    } finally { if (created) await rm(temp, { force: true }).catch(() => {}); }
}
