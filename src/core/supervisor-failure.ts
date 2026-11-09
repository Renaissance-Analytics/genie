/**
 * WHEN PRISM-ACP'S SUPERVISOR CANNOT RUN (Tynn #575). It is what starts every provider on Windows, so when antivirus
 * quarantines or blocks it, no agent starts. Said as that, naming the file: never a generic preparation failure. The words
 * are fixed plus the file: a preparation error can carry a key, so its text is matched and never repeated.
 */
let executable: string | null = null;

/** The file this process handed to prism-acp at startup. */
export function setSupervisorExecutable(path: string | null): void { executable = path; }

const SUPERVISOR_FILE = /prism-acp-supervisor/i;
const REFUSED_SPAWN = new Set(['EPERM', 'EACCES', 'ENOENT', 'UNKNOWN', 'EBUSY']);

function isSupervisorFailure(error: unknown): boolean {
    if (typeof error !== 'object' || error === null) return false;
    const { name, message, code, path } = error as { name?: unknown; message?: unknown; code?: unknown; path?: unknown };
    if (typeof code === 'string' && REFUSED_SPAWN.has(code) && typeof path === 'string' && SUPERVISOR_FILE.test(path)) return true;
    return name === 'ProcessTreeError' && typeof message === 'string' && /supervisor|approval adapter|private directory helper/i.test(message);
}

/** What to tell the person when this error is the supervisor failing, or `null` when it is anything else. Ends without a full stop. */
export function supervisorFailureWords(error: unknown, file: string | null = executable): string | null {
    if (!isSupervisorFailure(error)) return null;
    return `Genie's process supervisor could not run: ${file ?? 'prism-acp-supervisor.exe'}. Your antivirus may have quarantined or blocked it. Restore or allow that file, then restart Genie`;
}
