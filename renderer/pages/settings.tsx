import React, { useEffect, useState } from 'react';
import {
    Action,
    Card,
    Heading,
    Icon,
    Input,
    Select,
    Text,
} from '@particle-academy/react-fancy';
import {
    api,
    type EditorDetection,
    type Settings,
    type ShellDetection,
    type UpdaterConfig,
    type UpdaterStatus,
} from '../lib/genie';

export default function SettingsPage() {
    const [s, setS] = useState<Settings | null>(null);
    const [editors, setEditors] = useState<EditorDetection[]>([]);
    const [shells, setShells] = useState<ShellDetection[]>([]);
    const [shellDefault, setShellDefault] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const [savedAt, setSavedAt] = useState<number | null>(null);

    useEffect(() => {
        (async () => {
            const cur = await api().settings.get();
            setS(cur);
            const eds = await api().settings.detectEditors();
            setEditors(eds);
            if (!cur.default_editor_cmd && eds[0]) {
                setS({
                    ...cur,
                    default_editor: eds[0].id,
                    default_editor_cmd: eds[0].path,
                });
            }
            const det = await api().settings.detectShells().catch(() => ({
                shells: [] as ShellDetection[],
                defaultId: null,
            }));
            setShells(det.shells);
            setShellDefault(det.defaultId);
        })();
    }, []);

    const patch = (p: Partial<Settings>) => setS((cur) => (cur ? { ...cur, ...p } : cur));

    const save = async () => {
        if (!s) return;
        setSaving(true);
        try {
            await api().settings.set(s);
            setSavedAt(Date.now());
            setTimeout(() => setSavedAt(null), 1800);
        } finally {
            setSaving(false);
        }
    };

    const pickPrimary = async () => {
        const p = await api().settings.chooseFolder('Choose primary workspace folder');
        if (p) patch({ primary_workspace: p });
    };
    const pickEditor = async () => {
        const p = await api().settings.chooseFile('Choose editor executable');
        if (p) patch({ default_editor: 'custom', default_editor_cmd: p });
    };

    if (!s) return <div className="surface" style={{ padding: 24 }}>Loading…</div>;

    return (
        <div className="surface" style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>
            <Heading as="h1" size="lg">
                <Icon name="settings" size="md" className="text-zinc-500" /> Settings
            </Heading>

            <Card style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
                <Heading as="h2" size="sm">Primary workspace</Heading>
                <Text size="xs" className="text-zinc-500">
                    Default destination for NEW projects created from Genie. Existing
                    projects can live anywhere — this is a default, not a constraint.
                </Text>
                <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
                    <div style={{ flex: 1 }}>
                        <Input
                            readOnly
                            value={s.primary_workspace ?? ''}
                            placeholder="No primary workspace chosen"
                        />
                    </div>
                    <Action variant="ghost" icon="folder" onClick={pickPrimary}>
                        Browse
                    </Action>
                </div>
            </Card>

            <Card style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
                <Heading as="h2" size="sm">Default editor</Heading>
                <Select
                    value={s.default_editor ?? ''}
                    onValueChange={(v) => {
                        const ed = editors.find((e) => e.id === v);
                        patch({ default_editor: v, default_editor_cmd: ed?.path ?? s.default_editor_cmd });
                    }}
                    list={[
                        ...editors.map((e) => ({ value: e.id, label: e.label })),
                        { value: 'custom', label: 'Custom executable' },
                    ]}
                />
                <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
                    <div style={{ flex: 1 }}>
                        <Input
                            value={s.default_editor_cmd ?? ''}
                            onValueChange={(v) => patch({ default_editor_cmd: v })}
                            placeholder="cursor / code / path/to/binary"
                        />
                    </div>
                    <Action variant="ghost" icon="folder" onClick={pickEditor}>
                        Browse
                    </Action>
                </div>
            </Card>

            <Card style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
                <Heading as="h2" size="sm">Default terminal</Heading>
                <Text size="xs" className="text-zinc-500">
                    Shell used when a terminal panel doesn't specify one. Detected
                    on this machine{shellDefault
                        ? ` — ${shells.find((d) => d.id === shellDefault)?.label ?? shellDefault} is the recommended default`
                        : ''}. Each panel can still switch shells from its toolbar.
                </Text>
                <Select
                    value={s.terminal_shell || shellDefault || ''}
                    onValueChange={(v) => patch({ terminal_shell: v })}
                    list={[
                        ...shells.map((d) => ({
                            value: d.id,
                            label:
                                d.id === shellDefault
                                    ? `${d.label} (recommended)`
                                    : d.label,
                        })),
                        { value: 'custom', label: 'Custom executable' },
                    ]}
                />
                {(s.terminal_shell === 'custom' || shells.length === 0) && (
                    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
                        <div style={{ flex: 1 }}>
                            <Input
                                label="Executable line"
                                description='Full command line; quote paths with spaces, e.g. "C:\Program Files\Git\bin\bash.exe" --login -i'
                                value={s.terminal_custom_cmd ?? ''}
                                onValueChange={(v) => patch({ terminal_custom_cmd: v })}
                                placeholder="pwsh -NoLogo"
                            />
                        </div>
                        <Action
                            variant="ghost"
                            icon="folder"
                            onClick={async () => {
                                const p = await api().settings.chooseFile(
                                    'Choose shell executable',
                                );
                                if (p) {
                                    patch({
                                        terminal_shell: 'custom',
                                        terminal_custom_cmd: p.includes(' ') ? `"${p}"` : p,
                                    });
                                }
                            }}
                        >
                            Browse
                        </Action>
                    </div>
                )}
            </Card>

            <Card style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
                <Heading as="h2" size="sm">Defaults for new workspaces</Heading>
                <Input
                    label="Start command"
                    value={s.default_start_cmd ?? ''}
                    onValueChange={(v) => patch({ default_start_cmd: v })}
                />
                <Input
                    label="Env file name"
                    value={s.default_env_file ?? ''}
                    onValueChange={(v) => patch({ default_env_file: v })}
                />
            </Card>

            <Card style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
                <Heading as="h2" size="sm">Quick capture hotkey</Heading>
                <Input
                    label="Accelerator"
                    description="Electron accelerator string, e.g. CommandOrControl+Shift+W"
                    value={s.global_hotkey ?? ''}
                    onValueChange={(v) => patch({ global_hotkey: v })}
                />
            </Card>

            <TynnSection
                hostOverride={s.tynn_host ?? ''}
                onHostOverrideChange={(v) => patch({ tynn_host: v })}
            />

            <GitHubSection />

            <UpdaterSection />

            <StartupSection />

            <AionimaSection />

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                {savedAt && (
                    <Text size="xs" style={{ color: 'var(--emerald-500)' }}>
                        <Icon name="check" size="xs" /> Saved
                    </Text>
                )}
                <Action color="blue" icon="check" onClick={save} disabled={saving}>
                    {saving ? 'Saving…' : 'Save'}
                </Action>
            </div>
        </div>
    );
}

