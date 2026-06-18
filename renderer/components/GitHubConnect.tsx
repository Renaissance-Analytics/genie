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
    storageOk: boolean;
    clientIdSet: boolean;
    flow: Flow;
    connect: () => Promise<void>;
    cancel: () => Promise<void>;
    refresh: () => Promise<unknown>;
}

export function useGitHubAccount(): GitHubAccount {
    const [loaded, setLoaded] = useState(false);
    const [connected, setConnected] = useState(false);
    const [username, setUsername] = useState<string | null>(null);
    const [orgs, setOrgs] = useState<GitHubOrgLite[]>([]);
    const [storageOk, setStorageOk] = useState(true);
    const [clientIdSet, setClientIdSet] = useState(false);
    const [flow, setFlow] = useState<Flow>({ kind: 'idle' });
    const polling = useRef(false);

    const refresh = async () => {
        const st = await api().github.status();
        setConnected(st.connected);
        setUsername(st.username);
        setStorageOk(st.storageOk);
        setClientIdSet(st.clientIdSet);
        setLoaded(true);
        if (st.connected) {
            try {
                const list = await api().github.orgs();
                setOrgs(list.map((o) => ({ login: o.login })));
            } catch {
                setOrgs([]);
            }
        }
        // Reflect the main-side flow outcome into local state.
        if (st.flow.kind === 'success') {
            setFlow({ kind: 'idle' });
        } else if (st.flow.kind === 'error') {
            setFlow({ kind: 'error', message: st.flow.message });
        }
        return st;
    };

    useEffect(() => {
        void refresh();
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

    const connect = async () => {
        try {
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

    return {
        loaded,
        connected,
        username,
        orgs,
        storageOk,
        clientIdSet,
        flow,
        connect,
        cancel,
        refresh,
    };
}

export function GitHubConnect({ account }: { account: GitHubAccount }) {
    const { loaded, connected, username, storageOk, clientIdSet, flow } = account;

    if (!loaded) {
        return (
            <Text size="xs" className="text-zinc-500">
                Checking GitHub connection…
            </Text>
        );
    }

    if (connected) {
        return (
            <Text size="xs" style={{ color: 'var(--emerald-600)', display: 'block' }}>
                ✓ Connected as <strong>{username}</strong>
            </Text>
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
    const options = [
        { value: '', label: `${account.username ?? '(you)'} · personal` },
        ...account.orgs.map((o) => ({ value: o.login, label: `${o.login} · org` })),
    ];
    return (
        <div>
            <Text size="xs" style={{ display: 'block', marginBottom: 6, fontWeight: 600 }}>
                {label}
            </Text>
            <Select value={value} onValueChange={onChange} list={options} />
            <InstallOnOrgLink />
        </div>
    );
}

/**
 * "Install Genie on another org…" — the GitHub App only sees accounts it's
 * installed on, so an org the user wants but doesn't see in the dropdown is
 * fixed by installing the App there (not by re-authing). Opens the App's
 * install page; the new org appears in the list after a refresh.
 */
export function InstallOnOrgLink() {
    const open = async () => {
        try {
            const url = await api().github.installUrl();
            await api().tynn.openInBrowser(url);
        } catch {
            // Best-effort; the link is a convenience, not load-bearing.
        }
    };
    return (
        <Text size="xs" className="text-zinc-500" style={{ display: 'block', marginTop: 4 }}>
            Don&apos;t see an org?{' '}
            <a
                href="#"
                onClick={(e) => {
                    e.preventDefault();
                    void open();
                }}
                style={{ color: 'var(--blue-400)' }}
            >
                Install Genie on another org…
            </a>
        </Text>
    );
}
