import { useCallback, useEffect, useState } from 'react';
import { Text } from '@particle-academy/react-fancy';
import { api, type FlowScope, type FlowSummaryView } from '../../lib/genie';
import { describeTriggers } from '../../lib/flow-view';
import FlowEditorPanel from './FlowEditorPanel';

/**
 * A Genie App's workflows — the list, and the way into the canvas.
 *
 * This is a GENIE-drawn tab in the GApp window, appended after the app's own
 * tabs. That placement is not cosmetic: `layout()` in `apps/window.ts` maps
 * embedded view `i` to tab `i + 1`, so an index past the last app tab hides every
 * app view and leaves the space to Genie's renderer. A tab inserted in the middle
 * would shift those indices and put an app's view behind the wrong tab.
 *
 * It is Genie's surface rather than the app's for the same reason the tab strip
 * is: this is where a flow's PERMISSIONS are shown, and an app must not be able
 * to paint the screen that says what it is allowed to do.
 *
 * ## It is the SAME system as the Flow Manager
 *
 * Same table, same runner, same editor, same IPC. The only difference is the
 * SCOPE it asks with — `{ kind: 'gapp', appId }` — which decides both the flows
 * it lists and the palette its canvas offers. A GApp's flow is a flow whose
 * scope is `gapp`, not a second kind of thing with a second implementation.
 */

interface Props {
    appId: string;
}

export default function FlowsTab({ appId }: Props) {
    /** This app's vantage — the one thing that differs from the Flow Manager. */
    const scope: FlowScope = { kind: 'gapp', appId };

    const [flows, setFlows] = useState<FlowSummaryView[] | null>(null);
    const [editing, setEditing] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const refresh = useCallback(async () => {
        try {
            setFlows(await api().flows.list(scope));
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Could not list flows.');
        }
    }, [appId]);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    const create = useCallback(async () => {
        // Main mints it — the id, and the graph a new flow starts as. The
        // renderer cannot build that graph itself: it needs the live node
        // registry, and a `main/` module the renderer imports has to be a leaf
        // (`renderer-main-boundary.test.ts`). Values cross by IPC.
        const flow = await api().flows.create({ scope });
        await refresh();
        if (flow) setEditing(flow.id);
    }, [appId, refresh]);

    const remove = useCallback(
        async (flowId: string) => {
            await api().flows.remove(flowId);
            if (editing === flowId) setEditing(null);
            await refresh();
        },
        [editing, refresh],
    );

    const toggle = useCallback(
        async (flow: FlowSummaryView) => {
            await api().flows.setEnabled(flow.id, !flow.enabled);
            await refresh();
        },
        [refresh],
    );

    if (editing) {
        return (
            <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
                <div style={{ padding: 8 }}>
                    <button
                        type="button"
                        onClick={() => {
                            setEditing(null);
                            void refresh();
                        }}
                    >
                        ← All flows
                    </button>
                </div>
                <div style={{ flex: 1, minHeight: 0 }}>
                    <FlowEditorPanel flowId={editing} scope={scope} />
                </div>
            </div>
        );
    }

    return (
        <div style={{ padding: 16, overflow: 'auto', height: '100%' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                <Text size="sm">Workflows</Text>
                <span style={{ flex: 1 }} />
                <button type="button" onClick={() => void create()}>
                    New flow
                </button>
            </div>

            {error ? <Text size="sm">{error}</Text> : null}

            {flows === null ? (
                <Text size="sm">Loading…</Text>
            ) : flows.length === 0 ? (
                <Text size="sm">
                    No workflows yet. A flow can do exactly what this app was granted — no more.
                </Text>
            ) : (
                <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                    {flows.map((flow) => (
                        <li
                            key={flow.id}
                            style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 8,
                                padding: '8px 0',
                                borderBottom: '1px solid var(--bg-3, rgba(120,120,120,0.25))',
                            }}
                        >
                            <button
                                type="button"
                                onClick={() => setEditing(flow.id)}
                                style={{
                                    flex: 1,
                                    textAlign: 'left',
                                    background: 'none',
                                    border: 'none',
                                    color: 'inherit',
                                    cursor: 'pointer',
                                }}
                            >
                                <div>{flow.title}</div>
                                <div style={{ fontSize: 11, opacity: 0.7 }}>
                                    {/* A corrupt row is SAID so, not hidden — the user
                                        can open it and repair it. */}
                                    {flow.readable
                                        ? describeTriggers(flow.triggers)
                                        : 'Saved graph could not be read'}
                                </div>
                            </button>
                            <label style={{ fontSize: 11 }}>
                                <input
                                    type="checkbox"
                                    checked={flow.enabled}
                                    onChange={() => void toggle(flow)}
                                />{' '}
                                Enabled
                            </label>
                            <button type="button" onClick={() => void remove(flow.id)}>
                                Delete
                            </button>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
