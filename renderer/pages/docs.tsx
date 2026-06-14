import React, { useEffect, useMemo, useState } from 'react';
import { ContentRenderer, Heading, Text } from '@particle-academy/react-fancy';
import { api, hasGenieBridge, type DocEntry } from '../lib/genie';

/**
 * In-app Docs viewer. A separate BrowserWindow (see showDocsWindow in
 * main/background.ts) loads this page. Left nav lists the bundled docs in
 * order (docs:list); the selected page's markdown (docs:read) is rendered with
 * react-fancy's ContentRenderer — styled, sanitized, syntax-highlighted, and
 * SSR-safe (all data loading is gated behind useEffect / window checks).
 *
 * Internal cross-links in the markdown are written as `NN-name.md` relative
 * hrefs; we intercept clicks on those and navigate within the viewer instead
 * of letting the browser follow a dead file URL.
 */
export default function DocsPage() {
    const [entries, setEntries] = useState<DocEntry[]>([]);
    const [active, setActive] = useState<string | null>(null);
    const [markdown, setMarkdown] = useState<string>('');
    const [loadingList, setLoadingList] = useState(true);
    const [error, setError] = useState<string | null>(null);

    // Load the ordered page list once.
    useEffect(() => {
        if (!hasGenieBridge()) {
            setLoadingList(false);
            return;
        }
        let cancelled = false;
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
    }, []);

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
                // Scroll the reading pane back to the top on navigation.
                const pane = document.getElementById('docs-content');
                if (pane) pane.scrollTop = 0;
            }
        }
    };

    if (!hasGenieBridge()) {
        return (
            <div className="surface" style={{ padding: 24 }}>
                <Text size="sm" className="text-zinc-500">
                    The Docs viewer runs inside the Genie desktop app.
                </Text>
            </div>
        );
    }

    return (
        <div
            className="surface"
            style={{ display: 'flex', height: '100vh', overflow: 'hidden' }}
        >
            {/* Left nav — ordered doc pages. */}
            <nav
                style={{
                    width: 248,
                    flex: '0 0 248px',
                    borderRight: '1px solid rgba(255,255,255,0.08)',
                    overflowY: 'auto',
                    padding: '16px 8px',
                }}
            >
                <div style={{ padding: '0 8px 12px' }}>
                    <Heading as="h2" size="sm">
                        Genie Docs
                    </Heading>
                </div>
                {loadingList && (
                    <Text size="xs" className="text-zinc-500" style={{ padding: '0 8px' }}>
                        Loading…
                    </Text>
                )}
                {!loadingList && entries.length === 0 && (
                    <Text size="xs" className="text-zinc-500" style={{ padding: '0 8px' }}>
                        No documentation found.
                    </Text>
                )}
                <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                    {entries.map((e) => {
                        const on = e.slug === active;
                        return (
                            <li key={e.slug}>
                                <button
                                    type="button"
                                    onClick={() => setActive(e.slug)}
                                    style={{
                                        width: '100%',
                                        textAlign: 'left',
                                        padding: '7px 10px',
                                        marginBottom: 2,
                                        borderRadius: 6,
                                        border: 'none',
                                        cursor: 'pointer',
                                        fontSize: 13,
                                        background: on
                                            ? 'rgba(255,255,255,0.10)'
                                            : 'transparent',
                                        color: on ? '#fafafa' : '#a1a1aa',
                                    }}
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
                id="docs-content"
                style={{ flex: 1, overflowY: 'auto', padding: '28px 36px' }}
                onClick={onContentClick}
            >
                {error ? (
                    <Text size="sm" className="text-rose-500">
                        {error}
                    </Text>
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
    );
}
