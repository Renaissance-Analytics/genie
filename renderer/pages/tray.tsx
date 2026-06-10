import { useEffect, useState } from 'react';
import Header from '../components/Header';
import SignInPrompt from '../components/SignInPrompt';
import WorkspaceList from '../components/WorkspaceList';
import AddWorkspaceModal from '../components/AddWorkspaceModal';
import { api, hasGenieBridge, type BackendUser, type WorkspaceRow } from '../lib/genie';

/**
 * Two-stage mount: wait for the preload bridge before any IPC, then
 * render the real tray UI. Without the gate, a first-render api() call
 * throws before our error boundary mounts and the user sees blank.
 *
 * NOTE: bridgeReady starts as `false` on both server and client to avoid
 * a Next.js hydration mismatch (window.genie exists at first client
 * render but doesn't on the SSG-rendered HTML, so a lazy useState
 * initializer would diverge). The useEffect flips it on after mount.
 */
export default function TrayPage() {
    const [bridgeReady, setBridgeReady] = useState(false);
    const [elapsed, setElapsed] = useState(0);

    useEffect(() => {
        if (hasGenieBridge()) {
            setBridgeReady(true);
            return;
        }
        let cancel = false;
        const start = performance.now();
        const t = setInterval(() => {
            if (cancel) return;
            if (hasGenieBridge()) {
                setBridgeReady(true);
                clearInterval(t);
                return;
            }
            setElapsed(Math.floor((performance.now() - start) / 1000));
        }, 200);
        return () => {
            cancel = true;
            clearInterval(t);
        };
    }, []);

    if (!bridgeReady) {
        return <PreloadWaitingScreen elapsed={elapsed} />;
    }

    return <TrayInner />;
}

function PreloadWaitingScreen({ elapsed }: { elapsed: number }) {
    const stalled = elapsed >= 4;
    const reallyStalled = elapsed >= 10;

    // `mounted` is false on the server / first client render and flips to
    // true after the effect runs. Without this guard, the diagnostic line
    // below renders `window.genie = false` on the SSG'd HTML and
    // `window.genie = true|false` after hydration, which trips React's
    // hydration mismatch warning even though the runtime value is correct.
    const [mounted, setMounted] = useState(false);
    useEffect(() => setMounted(true), []);
    const hasBridge =
        mounted && typeof window !== 'undefined' && !!window.genie;

    return (
        <div className="surface flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center">
            <div className="text-base font-semibold">
                {stalled ? 'Preload bridge isn’t attaching' : 'Waiting for preload…'}
            </div>
            <div
                className="max-w-md text-xs leading-relaxed"
                style={{ color: 'var(--fg-3)' }}
            >
                {!stalled && (
                    <>The Electron preload bridge will be ready in a moment.</>
                )}
                {stalled && !reallyStalled && (
                    <>
                        The preload script didn’t attach <code>window.genie</code>{' '}
                        within {elapsed}s. Reloading the renderer can’t fix this
                        on its own — Electron reuses the same compiled preload
                        bundle on a renderer reload. Quit Genie from the tray
                        icon and start it again so the main process re-spawns.
                    </>
                )}
                {reallyStalled && (
                    <>
                        Still no bridge after {elapsed}s. The preload bundle
                        probably failed to compile (or crashed during execution).
                        <ol className="mt-2 inline-block text-left">
                            <li>1. Right-click the Genie tray icon → <strong>Quit</strong>.</li>
                            <li>2. Check the terminal running <code>npm run dev</code> for build errors.</li>
                            <li>3. Start Genie again (<code>npm run dev</code> if you stopped it).</li>
                        </ol>
                    </>
                )}
            </div>
            {stalled && (
                <div className="flex gap-2">
                    <button
                        type="button"
                        onClick={() => {
                            // Cache-busted reload — survives some Electron+Next dev
                            // states where a plain reload would replay the same
                            // broken HTML+script chunks from cache.
                            const url = new URL(window.location.href);
                            url.searchParams.set('_ts', String(Date.now()));
                            window.location.replace(url.toString());
                        }}
                        className="rounded-md bg-blue-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-600"
                    >
                        Reload window
                    </button>
                </div>
            )}
            <div
                className="font-mono text-[10px]"
                style={{ color: 'var(--fg-4)' }}
                suppressHydrationWarning
            >
                {mounted
                    ? `window.genie = ${String(hasBridge)} · elapsed ${elapsed}s`
                    : ' '}
            </div>
        </div>
    );
}