/**
 * Tynn connection — surfaces login state ("Connected as X") and
 * routes sign-in / sign-out through the standard browser handoff.
 * The host is auto-selected per environment (tynn.test in dev,
 * tynn.ai in production) and can be overridden via Advanced for
 * self-hosters / staging. Replaces the bare "Tynn host" Input that
 * used to live in the main settings list.
 */
function TynnSection({
    hostOverride,
    onHostOverrideChange,
}: {
    hostOverride: string;
    onHostOverrideChange: (v: string) => void;
}) {
    const [user, setUser] = useState<{ name: string; email?: string } | null>(null);
    const [host, setHost] = useState<string>('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [showAdvanced, setShowAdvanced] = useState(false);

    const refresh = async () => {
        try {
            const u = await api().auth.whoami('tynn');
            const single = (u && 'name' in (u as object))
                ? (u as { name: string; email?: string })
                : null;
            setUser(single);
            setHost(await api().tynnHost.get());
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        }
    };

    useEffect(() => {
        void refresh();
        // Listen for the auth:changed event the main process broadcasts
        // after the genie:// callback drops a session cookie.
        const off = api().on.authChanged?.(() => {
            void refresh();
        });
        return () => off?.();
    }, []);

    const signIn = async () => {
        setBusy(true);
        setError(null);
        try {
            const r = await api().auth.startSignIn('tynn');
            if (!r.ok) setError(r.message ?? 'Sign-in could not be started.');
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
        }
    };

    const signOut = async () => {
        setBusy(true);
        try {
            await api().auth.signOut('tynn');
            await refresh();
        } finally {
            setBusy(false);
        }
    };

    // Pretty-print the host: chop the protocol so the chip reads
    // "tynn.ai" instead of "https://tynn.ai".
    const hostLabel = host.replace(/^https?:\/\//, '');

    return (
        <Card style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Heading as="h2" size="sm" style={{ margin: 0 }}>
                    Tynn
                </Heading>
                <Text size="xs" className="text-zinc-500">
                    Project management · browser sign-in via {hostLabel || 'tynn.ai'}
                </Text>
                <span style={{ flex: 1 }} />
                {user && (
                    <Text size="xs" style={{ color: 'var(--emerald-600)' }}>
                        <Icon name="check" size="xs" /> Connected as {user.name}
                    </Text>
                )}
            </div>

            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                {!user && (
                    <Action color="blue" size="sm" onClick={signIn} disabled={busy}>
                        {busy ? 'Opening…' : `Sign in at ${hostLabel || 'tynn.ai'}…`}
                    </Action>
                )}
                {user && (
                    <Action variant="ghost" size="sm" onClick={signOut} disabled={busy}>
                        Sign out
                    </Action>
                )}
                <span style={{ flex: 1 }} />
                <Action
                    variant="ghost"
                    size="sm"
                    onClick={() => setShowAdvanced((s) => !s)}
                >
                    {showAdvanced ? 'Hide Advanced' : 'Advanced'}
                </Action>
            </div>

            {error && (
                <Text size="xs" style={{ color: 'var(--rose-500)' }}>
                    {error}
                </Text>
            )}

            {showAdvanced && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 8, borderTop: '1px solid var(--border-1)' }}>
                    <Input
                        label="Tynn host override"
                        description="Leave blank to use the environment default (tynn.test in dev, tynn.ai when installed). Set this only for self-hosted Tynn or a staging instance — e.g. https://tynn-staging.example.com."
                        value={hostOverride}
                        onValueChange={onHostOverrideChange}
                        placeholder={host || 'https://tynn.ai'}
                    />
                </div>
            )}
        </Card>
    );
}

