/**
 * THE SOUND OF AN ISSUEWATCH BATCH, AS GENIE-HOST SAYS IT TO ITS WINDOWS (Tynn #934 task #1474). genie-host hears Tynn and
 * holds IssueWatch; a batch plays one sound per kind (core/issue-watch.ts `issueWatchSoundKinds`) in the windows open NOW.
 * It travels as a tool signal, the road mail's and the things' sounds take, and it is never kept for a later window. The
 * signal names one of the four sound rows and nothing else: what a window is handed is read strictly, so no other
 * `genie:action` kind can be said this way.
 */
export const ISSUE_WATCH_SOUNDS = ['ghissue', 'ghpr', 'ghsecurity', 'ghci'] as const;
export type IssueWatchSoundKind = (typeof ISSUE_WATCH_SOUNDS)[number];

export interface IssueWatchSoundSignal {
    readonly kind: 'issuewatch';
    readonly sound: IssueWatchSoundKind;
}

export function issueWatchSoundSignal(sound: IssueWatchSoundKind): IssueWatchSoundSignal {
    return { kind: 'issuewatch', sound };
}

/** The sound a tool signal names; anything that does not read is no sound. */
export function readIssueWatchSound(raw: unknown): IssueWatchSoundKind | null {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const signal = raw as { kind?: unknown; sound?: unknown };
    if (signal.kind !== 'issuewatch' || typeof signal.sound !== 'string') return null;
    return ISSUE_WATCH_SOUNDS.find((s) => s === signal.sound) ?? null;
}
