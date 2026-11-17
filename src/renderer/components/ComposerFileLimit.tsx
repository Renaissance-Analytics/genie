import { useMemo, type ReactNode } from 'react';
import { useToast } from '@particle-academy/react-fancy';
import { fileLimitRefusal, incomingFileCount } from '../../core/composer.js';

/**
 * THE COMPOSER REFUSES THE FILE THAT WILL NOT GO, WHEN IT IS ADDED (the owner, 2026-11-16; core/composer.ts
 * MESSAGE_FILE_LIMIT).
 *
 * react-fancy's `PromptInput` has no hook to refuse a paste, a drop or a pick, so the guard sits around it and answers
 * first, in the CAPTURE phase: a file that would take the message over the limit is stopped there — the composer never
 * sees it, so nothing of it enters the draft — and a toast says why. A toast, never a line under the composer: the
 * owner does not want the layout to jump. Anything that fits passes through untouched.
 */

/** What the guard reads off a paste, drop or change event; a React synthetic event is one. */
export interface FileGuardEvent {
    target: unknown;
    clipboardData?: { files: ArrayLike<{ type: string }>; getData(format: string): string } | null;
    dataTransfer?: { files: ArrayLike<{ type: string }> } | null;
    preventDefault(): void;
    stopPropagation(): void;
}

export function composerFileGuard(deps: { count: () => number; refuse: (words: string) => void }): {
    onPasteCapture: (e: FileGuardEvent) => void;
    onDropCapture: (e: FileGuardEvent) => void;
    onChangeCapture: (e: FileGuardEvent) => void;
} {
    /** The refusal for `incoming` more files, or `null` when they fit. */
    const over = (incoming: number): string | null => fileLimitRefusal(deps.count(), incoming);
    return {
        onPasteCapture: (e) => {
            const data = e.clipboardData;
            const words = over(incomingFileCount('paste', { files: data?.files, text: data?.getData('text/plain') ?? '' }));
            if (words === null) return;
            e.preventDefault();
            e.stopPropagation();
            deps.refuse(words);
        },
        onDropCapture: (e) => {
            const words = over(incomingFileCount('drop', { files: e.dataTransfer?.files }));
            if (words === null) return;
            e.preventDefault();
            e.stopPropagation();
            // The composer lit up on dragover and clears only on its own drop or a dragleave: the drop it never got
            // would leave it lit, so it is told the drag left.
            const target = e.target as { dispatchEvent?: (event: Event) => boolean } | null;
            target?.dispatchEvent?.(new Event('dragleave', { bubbles: true }));
            deps.refuse(words);
        },
        onChangeCapture: (e) => {
            const input = e.target as { type?: unknown; files?: ArrayLike<{ type: string }> | null; value?: string } | null;
            if (!input || input.type !== 'file') return;
            const words = over(incomingFileCount('pick', { files: input.files }));
            if (words === null) return;
            e.stopPropagation();
            // Emptied, so the same file can be picked again once there is room.
            input.value = '';
            deps.refuse(words);
        },
    };
}

/** Around one chat's composer; under a react-fancy `Toast.Provider`. `display: contents` — it takes no layout box. */
export function ComposerFileLimit({ count, children }: { count: () => number; children: ReactNode }) {
    const { toast } = useToast();
    const guard = useMemo(() => composerFileGuard({ count, refuse: (words) => { toast({ title: 'Not added', description: words, variant: 'warning', duration: 4000 }); } }), [count, toast]);
    return (
        <div data-composer-file-limit="" className="contents" onPasteCapture={guard.onPasteCapture} onDropCapture={guard.onDropCapture} onChangeCapture={guard.onChangeCapture}>
            {children}
        </div>
    );
}
