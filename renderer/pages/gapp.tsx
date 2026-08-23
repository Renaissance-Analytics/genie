import { useEffect, useState } from 'react';
import { Text } from '@particle-academy/react-fancy';
import { api, hasGenieBridge, type InstalledAppView, type WorkspaceRow } from '../lib/genie';
import Floor from '../components/Master/Floor';
import FlowsTab from '../components/Flows/FlowsTab';
import { useFloorState } from '../lib/use-floor-state';

/**
 * The GApp window (Tynn #250, App Tray pivot).
 *
 * GENIE draws this window. The frame, the tab strip and the first tab are Genie's,
 * and the app's own surfaces are embedded views the main process attaches beneath
 * the strip. That split is the anti-impersonation property made structural: an app
 * cannot draw the chrome around itself, so "am I looking at Genie or at the app?"
 * is answerable at a glance rather than by trusting what is painted.
 *
 * The FIRST tab is the Agent tab — a clone of TheFloor's panel management, because
 * a GApp is a special workspace and the answer to "what does it do here?" is
 * "whatever a workspace does". The app's tabs sit to its right, in the order the
 * manifest listed them.
 *
 * This page never renders app content itself. It renders the strip and tells main
 * which tab is showing; main positions the embedded view. Rendering app HTML in
 * here would put third-party markup in Genie's own renderer, which is the one
 * thing the whole design is arranged to prevent.
 *
 * A PREVIEW window is this page, unchanged. That is the whole claim of the
 * previewer: a developer looking at an uninstalled folder is looking at the same
 * strip, the same Agent tab and the same embedded views their users will get, not
 * at a lookalike. Only two things here know the difference — the strip says
 * "preview" instead of "development", and a warning band says what did not come
 * up — and both exist because the alternative is a window that quietly lies.
 */
