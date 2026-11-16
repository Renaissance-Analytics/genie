/**
 * THE GUARD THAT KEEPS A MACHINE OUT OF A REPO (Tynn #756; the owner, 2026-11-16: "never saved: secrets, sign-ins, ports,
 * pids, absolute paths, run history, agent permissions").
 *
 * Everything "Save to repo" would write is scanned here first. A hit REFUSES the whole save and names the field, so the
 * person fixes the entry (or Genie rewrites it, in the PR that owns that element) instead of finding a drive letter in a
 * teammate's clone. Pure: it reads a value and answers.
 *
 * What it is NOT: a schema. shared-schemas says what a file may hold; this says what no file may EVER carry, whatever its
 * shape, so a future member added to a schema by mistake still cannot leak a password.
 */

export type GuardRule = 'absolute-path' | 'port' | 'secret-key' | 'secret-value' | 'machine-key' | 'unsafe-file-path';

export interface GuardViolation {
    /** Where, as a path into the value: `sites.998de12a1f1278a9.command[6]`. */
    readonly path: string;
    readonly rule: GuardRule;
    /** One sentence a person can act on. */
    readonly reason: string;
}

/** Keys that name a machine's run state or a capability grant: never saved, at any depth. */
const MACHINE_KEYS: ReadonlySet<string> = new Set([
    'pid', 'ppid', 'port', 'publishedPort', 'livePort', 'containerName', 'cwd', 'workspaceId',
    'armed', 'wanted', 'changedAt', 'lastRunAt', 'lastRunStatus', 'runs', 'inFlight', 'refusals',
    'autoApprove', 'permissions', 'manageTabs', 'drivePages', 'approval_gates', 'approvalGates',
]);

const SECRET_KEY = /(pass(word|wd|phrase)|secret|token|api[-_]?key|credential|private[-_]?key|authorization|bearer)/i;

const SECRET_VALUE: readonly RegExp[] = [
    /\bsk-[A-Za-z0-9_-]{16,}/,
    /\bgh[pousr]_[A-Za-z0-9]{20,}/,
    /\bAKIA[0-9A-Z]{16}\b/,
    /\bxox[abp]-[A-Za-z0-9-]{10,}/,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /\bBearer\s+[A-Za-z0-9._~+/-]{16,}/,
];

/** A drive path, a UNC path, or a POSIX path of two segments (or under a well-known root), standing alone or after a space, quote or `=`. */
const ABSOLUTE_PATH = /(^|[\s"'=(])(?:[A-Za-z]:[\\/]|\\\\[^\s\\]|\/(?:[A-Za-z0-9._-]+\/[A-Za-z0-9._-]|(?:home|Users|usr|opt|var|etc|tmp|mnt|srv|root|proc)\b))/;

/** A loopback or wildcard address with a port: the port one machine's Genie happened to be given. */
const LIVE_PORT = /(?:\b127(?:\.\d{1,3}){3}|\blocalhost|\b0\.0\.0\.0|\[::1\]):\d{2,5}\b/i;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The path of a child: `a.b` for a key, `a[2]` for an index. */
const child = (base: string, key: string): string => (base === '' ? key : `${base}.${key}`);

function scanString(text: string, path: string, out: GuardViolation[]): void {
    if (text.startsWith('//')) return;
    if (ABSOLUTE_PATH.test(text)) out.push({ path, rule: 'absolute-path', reason: `${path} holds an absolute path; it names this machine and would not exist in a clone` });
    if (LIVE_PORT.test(text)) out.push({ path, rule: 'port', reason: `${path} holds a loopback address with a port; Genie hands out ports on each machine, so a saved one points at nothing` });
    if (SECRET_VALUE.some((re) => re.test(text))) out.push({ path, rule: 'secret-value', reason: `${path} looks like a secret (a key, token or private key)` });
}

function walk(value: unknown, path: string, out: GuardViolation[]): void {
    if (typeof value === 'string') return scanString(value, path, out);
    if (Array.isArray(value)) {
        value.forEach((item, i) => walk(item, `${path}[${i}]`, out));
        return;
    }
    if (!isRecord(value)) return;
    for (const [key, item] of Object.entries(value)) {
        const here = child(path, key);
        if (MACHINE_KEYS.has(key)) out.push({ path: here, rule: 'machine-key', reason: `${here} is machine state or a permission grant (${key}); it is rebuilt or chosen on each machine, never saved` });
        else if (SECRET_KEY.test(key) && !(Array.isArray(item) && key === 'envKeys')) out.push({ path: here, rule: 'secret-key', reason: `${here} is named like a secret (${key}); values like it are never saved` });
        walk(item, here, out);
    }
}

/** Every violation in `value`, each naming where. `root` prefixes the paths (a file's name, say). */
export function scanForMachineState(value: unknown, root = ''): GuardViolation[] {
    const out: GuardViolation[] = [];
    walk(value, root, out);
    return out;
}

/** The only places a save may write, relative to the envelope. Anything else is refused: the save is for the workspace's own elements. */
const SAVE_PATHS: readonly RegExp[] = [
    /^project\.json$/,
    /^\.flows\/[A-Za-z0-9][A-Za-z0-9._-]*\.json$/,
    /^\.processes\/[A-Za-z0-9][A-Za-z0-9._-]*\.json$/,
    /^\.genie\/tabs\.json$/,
];

/** Why `path` may not be written, or null. */
export function savePathProblem(path: string): string | null {
    if (SAVE_PATHS.some((re) => re.test(path))) return null;
    return `${path} is not a file a save writes (project.json, .flows/<name>.json, .processes/<name>.json, .genie/tabs.json)`;
}
