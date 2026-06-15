import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ContentRenderer } from '@particle-academy/react-fancy';
import { IconX } from './icons';
import { api, hasGenieBridge, type DocEntry } from '../../lib/genie';

/**
 * In-window Docs flyout. Slides in from the RIGHT over TheFloor (the chooser
 * already owns a LEFT flyout, so docs read well on the opposite edge). Toggled
 * by the ? button in the titlebar.
 *
 * Reuses the exact list+render logic from the old standalone Docs window:
 * `docs:list` orders the bundled pages (left nav); the selected page's markdown
 * (`docs:read`) is rendered with react-fancy's ContentRenderer — styled,
 * sanitized, syntax-highlighted. Internal `NN-name.md` cross-links are
 * intercepted and navigated within the flyout instead of following a dead URL.
 *
 * Dismiss affordances: the X button, Escape, and a click on the scrim.
 *
 * SSR-safe: all data loading is gated behind `open` + useEffect (never runs
 * during static export), and every render branch is pure markup.
 */
export default function DocsFlyout({
    open,
    onClose,
}: {
    open: boolean;
    onClose: () => void;
}) {
    const [entries, setEntries] = useState<DocEntry[]>([]);
    const [active, setActive] = useState<string | null>(null);
    const [markdown, setMarkdown] = useState<string>('');
    const [loadingList, setLoadingList] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const contentRef = useRef<HTMLElement>(null);

    // Load the ordered page list the first time the flyout opens.
    useEffect(() => {
        if (!open || !hasGenieBridge()) {
            if (!hasGenieBridge()) setLoadingList(false);
            return;
        }
        if (entries.length > 0) return; // already loaded; keep state across reopens
        let cancelled = false;
        setLoadingList(true);
        (async () => {
            try {
                const list = await api().docs.list();
                if (cancelled) return;
                setEntries(list);
                setActive((cur) => cur ?? list[0]?.slug ?? null);
            } catch (e) {
                if (!cancelled) setError(String(e));
            } finally {
                if (!cancelled) setLoadingList(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [open, entries.length]);

    // Load the active page's markdown whenever the selection changes.
    useEffect(() => {
        if (!active || !hasGenieBridge()) return;
        let cancelled = false;
        (async () => {
            try {
                const md = await api().docs.read(active);
                if (cancelled) return;
                setMarkdown(md ?? `# Not found\n\nCould not load \`${active}\`.`);
            } catch (e) {
                if (!cancelled) setMarkdown(`# Error\n\n${String(e)}`);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [active]);

    // Escape closes the flyout (only while open).
    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                onClose();
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [open, onClose]);

    const activeTitle = useMemo(
        () => entries.find((e) => e.slug === active)?.title ?? 'Documentation',
        [entries, active],
    );

    // Intercept clicks on internal `NN-name.md` links and navigate in-app.
    const onContentClick = (e: React.MouseEvent<HTMLDivElement>) => {
        const target = (e.target as HTMLElement)?.closest('a');
        if (!target) return;
        const href = target.getAttribute('href') ?? '';
        const m = /^(\d{2,}-[a-z0-9-]+)\.md(?:#.*)?$/i.exec(href.trim());
        if (m) {
            e.preventDefault();
            const slug = m[1];
            if (entries.some((x) => x.slug === slug)) {
                setActive(slug);
                if (contentRef.current) contentRef.current.scrollTop = 0;
            }
        }
    };

    return (
        <div className={`docs-flyout-root${open ? ' open' : ''}`} aria-hidden={!open}>
            {/* Scrim — click-outside dismiss. */}
            <div className="docs-scrim" onClick={onClose} />

            <aside
                className="docs-flyout"
                role="dialog"
                aria-label="Documentation"
                aria-modal="false"
            >
                <div className="docs-head">
                    <span className="docs-title">Genie Docs</span>
                    <span className="grow" />
                    <button
                        type="button"
                        className="gicon"
                        onClick={onClose}
                        title="Close documentation"
                        aria-label="Close documentation"
                    >
                        <IconX />
                    </button>
                </div>

                <div className="docs-body">
                    {/* Left nav — ordered doc pages. */}
                    <nav className="docs-nav">
                        {loadingList && <span className="docs-muted">Loading…</span>}
                        {!loadingList && !hasGenieBridge() && (
                            <span className="docs-muted">
                                The Docs viewer runs inside the Genie desktop app.
                            </span>
                        )}
                        {!loadingList && hasGenieBridge() && entries.length === 0 && (
                            <span className="docs-muted">No documentation found.</span>
                        )}
                        <ul>
                            {entries.map((e) => {
                                const on = e.slug === active;
                                return (
                                    <li key={e.slug}>
                                        <button
                                            type="button"
                                            className={on ? 'on' : ''}
                                            onClick={() => setActive(e.slug)}
                                        >
                                            {e.title}
                                        </button>
                                    </li>
                                );
                            })}
                        </ul>
                    </nav>

                    {/* Reading pane. */}
                    <main
                        className="docs-content"
                        ref={contentRef}
                        onClick={onContentClick}
                    >
                        {error ? (
                            <span className="docs-error">{error}</span>
                        ) : (
                            <article
                                className="prose prose-invert max-w-3xl"
                                aria-label={activeTitle}
                            >
                                <ContentRenderer value={markdown} format="markdown" />
                            </article>
                        )}
                    </main>
                </div>
            </aside>
        </div>
    );
}