/**
 * Aionima connection — separate save flow because it probes the
 * configured host immediately so the user gets a "Connected as X" or
 * "Failed to reach" signal without leaving the page. Bearer-token paste
 * is the placeholder UX; a proper pairing flow lands when
 * https://github.com/Civicognita/agi/issues/178 Q5.2a is answered.
 */
function AionimaSection() {
    const [host, setHost] = useState('');
    const [token, setToken] = useState('');
    const [user, setUser] = useState<{ name: string; email?: string } | null>(null);
    const [busy, setBusy] = useState(false);
    const [status, setStatus] = useState<string | null>(null);

    useEffect(() => {
        api()
            .aionima.getConfig()
            .then((c) => {
                setHost(c.host ?? '');
                setToken(c.token ?? '');
            });
        api()
            .auth.whoami('aionima')
            .then((u) => setUser((u as any) ?? null));
    }, []);

    const save = async () => {
        setBusy(true);
        setStatus(null);
        try {
            const res = await api().aionima.setConfig({
                host: host.trim() || undefined,
                token: token.trim() || null,
            });
            setUser(res.user as any);
            setStatus(
                res.user
                    ? `Connected as ${res.user.name}`
                    : 'Saved — could not reach Aionima with that host + token.',
            );
        } catch (e: unknown) {
            setStatus(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
        }
    };

    const disconnect = async () => {
        setBusy(true);
        await api().aionima.setConfig({ token: null });
        setToken('');
        setUser(null);
        setStatus('Disconnected.');
        setBusy(false);
    };

    return (
        <Card style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Heading as="h2" size="sm" style={{ margin: 0 }}>
                    Aionima
                </Heading>
                <Text size="xs" className="text-zinc-500">
                    Local LAN AGI gateway
                </Text>
                <span style={{ flex: 1 }} />
                {user && (
                    <Text size="xs" style={{ color: 'var(--emerald-600)' }}>
                        <Icon name="check" size="xs" /> Connected as {user.name}
                    </Text>
                )}
            </div>
            <Input
                label="Aionima host"
                description="e.g. http://192.168.0.144:3100 (the machine running AGI)"
                value={host}
                onValueChange={setHost}
                placeholder="http://192.168.0.144:3100"
            />
            <Input
                label="Bearer token"
                description="Mint a token in your Aionima dashboard and paste it here."
                value={token}
                onValueChange={setToken}
                placeholder="(paste token)"
            />
            <div style={{ display: 'flex', gap: 8 }}>
                <Action color="blue" icon="check" onClick={save} disabled={busy}>
                    {busy ? 'Saving…' : 'Save + test'}
                </Action>
                {user && (
                    <Action variant="ghost" onClick={disconnect} disabled={busy}>
                        Disconnect
                    </Action>
                )}
                {status && (
                    <Text
                        size="xs"
                        style={{
                            alignSelf: 'center',
                            color: user ? 'var(--emerald-600)' : 'var(--fg-3)',
                        }}
                    >
                        {status}
                    </Text>
                )}
            </div>
        </Card>
    );
}

/**
 * GitHub connection — Device Flow OAuth so we don't need to ship a
 * client secret or run an embedded browser. The user registers an
 * OAuth App at https://github.com/settings/applications/new with
 * Device Flow enabled and pastes the client ID here.
 *
 * Connect: click Connect → modal shows the user_code + the URL to
 * visit. While the modal is open, we poll the main-side status until
 * GitHub returns a token (success) or the code expires.
 */
function GitHubSection() {
    const [connected, setConnected] = useState(false);
    const [username, setUsername] = useState<string | null>(null);
    const [clientId, setClientId] = useState('');
    const [clientIdSet, setClientIdSet] = useState(false);
    const [builtInClientId, setBuiltInClientId] = useState(false);
    const [usingOverride, setUsingOverride] = useState(false);
    const [activeClientId, setActiveClientId] = useState('');
    const [showAdvanced, setShowAdvanced] = useState(false);
    const [storageOk, setStorageOk] = useState(true);
    const [flow, setFlow] = useState<
        | { kind: 'idle' }
        | { kind: 'starting' }
        | {
              kind: 'pending';
              userCode: string;
              verificationUri: string;
              expiresInSec: number;
          }
        | { kind: 'success'; user: { login: string; name: string | null } }
        | { kind: 'error'; code: string; message: string }
    >({ kind: 'idle' });

    const refresh = async () => {
        const st = await api().github.status();
        setConnected(st.connected);
        setUsername(st.username);
        setClientIdSet(st.clientIdSet);
        setBuiltInClientId(st.builtInClientId);
        setUsingOverride(st.usingOverride);
        setActiveClientId(st.activeClientId);
        setStorageOk(st.storageOk);
        if (st.flow.kind === 'pending') {
            setFlow({
                kind: 'pending',
                userCode: st.flow.userCode,
                verificationUri: st.flow.verificationUri,
                expiresInSec: st.flow.expiresInSec,
            });
        } else if (st.flow.kind === 'success') {
            setFlow({ kind: 'success', user: st.flow.user });
            // Auto-close the success state after a brief moment.
            setTimeout(() => setFlow({ kind: 'idle' }), 1200);
        } else if (st.flow.kind === 'error') {
            setFlow({ kind: 'error', code: st.flow.code, message: st.flow.message });
        }
    };

    useEffect(() => {
        void refresh();
        const ssn = api()
            .settings.get()
            .then((s) => setClientId((s as { github_client_id?: string }).github_client_id ?? ''));
        void ssn;
    }, []);

    // Poll for flow progress while it's running.
    useEffect(() => {
        if (flow.kind !== 'pending' && flow.kind !== 'starting') return;
        const t = setInterval(refresh, 1500);
        return () => clearInterval(t);
    }, [flow.kind]);

    const start = async () => {
        try {
            setFlow({ kind: 'starting' });
            const code = await api().github.startDevice();
            setFlow({
                kind: 'pending',
                userCode: code.user_code,
                verificationUri: code.verification_uri,
                expiresInSec: code.expires_in,
            });
        } catch (e) {
            setFlow({
                kind: 'error',
                code: 'start_failed',
                message: e instanceof Error ? e.message : String(e),
            });
        }
    };

    const cancel = async () => {
        await api().github.cancelDevice();
        setFlow({ kind: 'idle' });
    };

    const disconnect = async () => {
        await api().github.disconnect();
        await refresh();
    };

    const saveClientId = async () => {
        await api().settings.set({
            // The settings table stores k/v; the type signature doesn't include
            // github_client_id explicitly so we widen via Record.
            github_client_id: clientId.trim(),
        } as unknown as Record<string, string>);
        await refresh();
    };

    const resetClientId = async () => {
        await api().github.resetClientId();
        setClientId('');
        await refresh();
    };

    return (
        <Card style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Heading as="h2" size="sm" style={{ margin: 0 }}>
                    GitHub
                </Heading>
                <Text size="xs" className="text-zinc-500">
                    Device Flow auth · used to create .agi repos
                </Text>
                <span style={{ flex: 1 }} />
                {connected && username && (
                    <Text size="xs" style={{ color: 'var(--emerald-600)' }}>
                        <Icon name="check" size="xs" /> Connected as {username}
                    </Text>
                )}
            </div>

            {!storageOk && (
                <Text size="xs" style={{ color: 'var(--rose-500)' }}>
                    OS keychain unavailable. Genie won't store a GitHub token
                    unencrypted. On Linux: install gnome-keyring / libsecret.
                </Text>
            )}

            {!builtInClientId && !showAdvanced && (
                <Text size="xs" style={{ color: 'var(--rose-500)' }}>
                    This Genie build doesn't ship a baked-in OAuth Client ID.
                    Open Advanced to paste one (you'll need to register your own
                    OAuth App at github.com/settings/applications/new with
                    Enable Device Flow ticked).
                </Text>
            )}

            {/* Stale-override guard. A custom client ID shadowing the bundled
                one is the most common reason Device Flow fails on a build
                that ships a working baked-in ID (early alphas prompted users
                to paste their own). Surface it with a one-click reset. */}
            {usingOverride && builtInClientId && !connected && (
                <div
                    style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        padding: '8px 10px',
                        borderRadius: 8,
                        background: 'color-mix(in srgb, #f59e0b 12%, transparent)',
                        border: '1px solid color-mix(in srgb, #f59e0b 35%, var(--border-1))',
                    }}
                >
                    <Text size="xs" style={{ flex: 1 }}>
                        Using a custom OAuth Client ID (<code>{activeClientId}</code>)
                        instead of the one bundled with Genie. If sign-in fails,
                        this is the likely cause.
                    </Text>
                    <Action size="sm" variant="ghost" onClick={resetClientId}>
                        Use bundled default
                    </Action>
                </div>
            )}

            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                {!connected && (
                    <Action
                        color="blue"
                        size="sm"
                        onClick={start}
                        disabled={!clientIdSet || flow.kind === 'pending' || flow.kind === 'starting' || !storageOk}
                    >
                        Connect GitHub…
                    </Action>
                )}
                {connected && (
                    <Action variant="ghost" size="sm" onClick={disconnect}>
                        Disconnect
                    </Action>
                )}
                <span style={{ flex: 1 }} />
                <Action
                    variant="ghost"
                    size="sm"
                    onClick={() => setShowAdvanced((s) => !s)}
                >
                    {showAdvanced ? 'Hide Advanced' : 'Advanced'}
                </Action>
            </div>

            {showAdvanced && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 8, borderTop: '1px solid var(--border-1)' }}>
                    <Input
                        label="OAuth App client ID override"
                        description={
                            builtInClientId
                                ? 'This Genie build ships with a baked-in OAuth Client ID. Use this field only if you want to point Genie at a different OAuth App (self-hosters, devs testing forks). Leave blank to use the bundle default. The Client ID is public, not a secret. Required scopes: repo, workflow, read:org.'
                                : 'Register an OAuth App at github.com/settings/applications/new with Enable Device Flow ticked, then paste its Client ID here. The Client ID is public, not a secret. Required scopes: repo, workflow, read:org.'
                        }
                        value={clientId}
                        onValueChange={setClientId}
                        placeholder="e.g. Iv1.a1b2c3d4e5f6g7h8"
                    />
                    <div>
                        <Action color="blue" size="sm" onClick={saveClientId}>
                            Save client ID
                        </Action>
                    </div>
                </div>
            )}

            {(flow.kind === 'pending' || flow.kind === 'starting') && (
                <DeviceFlowPanel
                    flow={flow}
                    onCancel={cancel}
                />
            )}

            {flow.kind === 'error' && (
                <Text size="xs" style={{ color: 'var(--rose-500)' }}>
                    {flow.message}
                </Text>
            )}
        </Card>
    );
}

