import type { HangNotice } from '../../core/crash-record.js';
import type { CrashReportPort, SafeModeAnswer } from './SafeModeBanner.js';

/** THE REOPENED WINDOW'S NOTICE (#1623 review; Tynn #386). Not built yet: this is its shape. */
export interface HangNoticeBarProps {
    notice: HangNotice | null | undefined;
    clock?: (at: number) => string;
    onStopAll: () => Promise<SafeModeAnswer>;
    onDismiss: () => Promise<SafeModeAnswer>;
    crashReport?: CrashReportPort | undefined;
}

export function HangNoticeBar(_props: HangNoticeBarProps) {
    return null;
}
