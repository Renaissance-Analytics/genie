import { Terminal } from '@particle-academy/fancy-term';

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
