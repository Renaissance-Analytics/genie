import { useEffect, useRef, useState } from 'react';

interface PromptOptions {
    title: string;
    label?: string;
    initial?: string;
    placeholder?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    destructive?: boolean;
    /** Render-only message body when no input is needed (acts as a confirm). */
    body?: string;
}

/**
 * Lightweight in-app modal for Rename / Confirm flows. Replaces
 * `window.prompt` and `window.confirm` which Electron disables in
 * renderer windows.
 *
 * `promptModal({...})` returns a Promise<string | null>:
 *   - string → user submitted (input mode)
 *   - true   → user clicked confirm (no-input mode; returned as the literal "" if you treat it as string)
 *   - null   → cancelled / escape
 *
 * Renders into the root container; only one modal at a time.
 */

type Resolver = (value: string | null) => void;

const pending: { opts: PromptOptions; resolve: Resolver } | null = null;
const listeners = new Set<() => void>();
let active: { opts: PromptOptions; resolve: Resolver } | null = pending;

export function showPrompt(opts: PromptOptions): Promise<string | null> {
    // Resolve any prior modal as cancelled before opening a new one.
    if (active) active.resolve(null);
    return new Promise<string | null>((resolve) => {
        active = { opts, resolve };
        listeners.forEach((cb) => cb());
    });
}

function closeAndResolve(value: string | null) {
    if (!active) return;
    const resolver = active.resolve;
    active = null;
    listeners.forEach((cb) => cb());
    resolver(value);
}

export function PromptHost() {
    const [, setTick] = useState(0);
    useEffect(() => {
        const cb = () => setTick((n) => n + 1);
        listeners.add(cb);
        return () => {
            listeners.delete(cb);
        };
    }, []);
    if (!active) return null;
    return <PromptDialog opts={active.opts} onResult={closeAndResolve} />;
}

function PromptDialog({
    opts,
    onResult,
}: {
    opts: PromptOptions;
    onResult: (value: string | null) => void;
}) {
    const [value, setValue] = useState(opts.initial ?? '');
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        // Defer focus so the modal has actually been attached to the DOM
        // (otherwise the autofocus loses to the original right-click target).
        const t = setTimeout(() => {
            inputRef.current?.focus();
            inputRef.current?.select();
        }, 30);
        return () => clearTimeout(t);
    }, []);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                onResult(null);
            }
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [onResult]);

    const isInput = opts.body === undefined;
    const confirmText = opts.confirmLabel ?? (isInput ? 'Save' : 'Confirm');
    const cancelText = opts.cancelLabel ?? 'Cancel';

    const submit = () => {
        if (isInput) {
            const trimmed = value.trim();
            if (!trimmed) return;
            onResult(trimmed);
        } else {
            onResult('');
        }
    };

    return (
        <div className="prompt-scrim" onMouseDown={() => onResult(null)}>
            <div
                className="prompt-card"
                role="dialog"
                aria-modal="true"
                aria-label={opts.title}
                onMouseDown={(e) => e.stopPropagation()}
            >
                <div className="prompt-title">{opts.title}</div>
                {opts.body && <div className="prompt-body">{opts.body}</div>}
                {isInput && (
                    <>
                        {opts.label && (
                            <label className="prompt-label">{opts.label}</label>
                        )}
                        <input
                            ref={inputRef}
                            className="prompt-input"
                            value={value}
                            onChange={(e) => setValue(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                    e.preventDefault();
                                    submit();
                                }
                            }}
                            placeholder={opts.placeholder ?? ''}
                            spellCheck={false}
                        />
                    </>
                )}
                <div className="prompt-actions">
                    <button
                        type="button"
                        className="prompt-btn"
                        onClick={() => onResult(null)}
                    >
                        {cancelText}
                    </button>
                    <button
                        type="button"
                        className={`prompt-btn prompt-btn-primary${opts.destructive ? ' prompt-btn-destructive' : ''}`}
                        onClick={submit}
                    >
                        {confirmText}
                    </button>
                </div>
            </div>
        </div>
    );
}
