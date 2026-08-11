import { type CSSProperties } from 'react';
import { IconMaximize, IconMinimize, IconX } from '../Master/icons';
import PluginPanelBody from './PluginPanelBody';
import { type TerminalSpec, type WorkspaceRow } from '../../lib/genie';
import type { PanelDragHandlers } from '../../lib/panel-reorder';

/**
 * Panel host for a plugin-declared workspace PANEL (`type:'plugin-panel'`).
 * Chrome mirror of {@link PluginEditorHost} — head / maximize / minimize / close
 * around the shared {@link PluginPanelBody} — but WITHOUT a save button: a panel
 * owns its own actions (the repo panel commits/pushes itself), unlike a file
 * editor whose dirty document the host saves.
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
    drag?: PanelDragHandlers;
}

export default function PluginPanelHost({
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
    const title = String(spec.meta?.panel_title ?? spec.label);

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
                    <span className="nm">{title}</span>
                </span>
                <span className="grow" />
                <span className="pa">
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
                <PluginPanelBody spec={spec} workspace={workspace} />
            </div>
        </section>
    );
}
