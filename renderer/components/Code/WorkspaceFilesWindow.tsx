import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentSession } from '../../../main/agentsession/model';
import { api, makeSystemWorkspace, SYSTEM_WORKSPACE_ID, type TerminalSpec, type WorkspaceRow } from '../../lib/genie';
import CodePanel from './CodePanel';
import { PromptHost, showPrompt } from '../Master/Prompt';
import { emitOpenInPanelAndWait } from '../../lib/editor-open';
import { poppedWindowIntent } from '../../lib/file-panel-states';

export default function WorkspaceFilesWindow({ specId }: { specId: string }) {
    const [spec, setSpec] = useState<TerminalSpec | null>(null);
    const [workspace, setWorkspace] = useState<WorkspaceRow | undefined>();
    const [sessions, setSessions] = useState<AgentSession[]>([]);
    const [error, setError] = useState<string | null>(null);
    const dirty = useRef(false);
    const allowClose = useRef(false);
    const onDirtyChange = useCallback((value: boolean) => { dirty.current = value; }, []);

    useEffect(() => {
        let alive = true;
        const load = () => void Promise.all([api().terminalSpec.get(specId), api().workspaces.list()])
            .then(([panel, workspaces]) => {
                if (!alive) return;
                if (!panel || panel.type !== 'code') { setError('File panel not found.'); return; }
                setSpec(panel);
                setWorkspace(panel.meta?.system ? makeSystemWorkspace(panel.cwd) : workspaces.find((row) => row.id === (panel.workspace_id ?? SYSTEM_WORKSPACE_ID)));
            }).catch((failure: unknown) => { if (alive) setError(String(failure)); });
        const loadSessions = () => void api().agentSession.list().then((rows) => {
            if (alive) setSessions(rows);
        }).catch(() => {});
        const off = [
            api().on.editorOpenFile((request) => {
                void emitOpenInPanelAndWait(specId, request.relPath, request.line)
                    .then((opened) => api().editor.openFileResult(request.requestId, { reused: true, opened }))
                    .catch(() => api().editor.openFileResult(request.requestId, { reused: true, opened: false }));
            }),
            api().on.terminalSpecsChanged(load),
            api().on.agentsChanged(loadSessions),
            api().on.agentPulse(loadSessions),
            api().on.terminalAttention(loadSessions),
            api().on.treeChanged(loadSessions),
        ];
        load();
        loadSessions();
        return () => { alive = false; off.forEach((unsubscribe) => unsubscribe()); };
    }, [specId]);

    useEffect(() => {
        if (spec) void api().files.readyPanel(specId);
    }, [spec, specId]);

    useEffect(() => {
        const beforeUnload = (event: BeforeUnloadEvent) => {
            if (!dirty.current || allowClose.current) return;
            event.preventDefault();
            event.returnValue = false;
            void showPrompt({ title: 'Unsaved changes', body: 'Discard unsaved edits and close this window?', confirmLabel: 'Discard', destructive: true })
                .then((answer) => {
                    if (answer === null) return;
                    allowClose.current = true;
                    window.close();
                });
        };
        window.addEventListener('beforeunload', beforeUnload);
        return () => window.removeEventListener('beforeunload', beforeUnload);
    }, []);

    /**
     * ⌘B closes this window — §5.3's *"Closing it (⌘B) looks the same, without the bar"*.
     *
     * The same chord opens the panel in the workspace, and `poppedWindowIntent` maps that one
     * existing intent rather than matching the key again here. `window.close()` goes through
     * the beforeunload guard above, so an unsaved edit still gets its prompt instead of being
     * discarded by a keystroke.
     */
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (poppedWindowIntent(event) !== 'close-window') return;
            event.preventDefault();
            window.close();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);

    if (error) return <div className="code-empty">{error}</div>;
    if (!spec) return <div className="code-empty">Opening workspace files…</div>;
    return <>
        <CodePanel spec={spec} workspace={workspace} sessions={sessions} onDirtyChange={onDirtyChange} onClose={() => { allowClose.current = true; window.close(); }} style={{ height: '100vh' }} />
        <PromptHost />
    </>;
}
