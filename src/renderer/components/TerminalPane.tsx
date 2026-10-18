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
    /** What relative file paths in the output are relative to: the workspace's folder. */
    root?: string;
    /** A file path in the output was clicked (fancy-term 0.8.0): the workspace decides whether and where it opens. */
    onOpenFile?: (file: { path: string; line?: number; column?: number; absolutePath?: string }) => void;
}

export function TerminalPane({ paneId, output, readOnly, onData, onResize, root, onOpenFile }: TerminalPaneProps) {
    return (
        <Terminal
            data-terminal-pane={paneId}
            className="h-full w-full"
            output={output}
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