export default function GAppWindow() {
    const [app, setApp] = useState<InstalledAppView | null>(null);
    const [tabs, setTabs] = useState<{ kind: 'agent' | 'app'; title: string }[]>([]);
    const [active, setActive] = useState(0);
    const [error, setError] = useState<string | null>(null);
    const [workspace, setWorkspace] = useState<WorkspaceRow | null>(null);
    const [preview, setPreview] = useState<{ folder: string; warnings: string[] } | null>(null);

    useEffect(() => {
        if (!hasGenieBridge()) return;
        api()
            .gapp.describe()
            .then((info) => {
                if (!info) {
                    setError('Genie does not recognise this window.');
                    return;
                }
                setApp(info.app);
                setTabs(info.tabs);
                setWorkspace(info.workspace);
                setPreview(info.preview ?? null);
            })
            .catch((e: Error) => setError(e.message));
    }, []);

    const floor = useFloorState(app?.workspaceId ?? null, workspace);

    // Telling main which tab is showing is what moves the embedded view. Done as an
    // effect rather than in the click handler so the window is correct after a
    // reload too, not only after a click.
    useEffect(() => {
        if (!hasGenieBridge() || tabs.length === 0) return;
        void api().gapp.showTab(active).catch(() => {});
    }, [active, tabs.length]);

    /**
     * The strip Genie actually draws: the app's tabs, then Genie's own Flows tab.
     *
     * APPENDED, never inserted. `layout()` in `apps/window.ts` maps embedded view
     * `i` to tab `i + 1`, so an index past the last app tab hides every app view
     * and leaves the space to this renderer — which is exactly what a Genie-drawn
     * tab needs. A tab inserted anywhere earlier would shift those indices and
     * show an app's view behind the wrong tab.
     */
    const stripTabs = [...tabs, { kind: 'flows' as const, title: 'Flows' }];
    const flowsTabIndex = stripTabs.length - 1;

    if (error) {
        return (
            <main style={{ padding: 24 }}>
                <Text>{error}</Text>
            </main>
        );
    }

    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
            <nav
                role="tablist"
                aria-label={app ? `${app.name} tabs` : 'App tabs'}
                data-testid="gapp-tabstrip"
                style={{
                    display: 'flex',
                    alignItems: 'stretch',
                    gap: 2,
                    height: 40,
                    padding: '0 8px',
                    background: 'var(--bg-1, #16161a)',
                    borderBottom: '1px solid var(--bg-3, rgba(120,120,120,0.25))',
                    // The strip is Genie's, and it stays above anything the app's
                    // embedded view might try to paint.
                    position: 'relative',
                    zIndex: 2,
                }}
            >
                {stripTabs.map((tab, i) => (
                    <button
                        key={`${tab.kind}-${tab.title}-${i}`}
                        type="button"
                        role="tab"
                        aria-selected={i === active}
                        data-testid={i === 0 ? 'gapp-tab-agent' : undefined}
                        onClick={() => setActive(i)}
                        style={{
                            border: 'none',
                            background: i === active ? 'var(--bg-2, #1d1d22)' : 'transparent',
                            color: 'inherit',
                            padding: '0 14px',
                            fontSize: 13,
                            cursor: 'pointer',
                            borderBottom:
                                i === active
                                    ? '2px solid var(--indigo-400, #818cf8)'
                                    : '2px solid transparent',
                        }}
                    >
                        {tab.title}
                    </button>
                ))}
                <span style={{ flex: 1 }} />
                {/* NO ADDRESS. A GApp window is technically a browser and none of
                    its UX may read as one (owner, 2026-08-22): no address bar, no
                    origin, anywhere. This corner used to print `{slug}.gen`.

                    What survives is the one thing the address was standing in for
                    — WHICH KIND of window this is. "preview" rather than
                    "development": both have dev tools on, but only one of them
                    disappears when the window closes, and that is the fact the
                    developer actually needs from this corner. */}
                {preview ? (
                    <span
                        style={{
                            alignSelf: 'center',
                            fontSize: 11,
                            letterSpacing: 0.3,
                            textTransform: 'uppercase',
                            color: 'var(--indigo-300, #a5b4fc)',
                            paddingRight: 6,
                        }}
                    >
                        Preview
                    </span>
                ) : app?.devMode ? (
                    <span
                        style={{
                            alignSelf: 'center',
                            fontSize: 11,
                            letterSpacing: 0.3,
                            textTransform: 'uppercase',
                            color: 'var(--fg-3, #9aa0aa)',
                            paddingRight: 6,
                        }}
                    >
                        Development
                    </span>
                ) : null}
            </nav>

            {/* What is NOT true of this window, said out loud and kept on screen.
                A preview whose site never came up shows empty app tabs, and an
                empty tab with no explanation is read as a bug in the app being
                built — the single wrong lesson a previewer could teach. */}
            {preview && preview.warnings.length > 0 && (
                <div
                    data-testid="gapp-preview-warnings"
                    style={{
                        padding: '6px 12px',
                        fontSize: 11,
                        lineHeight: 1.5,
                        color: 'var(--amber-200, #fde68a)',
                        background: 'var(--amber-950, rgba(120, 80, 10, 0.35))',
                        borderBottom: '1px solid rgba(180, 130, 40, 0.35)',
                        position: 'relative',
                        zIndex: 2,
                    }}
                >
                    {preview.warnings.map((w) => (
                        <div key={w}>{w}</div>
                    ))}
                </div>
            )}

            {/* The AGENT tab. Genie's own panel management — terminals and files,
                exactly as a workspace has them. Every other tab is an embedded view
                the MAIN process positions in this space, so this element is left
                empty for them rather than rendering anything of the app's. */}
            <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                {/* The Agent tab: the SAME Floor the master window mounts, for this
                    app's workspace. Kept mounted while other tabs show — hiding it
                    with `display` rather than unmounting is what keeps its ptys
                    alive, exactly as the master window keeps off-workspace panels
                    mounted-hidden across a switch. */}
                <div
                    data-testid="gapp-agent-panel"
                    style={{
                        display: active === 0 ? 'flex' : 'none',
                        flexDirection: 'column',
                        flex: 1,
                        minHeight: 0,
                    }}
                >
                    {app ? <Floor {...floor} /> : <Text size="sm">Loading…</Text>}
                </div>

                {/* The FLOWS tab — Genie's, not the app's. It is where a flow's
                    permissions are shown, and an app must not be able to paint the
                    screen that says what it is allowed to do. */}
                <div
                    data-testid="gapp-flows-panel"
                    style={{
                        display: active === flowsTabIndex ? 'flex' : 'none',
                        flexDirection: 'column',
                        flex: 1,
                        minHeight: 0,
                    }}
                >
                    {app ? <FlowsTab appId={app.id} /> : <Text size="sm">Loading…</Text>}
                </div>
            </div>
        </div>
    );
}