function DeviceFlowPanel({
    flow,
    onCancel,
}: {
    flow:
        | { kind: 'starting' }
        | {
              kind: 'pending';
              userCode: string;
              verificationUri: string;
              expiresInSec: number;
          };
    onCancel: () => void;
}) {
    const open = () => {
        if (flow.kind !== 'pending') return;
        api().tynn.openInBrowser(flow.verificationUri);
    };
    return (
        <div
            style={{
                padding: 12,
                borderRadius: 8,
                background: 'var(--bg-2)',
                border: '1px solid var(--border-1)',
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
            }}
        >
            <Text size="xs" className="text-zinc-500">
                {flow.kind === 'starting'
                    ? 'Requesting a device code…'
                    : '1. Open GitHub and paste the code below. 2. Wait — Genie will catch the token automatically.'}
            </Text>
            {flow.kind === 'pending' && (
                <>
                    <button
                        type="button"
                        title="Click to copy"
                        onClick={() => {
                            navigator.clipboard
                                .writeText(flow.userCode)
                                .catch(() => {});
                        }}
                        style={{
                            fontFamily: 'var(--font-mono)',
                            fontSize: 22,
                            fontWeight: 600,
                            letterSpacing: '0.1em',
                            background: 'var(--card)',
                            border: '1px solid var(--border-1)',
                            borderRadius: 8,
                            padding: '10px 14px',
                            textAlign: 'center',
                            cursor: 'pointer',
                            color: 'var(--fg-1)',
                            width: '100%',
                        }}
                    >
                        {flow.userCode}
                    </button>
                    <div style={{ display: 'flex', gap: 8 }}>
                        <Action color="blue" size="sm" onClick={open}>
                            Open {flow.verificationUri}
                        </Action>
                        <Action variant="ghost" size="sm" onClick={onCancel}>
                            Cancel
                        </Action>
                    </div>
                </>
            )}
        </div>
    );
}

