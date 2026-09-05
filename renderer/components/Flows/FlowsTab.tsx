import { useCallback, useEffect, useState } from 'react';
import { Text } from '@particle-academy/react-fancy';
import { api, type FlowSummaryView, type FlowTriggerView } from '../../lib/genie';
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
 */

interface Props {
    appId: string;
}

/**
 * What a new flow starts as.
 *
 * A manual trigger, and nothing else. Not an empty graph: admission refuses one
 * (an empty graph is nearly always a failed load or a bad edit, and reporting
 * success for it hides both), so a new flow would open already complaining.
 */
function starterGraph() {
    return {
        nodes: [
            {
                id: 'start',
                type: 'trigger',
                position: { x: 80, y: 80 },
                data: {
                    kind: '@particle-academy/manual_trigger',
                    label: 'Start',
                    config: {},
                },
            },
        ],
        edges: [],
    };
}

/** "Runs daily at 03:00", roughly — enough for a list row. */
function describeTriggers(triggers: FlowTriggerView[]): string {
    if (triggers.length === 0) return 'No trigger';
    return triggers
        .map((t) => {
            if (t.kind === 'schedule') return t.cron ? `Schedule ${t.cron}` : 'Schedule (no cron)';
            if (t.kind === 'webhook') return 'Webhook (not armed)';
            return 'Manual';
        })
        .join(' · ');
}

export default function FlowsTab({ appId }: Props) {
    const [flows, setFlows] = useState<FlowSummaryView[] | null>(null);
    const [editing, setEditing] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const refresh = useCallback(async () => {
        try {
            setFlows(await api().gappFlows.list(appId));
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Could not list flows.');
        }
    }, [appId]);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    const create = useCallback(async () => {
        // Ids are minted here rather than by the database so the editor can open
        // immediately on the row it just made.
        const id = `flow-${Date.now().toString(36)}`;
        await api().gappFlows.save({ id, appId, name: 'New flow', graph: starterGraph() });
        await refresh();
        setEditing(id);
    }, [appId, refresh]);

    const remove = useCallback(
        async (flowId: string) => {
            await api().gappFlows.remove(flowId);
            if (editing === flowId) setEditing(null);
            await refresh();
        },
        [editing, refresh],
    );

    const toggle = useCallback(
        async (flow: FlowSummaryView) => {
            await api().gappFlows.setEnabled(flow.id, !flow.enabled);
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
                    <FlowEditorPanel appId={appId} flowId={editing} />
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
                                <div>{flow.name}</div>
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
