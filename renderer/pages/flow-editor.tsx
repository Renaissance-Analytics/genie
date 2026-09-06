import { useEffect, useState } from 'react';
import { Text } from '@particle-academy/react-fancy';
import FlowEditorPanel from '../components/Flows/FlowEditorPanel';
import { describeFlowSource } from '../lib/flow-view';
import { api, hasGenieBridge, isRemoteWindow, type FlowScope } from '../lib/genie';

/**
 * The Flow editor, in a window of its own (genie#505).
 *
 * A node graph is panned, zoomed and dragged, with a palette down one side and
 * an inspector down the other. It used to open in `.prompt-card` — Genie's
 * ordinary modal — widened twice and still clipping at the bottom of the
 * viewport, because 48px of margin inside a window that already has a titlebar,
 * a workspace rail and a terminal behind it is not room for a canvas. Widening
 * it a third time would have been the third round of the same fix.
 *
 * So the editor gets what Settings, Docs and the Knowledge Graph have: a real
 * `BrowserWindow` (`createFlowEditorWindow` in `main/background.ts`) whose whole
 * client area is the canvas.
 *
 * ## The page is a HOST, not a second editor
 *
 * `FlowEditorPanel` is the same component the GApp Flows tab renders, and it
 * does not learn which container it is in — it measures whatever width it is
 * given and lays its panes out from that. Everything this page adds is what only
 * a WINDOW needs: the flow to open, the window's title, and the sentence about
 * whose flows these are.
 *
 * ## The scope comes from the flow, not the URL
 *
 * A scope in the query string would be a scope the OPENER chose, and the scope
 * decides both the palette and what the admission check will allow. Reading it
 * off the stored row instead means a hand-edited URL cannot ask for a wider
 * vocabulary than the flow actually has.
 *
 * SSR-safe by construction: Next statically renders this page at build time, so
 * every read of `window` is inside an effect.
 */
export default function FlowEditorPage() {
    const [flowId, setFlowId] = useState<string | null>(null);
    const [scope, setScope] = useState<FlowScope | null>(null);
    const [hostName, setHostName] = useState<string | undefined>(undefined);
    const [error, setError] = useState<string | null>(null);
    const [remote, setRemote] = useState(false);

    useEffect(() => {
        setRemote(isRemoteWindow());
        const id = new URLSearchParams(window.location.search).get('flow');
        if (!id) {
            setError('This window was opened without a flow to edit.');
            return;
        }
        setFlowId(id);
        if (!hasGenieBridge()) return;

        let alive = true;
        void api()
            .flows.get(id)
            .then((flow) => {
                if (!alive) return;
                if (!flow) {
                    setError('That flow no longer exists.');
                    return;
                }
                // The scope the flow WAS SAVED WITH. A row whose scope could not
                // be read opens at the machine's own vantage rather than not at
                // all — the graph is still editable and still repairable, which
                // is the same call the panel makes about an unreadable graph.
                setScope(flow.scope ?? { kind: 'system' });
                // What the taskbar shows. Several editors can be open at once,
                // and "Flow Editor" three times over names none of them.
                document.title = `${flow.title} — Flow`;
            })
            .catch((e: unknown) => {
                if (alive) setError(e instanceof Error ? e.message : String(e));
            });
        return () => {
            alive = false;
        };
    }, []);

    // A remote window's editor reads THIS workstation's flows, because `flows.*`
    // is not routed over the bridge (genie#415). Naming the host it is NOT
    // showing needs the host's name, so fetch it — only in the case that uses it.
    useEffect(() => {
        if (!remote || !hasGenieBridge()) return;
        let alive = true;
        void api()
            .remote.status()
            .then((s) => {
                if (alive) setHostName(s.host?.hostname);
            })
            .catch(() => {});
        return () => {
            alive = false;
        };
    }, [remote]);

    const sourceNote = describeFlowSource({ remote, hostName });

    return (
        <div className="flowwin">
            {/* Said BEFORE the canvas, because the canvas is the thing that would
                otherwise mislead: a host window's editor looks identical to a
                local one and is about a different computer. */}
            {sourceNote && <div className="flowmgr-source">{sourceNote}</div>}
            <div className="flowwin-body">
                {!hasGenieBridge() ? (
                    <Text size="sm">This runs inside Genie.</Text>
                ) : error ? (
                    <Text size="sm">{error}</Text>
                ) : flowId && scope ? (
                    <FlowEditorPanel flowId={flowId} scope={scope} />
                ) : (
                    <Text size="sm">Opening…</Text>
                )}
            </div>
        </div>
    );
}
