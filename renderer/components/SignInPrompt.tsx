import React, { useEffect, useState } from 'react';
import { Action, Badge, Card, Heading, Icon, Input, Text } from '@particle-academy/react-fancy';
import { api, type BackendUser } from '../lib/genie';

interface Props {
    tynnHost: string;
    aionimaHost: string;
    /** Called whenever any backend transitions to signed-in. */
    onSignedIn: () => void;
}

/**
 * Two-backend sign-in surface. Either Tynn (browser handoff via
 * genie://oauth/callback) or Aionima (host + token from Settings).
 *
 * Genie works in any combination — Tynn-only, Aionima-only, or both.
 */
export default function SignInPrompt({ tynnHost, aionimaHost, onSignedIn }: Props) {
    const [waitingTynn, setWaitingTynn] = useState(false);
    const [tynnUrl, setTynnUrl] = useState<string | null>(null);
    const [signedIn, setSignedIn] = useState<Record<string, BackendUser | null>>({
        tynn: null,
        aionima: null,
    });
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        void refresh();
        const off = api().on.authChanged(() => {
            void refresh();
            setTimeout(() => void refresh(), 200);
        });
        return () => off();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const refresh = async () => {
        const tynn = (await api().auth.whoami('tynn')) as BackendUser | null;
        const aionima = (await api().auth.whoami('aionima')) as BackendUser | null;
        setSignedIn({ tynn, aionima });
        if (tynn || aionima) onSignedIn();
        if (tynn) setWaitingTynn(false);
    };

    const startTynn = async () => {
        setError(null);
        setWaitingTynn(true);
        try {
            const r = await api().auth.startSignIn('tynn');
            // Always surface the URL: on a browserless / remotely-driven
            // machine shell.openExternal can't open anything, so the user
            // copies this link, opens it on any device, signs in, and
            // pastes the code back below.
            if (r?.url) setTynnUrl(r.url);
        } catch (e: unknown) {
            setError(e instanceof Error ? e.message : String(e));
            setWaitingTynn(false);
        }
    };

    const openSettings = () => api().app.showSettings();

    return (
        <div className="flex flex-col gap-4 p-6">
            <div className="text-center">
                <Heading as="h2" size="md" className="m-0">
                    Connect Genie
                </Heading>
                <Text size="sm" className="mt-1 block text-zinc-500">
                    Connect Tynn, Aionima, or both — Genie shuttles between them.
                </Text>
            </div>

            <div className="grid grid-cols-2 gap-3">
                <BackendCard
                    name="Tynn"
                    subtitle="SaaS project management"
                    host={tynnHost}
                    icon="cloud"
                    iconBgClass="bg-blue-500"
                    user={signedIn.tynn}
                    onSignIn={startTynn}
                    onSignOut={async () => {
                        await api().auth.signOut('tynn');
                        await refresh();
                    }}
                    busy={waitingTynn}
                    cta="Open Tynn in your browser"
                    onEditHost={openSettings}
                    showCodeFallback
                    signInUrl={tynnUrl}
                    onRedeemCode={async (code) => {
                        const r = await api().auth.redeemCode(code);
                        if (r.ok) await refresh();
                        return r.ok;
                    }}
                />

                <BackendCard
                    name="Aionima"
                    subtitle="Local LAN AGI gateway"
                    host={aionimaHost || 'Not configured'}
                    icon="cpu"
                    iconBgClass="bg-violet-500"
                    user={signedIn.aionima}
                    onSignIn={openSettings}
                    onSignOut={async () => {
                        await api().auth.signOut('aionima');
                        await refresh();
                    }}
                    busy={false}
                    cta={
                        aionimaHost
                            ? 'Reconnect in Settings'
                            : 'Configure host + token in Settings'
                    }
                    onEditHost={openSettings}
                />
            </div>

            {error && (
                <Text size="xs" className="text-center text-rose-500">
                    {error}
                </Text>
            )}

            <Text size="xs" className="text-center leading-relaxed text-zinc-400">
                Tynn signs you in through your browser. Aionima uses a host + token
                you set in Settings.
            </Text>
        </div>
    );
}