/**
 * Phase 1 git-pull updater UI. Shows current vs latest, an inline log
 * during apply, and a non-blocking Restart-when-ready prompt when the
 * rebuild finishes. Auto-poll cadence is user-configurable; 0 = manual.
 */
function UpdaterSection() {
    const [config, setConfig] = useState<UpdaterConfig>({ repo: '', pollHours: 6 });
    const [status, setStatus] = useState<UpdaterStatus | null>(null);
    const [mode, setMode] = useState<'phase1' | 'phase2' | null>(null);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        void (async () => {
            const [m, c, s] = await Promise.all([
                api().updater.mode(),
                api().updater.getConfig(),
                api().updater.status(),
            ]);
            setMode(m);
            setConfig(c);
            setStatus(s);
        })();
        const off = api().on.updaterStatus((s) => setStatus(s));
        return () => off();
    }, []);

    const check = async () => {
        setBusy(true);
        try {
            const next = await api().updater.check();
            setStatus(next);
        } finally {
            setBusy(false);
        }
    };
    const apply = async () => {
        setBusy(true);
        try {
            await api().updater.apply();
        } finally {
            setBusy(false);
        }
    };
    const saveConfig = async () => {
        const next = await api().updater.setConfig(config);
        setConfig(next);
    };

    const stateLabel: Record<string, string> = {
        idle: 'Idle',
        checking: 'Checking…',
        available: `Update available`,
        'up-to-date': 'Up to date',
        applying: 'Applying update…',
        downloading: 'Downloading installer…',
        'ready-to-restart': 'Ready — restart to load',
        error: 'Error',
        disabled: 'Disabled',
    };
    const restart = async () => {
        if (mode === 'phase2') {
            await api().updater.restart();
        } else {
            await api().app.quit();
        }
    };

    return (
        <Card style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Heading as="h2" size="sm" style={{ margin: 0 }}>
                    Updates
                </Heading>
                <Text size="xs" className="text-zinc-500">
                    {mode === 'phase2'
                        ? 'Signed installer (auto-update)'
                        : 'git-pull + rebuild (dev)'}
                </Text>
                <span style={{ flex: 1 }} />
                <Text size="xs" className="text-zinc-500">
                    {status ? stateLabel[status.state] ?? status.state : '—'}
                </Text>
            </div>

            {mode === 'phase1' && (
                <>
                    <Input
                        label="Source repository"
                        description={'GitHub owner/repo. Default is renaissance-analytics/genie; change only if you’re tracking a fork. Empty disables the updater.'}
                        value={config.repo}
                        onValueChange={(v) => setConfig((c) => ({ ...c, repo: v }))}
                        placeholder="renaissance-analytics/genie"
                    />
                    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
                        <div style={{ flex: 1 }}>
                            <Input
                                label="Poll every (hours)"
                                description="0 disables automatic polling."
                                value={String(config.pollHours)}
                                onValueChange={(v) =>
                                    setConfig((c) => ({
                                        ...c,
                                        pollHours: Number(v) || 0,
                                    }))
                                }
                                placeholder="6"
                            />
                        </div>
                        <Action color="blue" size="sm" onClick={saveConfig}>
                            Save
                        </Action>
                    </div>
                </>
            )}

            {mode === 'phase2' && (
                <Text size="xs" className="text-zinc-500" style={{ display: 'block' }}>
                    Updates are downloaded from{' '}
                    <a
                        href="#"
                        onClick={(e) => {
                            e.preventDefault();
                            void api().tynn.openInBrowser(
                                'https://github.com/Renaissance-Analytics/genie/releases',
                            );
                        }}
                        style={{ color: 'var(--blue-400)' }}
                    >
                        the canonical Genie releases page
                    </a>
                    . Installer is checksum-verified before applying.
                </Text>
            )}

            <div
                style={{
                    padding: 12,
                    borderRadius: 8,
                    border: '1px solid var(--border-1)',
                    background: 'var(--bg-2)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 6,
                }}
            >
                <div style={{ display: 'flex', gap: 16, alignItems: 'baseline' }}>
                    <Text size="xs" className="text-zinc-500">
                        Current
                    </Text>
                    <Text size="sm" style={{ fontWeight: 600, fontFamily: 'var(--font-mono)' }}>
                        v{status?.currentVersion ?? '0.0.0'}
                    </Text>
                    <Text size="xs" className="text-zinc-500" style={{ marginLeft: 16 }}>
                        Latest
                    </Text>
                    <Text size="sm" style={{ fontWeight: 600, fontFamily: 'var(--font-mono)' }}>
                        {status?.latestVersion ? `v${status.latestVersion}` : '—'}
                    </Text>
                </div>
                {status?.publishedAt && (
                    <Text size="xs" className="text-zinc-500">
                        Published {new Date(status.publishedAt).toLocaleString()}
                    </Text>
                )}
                <div style={{ display: 'flex', gap: 8, marginTop: 6, alignItems: 'center' }}>
                    <Action
                        size="sm"
                        variant="ghost"
                        onClick={check}
                        disabled={
                            busy ||
                            (mode === 'phase1' && !config.repo) ||
                            status?.state === 'applying' ||
                            status?.state === 'downloading'
                        }
                    >
                        Check for updates
                    </Action>
                    {status?.state === 'available' && (
                        <Action color="blue" size="sm" onClick={apply} disabled={busy}>
                            {mode === 'phase2'
                                ? `Download v${status.latestVersion}`
                                : `Update now (v${status.latestVersion})`}
                        </Action>
                    )}
                    {status?.state === 'ready-to-restart' && (
                        <Action color="blue" size="sm" onClick={restart}>
                            Restart Genie now
                        </Action>
                    )}
                    {status?.state === 'downloading' && status.progress != null && (
                        <Text size="xs" className="text-zinc-500">
                            {Math.round(status.progress * 100)}%
                        </Text>
                    )}
                </div>
                {status?.error && (
                    <Text size="xs" style={{ color: 'var(--rose-500)' }}>
                        {status.error}
                    </Text>
                )}
            </div>

            {status &&
                (status.state === 'applying' ||
                    status.state === 'downloading' ||
                    status.state === 'ready-to-restart' ||
                    status.state === 'error') &&
                status.log.length > 0 && (
                    <UpdaterLogPanel log={status.log} />
                )}
        </Card>
    );
}

