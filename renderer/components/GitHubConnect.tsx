import { useEffect, useRef, useState } from 'react';
import { Action, Select, Text } from '@particle-academy/react-fancy';
import { api } from '../lib/genie';

/**
 * Shared GitHub account surface for every .agi creation flow. Two pieces:
 *
 *   useGitHubAccount() — connection state + inline Device Flow driver
 *                        (no bounce to Settings; the wizard connects in
 *                        place and polls github:status to completion).
 *   <GitHubConnect>    — the inline connect panel (button → code → done).
 *   <OwnerSelect>      — owner dropdown (personal + every org), so the
 *                        user always chooses WHICH account a repo or
 *                        fork lands under.
 *
 * Empty owner string === the authenticated user's personal account; any
 * other value is an org login. That's the same convention createRepo /
 * forkRepo use on the main side.
 *
 * Genie authenticates as a GitHub App ("Genie IDE"). The org list here is
 * the set of accounts where the App is INSTALLED (via /user/installations,
 * not /user/orgs — which returns empty for App tokens). An org the user
 * belongs to but hasn't installed Genie on simply won't appear; the
 * OwnerSelect surfaces an "Install Genie on another org…" link for that
 * case so the user can grant access instead of dead-ending.
 */

export interface GitHubOrgLite {
    login: string;
}

/** One account the App is installed on — personal or org — with the numeric
 *  id used to pre-target the install chooser. */
export interface GitHubInstallationLite {
    login: string;
    id: number | null;
    isOrg: boolean;
}

type Flow =
    | { kind: 'idle' }
    | { kind: 'starting' }
    | { kind: 'pending'; userCode: string; verificationUri: string }
    | { kind: 'error'; message: string };

export interface GitHubAccount {
    loaded: boolean;
    connected: boolean;
    username: string | null;
    orgs: GitHubOrgLite[];
    /** Every account the App is installed on (personal + orgs). */
    installations: GitHubInstallationLite[];
    /** True once installations have been fetched at least once after connect. */
    installationsLoaded: boolean;
    /** True when the App is installed NOWHERE — authorized but can't act yet. */
    noInstallations: boolean;
    /** True when the App is installed on the user's personal account. */
    personalInstalled: boolean;
    storageOk: boolean;
    clientIdSet: boolean;
    flow: Flow;
    connect: () => Promise<void>;
    cancel: () => Promise<void>;
    refresh: () => Promise<unknown>;
    /** Open GitHub's install chooser (optionally pre-targeted at an account
     *  id), so the user can pick which accounts/orgs to install Genie on. */
    openInstall: (targetId?: number | null) => Promise<void>;
    /** Disarm the one-shot post-connect auto-open of the install chooser.
     *  Call before a manual openInstall() so the browser isn't double-opened. */
    markInstallSurfaced: () => void;
    /** Returns true when the given owner login is installed (empty = personal). */
    isInstalledFor: (ownerLogin: string) => boolean;
}

