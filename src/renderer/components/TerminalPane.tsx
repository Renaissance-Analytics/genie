import { Terminal, type TerminalHandle } from '@particle-academy/fancy-term';
import { useCallback, useEffect, useRef } from 'react';
import { outputStep, type OutputView } from '../../core/terminal-output-stream.js';

/**
 * THE XTERM PANE — the one module in the renderer that imports `fancy-term`.
 *
 * It is a separate file, loaded with a dynamic `import()` from `Workspace.tsx`, for a measured
 * reason rather than taste: `fancy-term`'s peer `@xterm/addon-fit` is a UMD bundle whose
 * wrapper references `self` at module evaluation — NOT `@xterm/xterm`, which loads fine under
 * Node; Fancy measured the two apart after I had conflated them. So importing `fancy-term`
 * anywhere Node can reach — a `react-dom/server` render test, an SSR — throws
 * `ReferenceError: self is not defined` before a single component runs. Both of this build's
 * render tests died that way on CI and in the test VM. Vite bundles this for the renderer
 * where `self` exists; nothing else may import it. (`fancy-term@0.6.2` fixed the separate
 * named-export-from-CJS error that sat in front of this one.)
 *
 * The props are exactly what `Workspace` owns: the buffer, and the two callbacks that reach
 * the pty. No ids, no bridge — the pane does not know what it is showing.
 */
export interface TerminalPaneProps {
    paneId: string;
    output: string;
    /**
     * Where the output stream is (Tynn #542): characters appended in this epoch, and the epoch (a new one when the output
     * is replaced). With them the pane writes only what was appended, even once `output` is trimmed at the view's cap.
     */
    outputEnd?: number;
    outputEpoch?: number;
    readOnly: boolean;
    onData: (data: string) => void;
    onResize: (size: { cols: number; rows: number }) => void;
    /** What relative file paths in the output are relative to: the workspace's folder. */
    root?: string;
    /** A file path in the output was clicked (fancy-term 0.8.0): the workspace decides whether and where it opens. */
    onOpenFile?: (file: { path: string; line?: number; column?: number; absolutePath?: string }) => void;
}

export function TerminalPane({ paneId, output, outputEnd, outputEpoch, readOnly, onData, onResize, root, onOpenFile }: TerminalPaneProps) {
    /*
     * WRITTEN, NOT DIFFED (Tynn #542). fancy-term's controlled `output` compares each new string with the one it wrote, and
     * resets the terminal for anything that is not an extension. Past the view's cap every batch is trimmed from the front,
     * so the terminal was reset and given all 2 MB again on every batch. The terminal is uncontrolled here, and the pane
     * writes what `outputStep` says: what was appended, from the stream position; a reset only for a new stream.
     */
    const term = useRef<TerminalHandle | null>(null);
    const shown = useRef<OutputView | null>(null);
    const latest = useRef<OutputView>({ text: output });
    latest.current = { text: output, ...(outputEnd !== undefined ? { end: outputEnd } : {}), ...(outputEpoch !== undefined ? { epoch: outputEpoch } : {}) };
    const apply = useCallback((): boolean => {
        const handle = term.current;
        if (!handle?.xterm) return false;
        const next = latest.current, step = outputStep(shown.current, next);
        if (step) { if (step.reset) handle.reset(); if (step.write) handle.write(step.write); }
        shown.current = next;
        return true;
    }, []);
    // A terminal made again (a remount) starts empty: it is given everything again.
    useEffect(() => () => { shown.current = null; }, []);
    useEffect(() => { if (!apply()) void term.current?.ready.then(() => apply()); }, [output, outputEnd, outputEpoch, apply]);
    return (
        <Terminal
            ref={term}
            data-terminal-pane={paneId}
            className="h-full w-full"
            readOnly={readOnly}
            onData={onData}
            onResize={onResize}
            // Clickable output (fancy-term 0.8.0): a URL opens in the browser through the window's link guard; a file path
            // (`src/app.ts:42:7`) goes to the workspace, which opens it in its file panel at the line when it is inside.
            links={{
                url: (url) => { if (/^https?:/i.test(url)) window.open(url, '_blank', 'noopener'); },
                file: (file) => onOpenFile?.(file),
                ...(root ? { root } : {}),
            }}
        />
    );
}
