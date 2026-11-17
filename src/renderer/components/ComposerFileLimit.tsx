import type { ReactNode } from 'react';

/** What the guard reads off a paste, drop or change event; a React synthetic event is one. */
export interface FileGuardEvent {
    target: unknown;
    clipboardData?: { files: ArrayLike<{ type: string }>; getData(format: string): string } | null;
    dataTransfer?: { files: ArrayLike<{ type: string }> } | null;
    preventDefault(): void;
    stopPropagation(): void;
}

/** STUB (RED): the handlers do nothing yet. */
export function composerFileGuard(_deps: { count: () => number; refuse: (words: string) => void }): {
    onPasteCapture: (e: FileGuardEvent) => void;
    onDropCapture: (e: FileGuardEvent) => void;
    onChangeCapture: (e: FileGuardEvent) => void;
} {
    return { onPasteCapture: () => {}, onDropCapture: () => {}, onChangeCapture: () => {} };
}

/** STUB (RED). */
export function ComposerFileLimit({ children }: { count: () => number; children: ReactNode }) {
    return <>{children}</>;
}