/**
 * Settings → Startup. Single toggle: "Launch Genie when I sign in."
 *
 *   - Reads + writes via the `app.autostart` IPC, which forwards to
 *     Electron's `setLoginItemSettings` on macOS / Windows and a
 *     `~/.config/autostart/genie.desktop` file on Linux.
 *   - On dev (non-packaged) builds, the toggle is shown but disabled —
 *     writing an autostart entry that points at a one-time dev path
 *     would just rot once the dev session ends.
 *   - Autostart launches Genie with `openAsHidden: true`, so Genie
 *     boots into the tray quietly. The master window only appears
 *     when the user clicks the tray icon — no surprise pop-ups on
 *     every login.
 */
function StartupSection() {
    const [enabled, setEnabled] = useState(false);
    const [supported, setSupported] = useState(true);
    const [platform, setPlatform] = useState<string>('');
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        api()
            .app.autostart.get()
            .then((s) => {
                setEnabled(s.enabled);
                setSupported(s.supported);
                setPlatform(s.platform);
            })
            .catch(() => { /* tolerant of older preload shapes */ });
    }, []);

    async function toggle(next: boolean) {
        setBusy(true);
        try {
            const r = await api().app.autostart.set(next);
            setEnabled(r.enabled);
        } finally {
            setBusy(false);
        }
    }

    const platformLabel =
        platform === 'darwin'
            ? 'macOS login items'
            : platform === 'win32'
                ? 'Windows Run-at-startup registry entry'
                : platform === 'linux'
                    ? '~/.config/autostart/genie.desktop'
                    : 'OS login items';

    return (
        <Card style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <Heading as="h2" size="sm">Startup</Heading>
            <Text size="sm" style={{ color: 'var(--fg-2)' }}>
                When enabled, Genie starts hidden in the tray every time you
                sign in. Click the tray icon to open the workspace window.
                Backed by {platformLabel}.
            </Text>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <Action
                    color={enabled ? 'blue' : undefined}
                    icon={enabled ? 'check' : 'circle'}
                    onClick={() => toggle(!enabled)}
                    disabled={busy || !supported}
                >
                    {enabled ? 'Launch at sign-in: on' : 'Launch at sign-in: off'}
                </Action>
                {!supported && (
                    <Text size="xs" style={{ color: 'var(--fg-3)' }}>
                        Dev builds can't register a stable autostart path.
                        Install the packaged release to use this.
                    </Text>
                )}
            </div>
        </Card>
    );
}

function UpdaterLogPanel({ log }: { log: string[] }) {
    const ref = React.useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
    }, [log.length]);
    return (
        <div
            ref={ref}
            style={{
                maxHeight: 240,
                overflowY: 'auto',
                padding: 10,
                borderRadius: 8,
                background: '#0b0b0f',
                color: '#d4d4d8',
                fontFamily: 'var(--font-mono)',
                fontSize: 11.5,
                lineHeight: 1.5,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
            }}
        >
            {log.join('\n')}
        </div>
    );
}
