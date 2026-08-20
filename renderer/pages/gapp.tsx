import { useEffect, useMemo, useState } from 'react';
import { Text } from '@particle-academy/react-fancy';
import { api, hasGenieBridge, type InstalledAppView } from '../lib/genie';

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
 */
export default function GAppWindow() {
    const [app, setApp] = useState<InstalledAppView | null>(null);
    const [tabs, setTabs] = useState<{ kind: 'agent' | 'app'; title: string }[]>([]);
    const [active, setActive] = useState(0);
    const [error, setError] = useState<string | null>(null);

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
            })
            .catch((e: Error) => setError(e.message));
    }, []);

    // Telling main which tab is showing is what moves the embedded view. Done as an
    // effect rather than in the click handler so the window is correct after a
    // reload too, not only after a click.
    useEffect(() => {
        if (!hasGenieBridge() || tabs.length === 0) return;
        void api().gapp.showTab(active).catch(() => {});
    }, [active, tabs.length]);

    const agentPanels = useMemo(() => app?.permissions.length ?? 0, [app]);

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
                {tabs.map((tab, i) => (
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
                {app && (
                    <span
                        style={{
                            alignSelf: 'center',
                            fontSize: 11,
                            color: 'var(--fg-3, #9aa0aa)',
                            paddingRight: 4,
                        }}
                    >
                        {app.devMode ? 'development · ' : ''}
                        {app.slug}.gen
                    </span>
                )}
            </nav>

            {/* The AGENT tab. Genie's own panel management — terminals and files,
                exactly as a workspace has them. Every other tab is an embedded view
                the MAIN process positions in this space, so this element is left
                empty for them rather than rendering anything of the app's. */}
            <div style={{ flex: 1, minHeight: 0 }}>
                {active === 0 && (
                    <section data-testid="gapp-agent-panel" style={{ height: '100%', padding: 16 }}>
                        <Text size="sm">
                            {app
                                ? `${app.name} — ${agentPanels} permission${agentPanels === 1 ? '' : 's'} granted`
                                : 'Loading…'}
                        </Text>
                        <Text size="xs" className="text-zinc-500">
                            Terminals and files for this app’s workspace.
                        </Text>
                    </section>
                )}
            </div>
        </div>
    );
}
