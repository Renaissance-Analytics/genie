/**
 * A WINDOW'S PAGE ENDED AND WAS BROUGHT BACK (Tynn #386; main/renderer-recovery.ts): what the window says about it.
 */
export interface RendererNotice {
    readonly at: number;
    /** Electron's reason: `oom`, `crashed`, `killed`, … */
    readonly reason: string;
    /** The page's last known working set, in MB; `null` = never sampled. */
    readonly rendererMb: number | null;
    /** How many times within ten minutes (the cap is three). */
    readonly reloads: number;
}

/** In plain words: what ended it. */
export function rendererEndWords(reason: string): string {
    if (reason === 'oom') return 'ran out of memory';
    if (reason === 'killed') return 'was ended by the system';
    if (reason === 'launch-failed') return 'could not start';
    return 'crashed';
}

/** "Genie's window ran out of memory and was reloaded at 3:04 PM. Your agents kept running." */
export function rendererNoticeWords(notice: RendererNotice, clock: (at: number) => string): string {
    return `Genie's window ${rendererEndWords(notice.reason)} and was reloaded at ${clock(notice.at)}. Your agents kept running.`;
}