function BackendCard({
    name,
    subtitle,
    host,
    icon,
    iconBgClass,
    user,
    onSignIn,
    onSignOut,
    busy,
    cta,
    onEditHost,
    showCodeFallback,
    signInUrl,
    onRedeemCode,
}: {
    name: string;
    subtitle: string;
    host: string;
    icon: string;
    iconBgClass: string;
    user: BackendUser | null;
    onSignIn: () => void;
    onSignOut: () => void;
    busy: boolean;
    cta: string;
    onEditHost?: () => void;
    showCodeFallback?: boolean;
    signInUrl?: string | null;
    onRedeemCode?: (code: string) => Promise<boolean>;
}) {
    const [codeOpen, setCodeOpen] = useState(false);
    const [code, setCode] = useState('');
    const [redeeming, setRedeeming] = useState(false);
    const [redeemError, setRedeemError] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);

    // Once the sign-in URL is available (the user clicked the button), auto-open
    // the code entry so copy-URL → sign-in-elsewhere → paste-code reads as one
    // continuous flow on a browserless / remotely-driven machine.
    useEffect(() => {
        if (signInUrl) setCodeOpen(true);
    }, [signInUrl]);

    const submitCode = async () => {
        if (!onRedeemCode) return;
        setRedeeming(true);
        setRedeemError(null);
        try {
            const ok = await onRedeemCode(code);
            if (ok) {
                setCode('');
                setCodeOpen(false);
            } else {
                setRedeemError('Code rejected — it may have expired (5 min) or already been used.');
            }
        } catch (e: unknown) {
            setRedeemError(e instanceof Error ? e.message : String(e));
        } finally {
            setRedeeming(false);
        }
    };

    return (
        <Card className="flex flex-col gap-3 p-4">
            <div className="flex items-center gap-2.5">
                <div
                    className={`flex h-9 w-9 items-center justify-center rounded-md text-white ${iconBgClass}`}
                >
                    <Icon name={icon} size="sm" />
                </div>
                <div className="min-w-0 flex-1">
                    <Heading as="h3" size="sm" className="m-0">
                        {name}
                    </Heading>
                    <Text size="xs" className="block text-zinc-500">
                        {subtitle}
                    </Text>
                </div>
                {user && (
                    <Badge color="emerald" variant="soft" size="sm">
                        Connected
                    </Badge>
                )}
            </div>

            <div className="flex min-w-0 items-center gap-1.5">
                <Text
                    size="xs"
                    className="flex-1 truncate font-mono text-zinc-400"
                    title={host}
                >
                    {host}
                </Text>
                {onEditHost && (
                    <Action variant="ghost" color="blue" size="xs" onClick={onEditHost}>
                        Change
                    </Action>
                )}
            </div>

            {user ? (
                <div className="flex items-center gap-2">
                    <Text size="xs" className="flex-1">
                        Signed in as <strong>{user.name}</strong>
                    </Text>
                    <Action variant="ghost" size="sm" onClick={onSignOut}>
                        Sign out
                    </Action>
                </div>
            ) : (
                <>
                    <Action color="blue" size="sm" onClick={onSignIn} disabled={busy}>
                        {busy ? 'Waiting…' : cta}
                    </Action>

                    {signInUrl && (
                        <div className="flex flex-col gap-1.5 rounded-md border border-blue-500/20 bg-blue-500/5 p-2.5">
                            <Text size="xs" className="text-zinc-500">
                                No browser on this machine? Copy this link, open it
                                on any device, sign in, then paste the code below.
                            </Text>
                            <div className="flex min-w-0 items-center gap-1.5">
                                <Text
                                    size="xs"
                                    className="flex-1 truncate font-mono text-zinc-400"
                                    title={signInUrl}
                                >
                                    {signInUrl}
                                </Text>
                                <Action
                                    variant="ghost"
                                    color="blue"
                                    size="xs"
                                    icon={copied ? 'check' : 'copy'}
                                    onClick={() => {
                                        void navigator.clipboard?.writeText(signInUrl);
                                        setCopied(true);
                                        setTimeout(() => setCopied(false), 1500);
                                    }}
                                >
                                    {copied ? 'Copied' : 'Copy'}
                                </Action>
                            </div>
                        </div>
                    )}

                    {showCodeFallback && onRedeemCode && (
                        <div className="flex flex-col gap-2">
                            <Action
                                variant="ghost"
                                size="xs"
                                color="blue"
                                onClick={() => setCodeOpen((v) => !v)}
                                icon={codeOpen ? 'chevron-up' : 'chevron-down'}
                            >
                                {codeOpen ? 'Hide code entry' : 'I have a code'}
                            </Action>

                            {codeOpen && (
                                <div className="flex flex-col gap-2">
                                    <Input
                                        value={code}
                                        onValueChange={setCode}
                                        placeholder="Paste sign-in code from Tynn"
                                        description="If your browser couldn't launch Genie, copy the code from the Tynn handoff page and paste it here."
                                        disabled={redeeming}
                                    />
                                    <div className="flex gap-2">
                                        <Action
                                            color="blue"
                                            size="sm"
                                            onClick={submitCode}
                                            disabled={!code.trim() || redeeming}
                                            icon={redeeming ? 'loader' : 'check'}
                                        >
                                            {redeeming ? 'Signing in…' : 'Sign in'}
                                        </Action>
                                    </div>
                                    {redeemError && (
                                        <Text size="xs" className="text-rose-500">
                                            {redeemError}
                                        </Text>
                                    )}
                                </div>
                            )}
                        </div>
                    )}
                </>
            )}
        </Card>
    );
}