export function useGitHubAccount(): GitHubAccount {
    const [loaded, setLoaded] = useState(false);
    const [connected, setConnected] = useState(false);
    const [username, setUsername] = useState<string | null>(null);
    const [orgs, setOrgs] = useState<GitHubOrgLite[]>([]);
    const [installations, setInstallations] = useState<GitHubInstallationLite[]>([]);
    const [installationsLoaded, setInstallationsLoaded] = useState(false);
    const [storageOk, setStorageOk] = useState(true);
    const [clientIdSet, setClientIdSet] = useState(false);
    const [flow, setFlow] = useState<Flow>({ kind: 'idle' });
    const polling = useRef(false);
    // Guards the one-shot post-connect install-chooser bounce so it fires at
    // most once per fresh connect — not on every status refresh (mount, poll
    // tick, window-focus refetch), which would re-spam the browser. Armed
    // (reset to false) by connect(); disarmed at mount for a pre-existing
    // connection and by any manual open via markInstallSurfaced().
    const autoOpenedInstall = useRef(false);

    const refresh = async () => {
        const st = await api().github.status();
        setConnected(st.connected);
        setUsername(st.username);
        setStorageOk(st.storageOk);
        setClientIdSet(st.clientIdSet);
        setLoaded(true);
        if (st.connected) {
            // One installations fetch covers both the org picker AND the
            // "where is Genie installed" detection — orgs are derived from it.
            try {
                const list = await api().github.installations();
                setInstallations(
                    list.map((i) => ({ login: i.login, id: i.id, isOrg: i.isOrg })),
                );
                setOrgs(list.filter((i) => i.isOrg).map((o) => ({ login: o.login })));
            } catch {
                setInstallations([]);
                setOrgs([]);
            } finally {
                setInstallationsLoaded(true);
            }
        } else {
            setInstallations([]);
            setOrgs([]);
            setInstallationsLoaded(false);
        }
        // Reflect the main-side flow outcome into local state.
        if (st.flow.kind === 'success') {
            setFlow({ kind: 'idle' });
        } else if (st.flow.kind === 'error') {
            setFlow({ kind: 'error', message: st.flow.message });
        }
        return st;
    };

    const openInstall = async (targetId?: number | null) => {
        try {
            const url = await api().github.installUrl(targetId);
            await api().tynn.openInBrowser(url);
        } catch {
            // Best-effort; the chooser is a convenience, not load-bearing.
        }
    };

    // Mark the install chooser as already-surfaced so the one-shot auto-open
    // doesn't fire after the user has manually opened it (or after we've
    // bounced them once). Lets the UI route the user without double-opening.
    const markInstallSurfaced = () => {
        autoOpenedInstall.current = true;
    };

    const isInstalledFor = (ownerLogin: string): boolean => {
        if (!ownerLogin) {
            // Personal account: installed when a non-org installation matches
            // the connected username (GitHub lists the personal install too).
            return installations.some(
                (i) => !i.isOrg && (!username || i.login === username),
            );
        }
        return installations.some((i) => i.login === ownerLogin);
    };

    useEffect(() => {
        void (async () => {
            const st = await refresh();
            // A connection that already existed at mount (token from a prior
            // session) must NOT trigger the auto-open bounce — only an explicit
            // connect() this session should. Disarm the one-shot here.
            if (st.connected) autoOpenedInstall.current = true;
        })();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // While a device flow is pending, poll status until it connects (or
    // errors). One poller at a time — guarded by the ref.
    useEffect(() => {
        if (flow.kind !== 'pending' || polling.current) return;
        polling.current = true;
        const t = setInterval(async () => {
            const st = await refresh();
            if (st.connected || st.flow.kind === 'error') {
                clearInterval(t);
                polling.current = false;
                if (st.connected) setFlow({ kind: 'idle' });
            }
        }, 1500);
        return () => {
            clearInterval(t);
            polling.current = false;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [flow.kind]);

    // After authorize completes, GitHub has only handed Genie a USER TOKEN —
    // the App still has to be INSTALLED before it can read/write repos. Bounce
    // the user to the install chooser exactly ONCE per fresh connect so they
    // land on the account/org picker (installations/new) rather than stalling
    // on the authorize screen. Pre-existing connects (token already present at
    // mount) don't trigger this — `connect()` arms it by resetting the guards.
    useEffect(() => {
        if (!connected || !installationsLoaded) return;
        if (autoOpenedInstall.current) return;
        autoOpenedInstall.current = true;
        void openInstall();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [connected, installationsLoaded]);

    // Returning from the install page gives no callback into the app, so
    // re-fetch installations when the window regains focus while connected —
    // that's how a freshly-installed org appears in the dropdown.
    useEffect(() => {
        const onFocus = () => {
            if (connected) void refresh();
        };
        window.addEventListener('focus', onFocus);
        return () => window.removeEventListener('focus', onFocus);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [connected]);

    const connect = async () => {
        try {
            // Arm the one-shot install-chooser bounce for THIS connect: once
            // the token lands and installations load, the effect above opens
            // the account/org picker a single time.
            autoOpenedInstall.current = false;
            setFlow({ kind: 'starting' });
            const code = await api().github.startDevice();
            setFlow({
                kind: 'pending',
                userCode: code.user_code,
                verificationUri: code.verification_uri,
            });
            // Open the verification page immediately so the user only has
            // to paste the (pre-shown) code.
            api().tynn.openInBrowser(code.verification_uri);
        } catch (e) {
            setFlow({
                kind: 'error',
                message: e instanceof Error ? e.message : String(e),
            });
        }
    };

    const cancel = async () => {
        await api().github.cancelDevice().catch(() => {});
        setFlow({ kind: 'idle' });
    };

    const noInstallations =
        connected && installationsLoaded && installations.length === 0;
    const personalInstalled = installations.some(
        (i) => !i.isOrg && (!username || i.login === username),
    );

    return {
        loaded,
        connected,
        username,
        orgs,
        installations,
        installationsLoaded,
        noInstallations,
        personalInstalled,
        storageOk,
        clientIdSet,
        flow,
        connect,
        cancel,
        refresh,
        openInstall,
        markInstallSurfaced,
        isInstalledFor,
    };
}

export function GitHubConnect({ account }: { account: GitHubAccount }) {
    const {
        loaded,
        connected,
        username,
        storageOk,
        clientIdSet,
        flow,
        installations,
        installationsLoaded,
        noInstallations,
    } = account;

    if (!loaded) {
        return (
            <Text size="xs" className="text-zinc-500">
                Checking GitHub connection…
            </Text>
        );
    }

    if (connected) {
        // Authorizing (a user token) is only HALF of connecting a GitHub App —
        // the App also has to be INSTALLED somewhere to read/write repos. The
        // hook auto-opens the install chooser once on a fresh connect; here we
        // ALSO surface installation as a permanent, first-class step so the
        // user can pick orgs whether or not they followed the auto-open, and
        // can ADD an org later even after the personal account is installed.
        const openChooser = () => {
            // Treat any manual open as "surfaced" so the one-shot auto-open
            // won't also fire and double-open the browser.
            account.markInstallSurfaced();
            void account.openInstall();
        };
        return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <Text size="xs" style={{ color: 'var(--emerald-600)', display: 'block' }}>
                    ✓ Connected as <strong>{username}</strong>
                </Text>
                {noInstallations ? (
                    <div
                        style={{
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 6,
                            padding: '8px 10px',
                            borderRadius: 8,
                            background: 'color-mix(in srgb, #f59e0b 12%, transparent)',
                            border: '1px solid color-mix(in srgb, #f59e0b 35%, var(--border-1))',
                        }}
                    >
                        <Text size="xs" style={{ display: 'block' }}>
                            One more step: choose where to install Genie. Pick
                            your personal account and/or any orgs — that's what
                            lets Genie create and fork repos there.
                        </Text>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                            <Action
                                size="sm"
                                color="blue"
                                icon="github"
                                onClick={openChooser}
                            >
                                Choose where to install Genie…
                            </Action>
                            <Action
                                size="sm"
                                variant="ghost"
                                icon="refresh-cw"
                                onClick={() => void account.refresh()}
                            >
                                I've installed it
                            </Action>
                        </div>
                    </div>
                ) : (
                    installationsLoaded && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                            <Text size="xs" className="text-zinc-500" style={{ display: 'block' }}>
                                Installed on{' '}
                                <strong>{installations.map((i) => i.login).join(', ')}</strong>.
                            </Text>
                            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                                <Action
                                    size="sm"
                                    variant="ghost"
                                    icon="github"
                                    onClick={openChooser}
                                >
                                    Install on another org…
                                </Action>
                                <Action
                                    size="sm"
                                    variant="ghost"
                                    icon="refresh-cw"
                                    onClick={() => void account.refresh()}
                                >
                                    Refresh
                                </Action>
                            </div>
                        </div>
                    )
                )}
            </div>
        );
    }

    return (
        <div className="gh-connect">
            {!storageOk && (
                <Text size="xs" style={{ color: 'var(--rose-500)', display: 'block' }}>
                    OS keychain unavailable — Genie won't store a token
                    unencrypted. On Linux: install gnome-keyring / libsecret.
                </Text>
            )}
            {!clientIdSet && (
                <Text size="xs" style={{ color: 'var(--rose-500)', display: 'block' }}>
                    No GitHub App Client ID configured. Set one in
                    Settings → GitHub → Advanced.
                </Text>
            )}

            {(flow.kind === 'idle' || flow.kind === 'error') && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Action
                        color="blue"
                        size="sm"
                        icon="github"
                        onClick={() => void account.connect()}
                        disabled={!storageOk || !clientIdSet}
                    >
                        Connect GitHub…
                    </Action>
                    <Text size="xs" className="text-zinc-500">
                        Needed to create or fork repositories. Genie can only
                        act on accounts where the GitHub App is installed.
                    </Text>
                </div>
            )}

            {flow.kind === 'starting' && (
                <Text size="xs" className="text-zinc-500">
                    Requesting a device code…
                </Text>
            )}

            {flow.kind === 'pending' && (
                <div className="gh-device">
                    <Text size="xs" className="text-zinc-500" style={{ display: 'block' }}>
                        A browser opened at <code>{flow.verificationUri}</code>.
                        Click the code to copy it, paste it on GitHub, and
                        approve — Genie catches the token automatically.
                    </Text>
                    <CodeChip code={flow.userCode} />
                    <div style={{ display: 'flex', gap: 8 }}>
                        <Action
                            size="sm"
                            variant="ghost"
                            icon="external-link"
                            onClick={() =>
                                api().tynn.openInBrowser(flow.verificationUri)
                            }
                        >
                            Reopen GitHub
                        </Action>
                        <Action size="sm" variant="ghost" onClick={() => void account.cancel()}>
                            Cancel
                        </Action>
                    </div>
                </div>
            )}

            {flow.kind === 'error' && (
                <Text size="xs" style={{ color: 'var(--rose-500)', display: 'block' }}>
                    {flow.message}
                </Text>
            )}
        </div>
    );
}

/**
 * Pull the install URL out of a "Genie isn't installed on X — install it:
 * <url>" error (the shape `GitHubNotInstalledError` produces on the main
 * side, serialized to a string across IPC). Returns null for any other
 * error so callers fall back to plain text.
 */
export function parseNotInstalled(
    message: string,
): { url: string } | null {
    const m = /install it:\s*(https?:\/\/\S+)/i.exec(message);
    return m ? { url: m[1] } : null;
}

/**
 * Renders an error string, upgrading a "not installed on <account>" error
 * into an actionable install prompt (a button that opens the App's install
 * page) instead of dead-ending on the raw message.
 */
export function GitHubErrorNotice({ message }: { message: string }) {
    const notInstalled = parseNotInstalled(message);
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <Text size="xs" style={{ color: 'var(--rose-500)', display: 'block' }}>
                {message}
            </Text>
            {notInstalled && (
                <Action
                    size="sm"
                    color="blue"
                    icon="external-link"
                    onClick={() =>
                        api().tynn.openInBrowser(notInstalled.url)
                    }
                >
                    Install Genie on this account…
                </Action>
            )}
        </div>
    );
}

/** Click-to-copy device code. Shows a brief "Copied" flash on click. */
function CodeChip({ code }: { code: string }) {
    const [copied, setCopied] = useState(false);
    const copy = () => {
        navigator.clipboard.writeText(code).then(
            () => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
            },
            () => {},
        );
    };
    return (
        <button
            type="button"
            className="gh-code"
            onClick={copy}
            title="Click to copy"
        >
            {code}
            <span className="gh-code-hint">{copied ? '✓ Copied' : 'Click to copy'}</span>
        </button>
    );
}

export function OwnerSelect({
    account,
    value,
    onChange,
    label = 'Owner',
}: {
    account: GitHubAccount;
    value: string;
    onChange: (login: string) => void;
    label?: string;
}) {
    if (!account.connected) return null;
    // The owner dropdown offers the personal account + every installed org. A
    // chosen account that ISN'T installed can't be written to — surface a
    // per-account install prompt for exactly that account instead of letting
    // the create/fork fail later. (The personal account may legitimately not
    // be installed even though the user authorized.)
    const options = [
        { value: '', label: `${account.username ?? '(you)'} · personal` },
        ...account.orgs.map((o) => ({ value: o.login, label: `${o.login} · org` })),
    ];
    const chosenInstalled = account.isInstalledFor(value);
    const chosenInstall = account.installations.find((i) => i.login === value);
    const chosenLabel = value || account.username || 'your personal account';
    return (
        <div>
            <Text size="xs" style={{ display: 'block', marginBottom: 6, fontWeight: 600 }}>
                {label}
            </Text>
            <Select value={value} onValueChange={onChange} list={options} />
            {account.installationsLoaded && !chosenInstalled && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
                    <Text size="xs" style={{ color: 'var(--amber-600)', flex: 1 }}>
                        Genie isn't installed on <strong>{chosenLabel}</strong> — install
                        it there to create/fork under this account.
                    </Text>
                    <Action
                        size="sm"
                        variant="ghost"
                        icon="external-link"
                        onClick={() => {
                            account.markInstallSurfaced();
                            void account.openInstall(chosenInstall?.id ?? null);
                        }}
                    >
                        Install here…
                    </Action>
                </div>
            )}
            <InstallOnOrgLink account={account} />
        </div>
    );
}

/**
 * "Install Genie on another account/org…" — the GitHub App only sees accounts
 * it's installed on, so an account the user wants but doesn't see in the
 * dropdown is fixed by installing the App there (not by re-authing). Opens the
 * App's install chooser; the new account appears after a refresh.
 */
export function InstallOnOrgLink({ account }: { account: GitHubAccount }) {
    return (
        <Text size="xs" className="text-zinc-500" style={{ display: 'block', marginTop: 4 }}>
            Don&apos;t see an account?{' '}
            <a
                href="#"
                onClick={(e) => {
                    e.preventDefault();
                    account.markInstallSurfaced();
                    void account.openInstall();
                }}
                style={{ color: 'var(--blue-400)' }}
            >
                Install Genie on another account/org…
            </a>
        </Text>
    );
}