function TrayInner() {
    const [tynnUser, setTynnUser] = useState<BackendUser | null>(null);
    const [aionimaUser, setAionimaUser] = useState<BackendUser | null>(null);
    const [checking, setChecking] = useState(true);
    const [rows, setRows] = useState<WorkspaceRow[]>([]);
    const [tynnHost, setTynnHost] = useState('https://tynn.ai');
    const [aionimaHost, setAionimaHost] = useState('');
    const [adding, setAdding] = useState(false);

    const anyConnected = !!tynnUser || !!aionimaUser;

    const refresh = async () => {
        const list = await api().workspaces.list();
        setRows(list);
    };

    const refreshAuth = async () => {
        const [t, a] = await Promise.all([
            api().auth.whoami('tynn'),
            api().auth.whoami('aionima'),
        ]);
        setTynnUser(t as BackendUser | null);
        setAionimaUser(a as BackendUser | null);
        return !!t || !!a;
    };

    useEffect(() => {
        (async () => {
            try {
                setTynnHost(await api().tynnHost.get());
                setAionimaHost(await api().aionima.hostInfo());
                const anySignedIn = await refreshAuth();
                if (anySignedIn) await refresh();
            } catch {
                // Empty catch — render will show sign-in prompt regardless.
            } finally {
                setChecking(false);
            }
        })();

        const off = api().on.authChanged(async () => {
            const anySignedIn = await refreshAuth();
            if (anySignedIn) await refresh();
            else setRows([]);
        });
        return () => {
            off();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const openSettings = () => api().app.showSettings().catch(() => {});

    if (checking) {
        return (
            <div
                className="surface"
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    minHeight: '100vh',
                }}
            >
                Loading…
            </div>
        );
    }

    const subtitle = subtitleFor(tynnUser, aionimaUser);

    return (
        <div className="surface">
            <Header
                title="Genie"
                subtitle={subtitle}
                onOpenSettings={openSettings}
            />

            {anyConnected ? (
                <WorkspaceList
                    rows={rows}
                    onOpen={async (id) => {
                        try {
                            await api().workspaces.open(id);
                            await refresh();
                        } catch (e) {
                            alert((e as Error).message);
                        }
                    }}
                    onRemove={async (id) => {
                        await api().workspaces.remove(id);
                        await refresh();
                    }}
                    onAdd={() => setAdding(true)}
                />
            ) : (
                <SignInPrompt
                    tynnHost={tynnHost}
                    aionimaHost={aionimaHost}
                    onSignedIn={async () => {
                        await refreshAuth();
                        await refresh();
                    }}
                />
            )}

            {adding && (
                <AddWorkspaceModal
                    onClose={() => setAdding(false)}
                    onAdded={(row) => {
                        setRows((rs) => [row, ...rs.filter((r) => r.id !== row.id)]);
                    }}
                />
            )}
        </div>
    );
}

function subtitleFor(
    tynn: BackendUser | null,
    aionima: BackendUser | null,
): string {
    if (tynn && aionima) {
        return `Signed in to Tynn (${tynn.name}) + Aionima (${aionima.name})`;
    }
    if (tynn) return `Signed in to Tynn as ${tynn.name}`;
    if (aionima) return `Signed in to Aionima as ${aionima.name}`;
    return 'Tynn + Aionima workspace companion';
}
