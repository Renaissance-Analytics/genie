import { Terminal } from '@particle-academy/fancy-term';

/**
 * THE XTERM PANE — the one module in the renderer that imports `fancy-term`.
 *
 * It is a separate file, loaded with a dynamic `import()` from `Workspace.tsx`, for a measured
 * reason rather than taste: `@xterm/xterm`'s bundle references `self` at module evaluation, so
 * importing `fancy-term` anywhere Node can reach — a `react-dom/server` render test, an SSR —
 * throws `ReferenceError: self is not defined` before a single component runs. Both of this
 * build's render tests died that way on CI and in the test VM. Vite bundles this for the
 * renderer where `self` exists; nothing else may import it.
 *
 * The props are exactly what `Workspace` owns: the buffer, and the two callbacks that reach
 * the pty. No ids, no bridge — the pane does not know what it is showing.
 */
export interface TerminalPaneProps {
    paneId: string;
    output: string;
    readOnly: boolean;
    onData: (data: string) => void;
    onResize: (size: { cols: number; rows: number }) => void;
}

export function TerminalPane({ paneId, output, readOnly, onData, onResize }: TerminalPaneProps) {
    return (
        <Terminal
            data-terminal-pane={paneId}
            className="h-full w-full"
            output={output}
            readOnly={readOnly}
            onData={onData}
            onResize={onResize}
        />
    );
}
