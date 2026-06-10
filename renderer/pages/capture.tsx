import { useEffect, useRef, useState } from 'react';
import { Action, Icon, Select, Text } from '@particle-academy/react-fancy';
import { api, type TynnProject } from '../lib/genie';

/**
 * Frameless 480x200 always-on-top window the global hotkey toggles.
 * Type → Enter → wish posts → window hides.
 */
export default function CapturePage() {
    const [projects, setProjects] = useState<TynnProject[]>([]);
    const [projectId, setProjectId] = useState('');
    const [content, setContent] = useState('');
    const [sending, setSending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const inputRef = useRef<HTMLTextAreaElement>(null);

    useEffect(() => {
        (async () => {
            const ps = await api().tynn.projects();
            setProjects(ps);
            const current = await api().app.getCurrentProject();
            if (current?.id) setProjectId(current.id);
            else if (ps[0]?.id) setProjectId(ps[0].id);
            inputRef.current?.focus();
        })();
    }, []);

    const send = async () => {
        const text = content.trim();
        if (!text || !projectId || sending) return;
        setSending(true);
        setError(null);
        try {
            const selected = projects.find((p) => p.id === projectId);
            const backend = selected?.backend ?? 'tynn';
            await api().tynn.captureWish(projectId, text, backend);
            setContent('');
            await api().app.hideCapture();
        } catch (e: unknown) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setSending(false);
        }
    };

    const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            send();
        }
        if (e.key === 'Escape') {
            e.preventDefault();
            api().app.hideCapture();
        }
    };

    return (
        <div className="capture-frame">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <Icon name="sparkles" size="sm" className="text-violet-500" />
                <Text size="sm" style={{ fontWeight: 600 }}>
                    Capture a wish
                </Text>
                <div style={{ flex: 1 }} />
                <Action
                    variant="ghost"
                    size="xs"
                    icon="x"
                    className="no-drag"
                    onClick={() => api().app.hideCapture()}
                    title="Esc"
                />
            </div>

            <div className="no-drag" style={{ marginBottom: 8 }}>
                <Select
                    value={projectId}
                    onValueChange={setProjectId}
                    list={projects.map((p) => ({
                        value: p.id,
                        label: `[${(p.backend ?? 'tynn').toUpperCase()}] ${p.name}`,
                    }))}
                />
            </div>

            <textarea
                ref={inputRef}
                className="input no-drag"
                value={content}
                onChange={(e) => setContent(e.target.value)}
                onKeyDown={onKey}
                placeholder="What needs to happen?"
                rows={3}
                style={{ flex: 1, fontSize: 14 }}
            />

            {error && (
                <Text size="xs" style={{ color: 'var(--rose-500)', marginTop: 6 }}>
                    {error}
                </Text>
            )}

            <div
                className="no-drag"
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    marginTop: 8,
                }}
            >
                <span className="kbd">↵</span>
                <Text size="xs" className="text-zinc-500">
                    to send
                </Text>
                <span className="kbd">esc</span>
                <Text size="xs" className="text-zinc-500">
                    cancel
                </Text>
                <div style={{ flex: 1 }} />
                <Action color="blue" size="sm" icon="send" onClick={send} disabled={sending || !content.trim() || !projectId}>
                    {sending ? 'Sending…' : 'Send'}
                </Action>
            </div>
        </div>
    );
}
