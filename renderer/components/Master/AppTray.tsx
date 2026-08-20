import { useCallback, useEffect, useState } from 'react';
import { api, hasGenieBridge, type InstalledAppView } from '../../lib/genie';
import { appTrayPills } from '../../lib/app-tray';

/**
 * The App Tray — installed GApps, left of the Genie header icons (Tynn #250).
 *
 * It GROWS LEFTWARD from the icons, so the icons never move as apps are installed:
 * the tray extends into the space beside them instead of pushing them along. That
 * is the whole reason it lives on this side, and why `row-reverse` is the layout
 * rather than a detail.
 *
 * A pill is a launcher and nothing more — no IssueWatch pill, none of the other
 * furniture a workspace row carries, because those describe things a workspace has
 * and an app does not. Managing apps is the drawer's job.
 *
 * The ordering and the labels are decided in `lib/app-tray.ts` and asserted there;
 * this renders them.
 */
export default function AppTray({ onOpenStore }: { onOpenStore: () => void }) {
    const [apps, setApps] = useState<InstalledAppView[]>([]);

    const refresh = useCallback(() => {
        if (!hasGenieBridge()) return;
        api()
            .apps.list()
            .then(setApps)
            .catch(() => {});
    }, []);

    useEffect(() => {
        refresh();
        // Refocusing is when the user looks at it, so it is when to be right — the
        // same self-heal the Questions badge uses, and for the same reason: an
        // install that happened in another window must not leave this one stale.
        window.addEventListener('focus', refresh);
        return () => window.removeEventListener('focus', refresh);
    }, [refresh]);

    const pills = appTrayPills(apps);

    return (
        <div
            className="app-tray"
            style={{
                display: 'flex',
                // LEFTWARD: the store button sits nearest the Genie icons and the
                // pills extend away from them, so nothing the user aims at moves
                // when an app is installed.
                flexDirection: 'row-reverse',
                alignItems: 'center',
                gap: 4,
            }}
        >
            <button
                type="button"
                className="gicon"
                title="Genie Apps — install, update and manage"
                aria-label="Genie Apps"
                onClick={onOpenStore}
            >
                <span aria-hidden style={{ fontSize: 13, lineHeight: 1 }}>
                    ▦
                </span>
            </button>

            {pills.map((pill) => (
                <button
                    key={pill.id}
                    type="button"
                    className="app-tray-pill"
                    title={pill.title}
                    aria-label={pill.name}
                    // A turned-off app KEEPS its pill — hiding it would make "where
                    // did my app go?" the next question — but it cannot be opened,
                    // and the tooltip is the only place that can say why before the
                    // click rather than after it.
                    disabled={pill.disabled}
                    onClick={() => void api().apps.open(pill.id).catch(() => {})}
                    style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                        height: 26,
                        padding: '0 10px 0 6px',
                        borderRadius: 999,
                        border: '1px solid var(--bg-3, rgba(120,120,120,0.25))',
                        background: 'var(--bg-2, #1d1d22)',
                        color: 'inherit',
                        cursor: pill.disabled ? 'default' : 'pointer',
                        opacity: pill.disabled ? 0.45 : 1,
                        maxWidth: 180,
                    }}
                >
                    <span
                        aria-hidden
                        style={{
                            width: 16,
                            height: 16,
                            borderRadius: 5,
                            display: 'grid',
                            placeItems: 'center',
                            fontSize: 10,
                            background: pill.dev
                                ? 'var(--amber-500, #f59e0b)'
                                : 'var(--indigo-400, #818cf8)',
                            color: '#0a0a0c',
                        }}
                    >
                        {pill.initial}
                    </span>
                    <span
                        style={{
                            fontSize: 12,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                        }}
                    >
                        {pill.name}
                    </span>
                </button>
            ))}
        </div>
    );
}
