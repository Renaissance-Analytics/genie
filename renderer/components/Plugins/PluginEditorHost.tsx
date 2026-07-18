import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { IconCheck, IconMaximize, IconMinimize, IconX } from '../Master/icons';
import PluginEditorBody from './PluginEditorBody';
import { type TerminalSpec, type WorkspaceRow } from '../../lib/genie';
import type { PanelDragHandlers } from '../../lib/panel-reorder';

/**
 * STANDALONE panel host for a plugin-declared Fancy editor — kept for
 * previously-created `type:'plugin'` specs (they persist in the DB and must
 * keep rendering). New opens land as a TAB inside the Code panel instead
 * (CodePanel hosts PluginEditorBody directly), so this is just the panel
 * chrome (head, save, maximize/close) around the shared body.
 */

interface Props {
    spec: TerminalSpec;
    workspace?: WorkspaceRow;
    onClose: () => void;
    onMaximize?: () => void;
    onMinimize?: () => void;
    focused?: boolean;
    attention?: boolean;
    maximized?: boolean;
    style?: CSSProperties;
    /**
     * Panel drag-reorder wiring (TerminalGrid owns the state). `draggable` +
     * start/end sit on the panel HEAD so dragging never competes with text
     * selection in the body; over/drop sit on the panel ROOT so the whole tile
     * is a drop target.
     */
    drag?: PanelDragHandlers;
}

export default function PluginEditorHost({
    spec,
    workspace,
    onClose,
    onMaximize,
    onMinimize,
    focused,
    attention,
    maximized,
    style,
    drag,
}: Props) {
    const root = workspace?.path ?? spec.cwd;
    const file = String(spec.meta?.file ?? spec.meta?.file_path ?? '');
    const pluginId = String(spec.meta?.plugin_id ?? '');
    const fancyExport = String(spec.meta?.fancy_export ?? 'DeckEditor');

    const [dirty, setDirty] = useState(false);
    const saveRef = useRef<(() => Promise<void>) | null>(null);
    const registerSave = useCallback((fn: () => Promise<void>) => {
        saveRef.current = fn;
    }, []);
    const save = useCallback(async () => {
        await saveRef.current?.();
    }, []);

    // Ctrl/Cmd+S -> save (bound once; reads the live handler).
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
                e.preventDefault();
                void save();
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [save]);

    return (
        <section
            className={`tpanel${focused ? ' focus' : ''}${attention ? ' attention' : ''}${
                drag?.dragging ? ' dragging' : ''
            }`}
            style={style}
            onDragOver={drag?.onDragOver}
            onDrop={drag?.onDrop}
        >
            <div
                className={`tpanel-head${drag ? ' draggable' : ''}`}
                draggable={!!drag}
                onDragStart={drag?.onDragStart}
                onDragEnd={drag?.onDragEnd}
                title={drag ? 'Drag onto another panel to reorder' : undefined}
            >
                <span className="pdot" style={{ background: '#8b5cf6' }} />
                <span className="pn">
                    <span className="nm">{spec.label}</span>
                    {dirty && <span className="dirty-dot" title="Unsaved changes" />}
                </span>
                <span className="grow" />
                <span className="pa">
                    <button
                        type="button"
                        className="pctl save-btn"
                        onClick={() => void save()}
                        disabled={!dirty}
                        title={dirty ? 'Save (Ctrl/Cmd+S)' : 'Saved'}
                    >
                        <IconCheck size={13} />
                    </button>
                    {onMinimize && !maximized && (
                        <button
                            type="button"
                            className="pctl"
                            onClick={onMinimize}
                            title="Send to side stack"
                        >
                            <IconMinimize />
                        </button>
                    )}
                    {onMaximize && (
                        <button
                            type="button"
                            className="pctl"
                            onClick={onMaximize}
                            title={maximized ? 'Restore tiled view' : 'Maximize panel'}
                        >
                            {maximized ? <IconMinimize /> : <IconMaximize size={13} />}
                        </button>
                    )}
                    <button type="button" className="pctl" onClick={onClose} title="Close panel">
                        <IconX />
                    </button>
                </span>
            </div>
            <div className="plugin-editor-host-body">
                <PluginEditorBody
                    pluginId={pluginId}
                    fancyExport={fancyExport}
                    root={root}
                    file={file}
                    onDirtyChange={setDirty}
                    registerSave={registerSave}
                />
            </div>
        </section>
    );
}
