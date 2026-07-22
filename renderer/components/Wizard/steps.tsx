import { useEffect, useRef, useState } from 'react';
import { Action, Icon, Input, Select, Text } from '@particle-academy/react-fancy';
import Terminal from '../Terminal/Terminal';
import { api, ulid } from '../../lib/genie';
import {
    captureTerminalOutput,
    evaluateTerminalUntil,
    type BrowserStepSpec,
    type ChoiceStepSpec,
    type FormStepSpec,
    type RecipeContext,
    type RecipeEngine,
    type RecipeStep,
    type TaskStepSpec,
    type TerminalStepSpec,
} from '../../lib/recipes';

/**
 * The five step-type views the WizardModal renders. Every view drives the
 * SAME RecipeEngine: form/choice report validity (success ⇄ active) as the
 * user edits; terminal/browser/task run their effect only while ACTIVE and
 * report markRunning → markSuccess/markError. None of them own navigation —
 * the engine's gating decides when Next/Finish unlock.
 */

interface StepViewProps {
    step: RecipeStep;
    engine: RecipeEngine;
    ctx: RecipeContext;
    active: boolean;
    /** Fallback cwd for terminal steps that don't pin one. */
    defaultCwd: string;
}

/** Reflect a form/choice step's validity into the engine without redundant emits. */
function syncValidity(engine: RecipeEngine, stepId: string, valid: boolean): void {
    const st = engine.stateOf(stepId);
    if (valid && st !== 'success') engine.markSuccess(stepId);
    else if (!valid && st === 'success') engine.resetStep(stepId);
}

/* ===== form ============================================================= */

function FormStep({ step, engine }: { step: FormStepSpec; engine: RecipeEngine }) {
    // Seed defaults into the context once, before first paint.
    useEffect(() => {
        for (const f of step.fields) {
            if (f.defaultValue !== undefined && engine.get(f.key) === undefined) {
                engine.set(f.key, f.defaultValue);
            }
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const valid = step.fields.every(
        (f) => !f.required || String(engine.get(f.key) ?? '').trim() !== '',
    );
    useEffect(() => {
        syncValidity(engine, step.id, valid);
    }, [engine, step.id, valid]);

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {step.fields.map((f) => {
                const value = String(engine.get(f.key) ?? '');
                if (f.type === 'select') {
                    return (
                        <div key={f.key}>
                            <Text size="xs" style={{ display: 'block', marginBottom: 4, fontWeight: 600 }}>
                                {f.label}
                            </Text>
                            <Select
                                value={value}
                                onValueChange={(v) => engine.set(f.key, v)}
                                list={(f.options ?? []).map((o) => ({ value: o.value, label: o.label }))}
                                placeholder={f.placeholder}
                            />
                            {f.description && (
                                <Text size="xs" className="text-zinc-500" style={{ display: 'block', marginTop: 4 }}>
                                    {f.description}
                                </Text>
                            )}
                        </div>
                    );
                }
                return (
                    <Input
                        key={f.key}
                        label={f.label}
                        description={f.description}
                        placeholder={f.placeholder}
                        type={f.type === 'password' ? 'password' : f.type === 'number' ? 'number' : 'text'}
                        value={value}
                        onValueChange={(v) => engine.set(f.key, v)}
                    />
                );
            })}
        </div>
    );
}

/* ===== choice =========================================================== */

function ChoiceStep({ step, engine }: { step: ChoiceStepSpec; engine: RecipeEngine }) {
    const raw = engine.get(step.id);
    const selected: string[] = Array.isArray(raw) ? (raw as string[]) : raw ? [String(raw)] : [];

    const valid = selected.length > 0;
    useEffect(() => {
        syncValidity(engine, step.id, valid);
    }, [engine, step.id, valid]);

    const pick = (value: string) => {
        if (step.multi) {
            const next = selected.includes(value)
                ? selected.filter((v) => v !== value)
                : [...selected, value];
            engine.set(step.id, next);
        } else {
            engine.set(step.id, value);
        }
    };

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {step.options.map((o) => {
                const on = selected.includes(o.value);
                return (
                    <button
                        key={o.value}
                        type="button"
                        onClick={() => pick(o.value)}
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 10,
                            padding: '10px 12px',
                            textAlign: 'left',
                            borderRadius: 8,
                            cursor: 'pointer',
                            border: on ? '1px solid var(--blue-500)' : '1px solid var(--zinc-700)',
                            background: on ? 'color-mix(in srgb, var(--blue-500) 12%, transparent)' : 'transparent',
                        }}
                    >
                        <Icon name={on ? (step.multi ? 'check-square' : 'check-circle') : step.multi ? 'square' : 'circle'} size="sm" />
                        <span style={{ display: 'flex', flexDirection: 'column' }}>
                            <Text size="sm" style={{ fontWeight: 600 }}>{o.label}</Text>
                            {o.description && (
                                <Text size="xs" className="text-zinc-500">{o.description}</Text>
                            )}
                        </span>
                    </button>
                );
            })}
        </div>
    );
}

/* ===== terminal ========================================================= */

function TerminalStep({ step, engine, ctx, active, defaultCwd }: {
    step: TerminalStepSpec;
    engine: RecipeEngine;
    ctx: RecipeContext;
    active: boolean;
    defaultCwd: string;
}) {
    const termIdRef = useRef('');
    const outputRef = useRef('');
    const doneRef = useRef(false);
    const [attempt, setAttempt] = useState(0);

    const startAttempt = () => {
        termIdRef.current = `recipe-${step.id}-${ulid()}`;
        outputRef.current = '';
        doneRef.current = false;
    };
    if (!termIdRef.current) startAttempt();

    const succeed = () => {
        doneRef.current = true;
        const capture = step.capture
            ? { key: step.capture, value: captureTerminalOutput(step.until, outputRef.current) }
            : undefined;
        engine.markSuccess(step.id, capture);
    };

    // While active, mark the step running and accumulate pty output so an
    // `until.pattern` can resolve even before the process exits. The SAME pty
    // stream the <Terminal> renders is observed here via a second listener
    // (api().on.terminalData is a multi-listener emitter).
    useEffect(() => {
        if (!active) return;
        engine.markRunning(step.id);
        const off = api().on.terminalData(({ id, data }) => {
            if (id !== termIdRef.current || doneRef.current) return;
            outputRef.current += data;
            if (evaluateTerminalUntil(step.until, { output: outputRef.current }) === 'success') {
                succeed();
            }
        });
        return () => off();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [active, attempt]);

    const onExit = ({ exitCode }: { exitCode: number }) => {
        if (doneRef.current) return;
        const verdict = evaluateTerminalUntil(step.until, { exitCode, output: outputRef.current });
        if (verdict === 'success') succeed();
        else if (verdict === 'fail') {
            doneRef.current = true;
            engine.markError(step.id, `"${step.command}" exited with code ${exitCode}.`);
        }
    };

    const rerun = () => {
        startAttempt();
        setAttempt((n) => n + 1);
    };

    const failed = engine.stateOf(step.id) === 'error';

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Text size="xs" className="text-zinc-500" style={{ display: 'block' }}>
                Running <code>{[step.command, ...(step.args ?? [])].join(' ')}</code>
                {ctx.workstationId ? ' on the host' : ''}.
            </Text>
            <div style={{ height: 280, borderRadius: 8, overflow: 'hidden', border: '1px solid var(--zinc-800)' }}>
                {active ? (
                    <Terminal
                        key={termIdRef.current}
                        id={termIdRef.current}
                        cwd={step.cwd ?? defaultCwd}
                        shell={step.command}
                        args={step.args}
                        workspaceId={ctx.workspaceId}
                        onExit={onExit}
                        className="h-full w-full"
                    />
                ) : (
                    <div style={{ display: 'grid', placeItems: 'center', height: '100%' }}>
                        <Text size="xs" className="text-zinc-500">Terminal starts when you reach this step.</Text>
                    </div>
                )}
            </div>
            {failed && (
                <Action size="sm" variant="ghost" icon="refresh-cw" onClick={rerun}>
                    Run again
                </Action>
            )}
        </div>
    );
}

/* ===== browser ========================================================== */

function BrowserStep({ step, engine, ctx, active }: {
    step: BrowserStepSpec;
    engine: RecipeEngine;
    ctx: RecipeContext;
    active: boolean;
}) {
    const [opened, setOpened] = useState(false);
    const openedRef = useRef(false);
    const resolveUrl = () => (typeof step.url === 'function' ? step.url(ctx) : step.url);

    const open = async () => {
        engine.markRunning(step.id);
        try {
            await api().shell.openExternal(resolveUrl());
        } catch (e) {
            engine.markError(step.id, e instanceof Error ? e.message : String(e));
            return;
        }
        openedRef.current = true;
        setOpened(true);
        if (!step.check) engine.markSuccess(step.id);
    };

    // Auto-open the first time the step is reached.
    useEffect(() => {
        if (active && !openedRef.current) void open();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [active]);

    // Poll `check` until it resolves true (only when a check is declared).
    useEffect(() => {
        if (!active || !opened || !step.check) return;
        if (engine.stateOf(step.id) === 'success') return;
        let cancelled = false;
        let timer: ReturnType<typeof setTimeout>;
        const tick = async () => {
            try {
                if (await step.check!(ctx)) {
                    if (!cancelled) engine.markSuccess(step.id);
                    return;
                }
            } catch {
                /* transient — keep polling */
            }
            if (!cancelled) timer = setTimeout(tick, step.pollMs ?? 2000);
        };
        void tick();
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [active, opened]);

    const waiting = opened && !!step.check && engine.stateOf(step.id) !== 'success';

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <Text size="sm" style={{ display: 'block' }}>
                Opening <code>{resolveUrl()}</code> in your browser.
            </Text>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <Action size="sm" color="blue" icon="external-link" onClick={() => void open()}>
                    {opened ? 'Open again' : 'Open in browser'}
                </Action>
                {waiting && (
                    <Text size="xs" className="text-zinc-500">
                        <Icon name="loader" size="sm" /> Waiting for you to finish…
                    </Text>
                )}
            </div>
        </div>
    );
}

/* ===== task ============================================================= */

function TaskStep({ step, engine, ctx, active }: {
    step: TaskStepSpec;
    engine: RecipeEngine;
    ctx: RecipeContext;
    active: boolean;
}) {
    const ranRef = useRef(false);

    const run = async () => {
        engine.markRunning(step.id);
        try {
            await step.run(ctx);
            engine.markSuccess(step.id);
        } catch (e) {
            engine.markError(step.id, e instanceof Error ? e.message : String(e));
        }
    };

    useEffect(() => {
        if (active && !ranRef.current) {
            ranRef.current = true;
            void run();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [active]);

    const state = engine.stateOf(step.id);
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-start' }}>
            {state === 'running' && (
                <Text size="sm" className="text-zinc-500">
                    <Icon name="loader" size="sm" /> Working…
                </Text>
            )}
            {state === 'success' && (
                <Text size="sm" style={{ color: 'var(--green-500)' }}>
                    <Icon name="check" size="sm" /> Done.
                </Text>
            )}
            {state === 'error' && (
                <Action size="sm" variant="ghost" icon="refresh-cw" onClick={() => { ranRef.current = true; void run(); }}>
                    Try again
                </Action>
            )}
        </div>
    );
}

/* ===== dispatcher ======================================================= */

/** Render the view for a step, plus its surfaced error (if any). */
export function StepView(props: StepViewProps) {
    const { step, engine } = props;
    const error = engine.errorOf(step.id);
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {step.type === 'form' && <FormStep step={step} engine={engine} />}
            {step.type === 'choice' && <ChoiceStep step={step} engine={engine} />}
            {step.type === 'terminal' && (
                <TerminalStep step={step} engine={engine} ctx={props.ctx} active={props.active} defaultCwd={props.defaultCwd} />
            )}
            {step.type === 'browser' && (
                <BrowserStep step={step} engine={engine} ctx={props.ctx} active={props.active} />
            )}
            {step.type === 'task' && (
                <TaskStep step={step} engine={engine} ctx={props.ctx} active={props.active} />
            )}
            {error && (
                <Text size="xs" style={{ color: 'var(--rose-500)', display: 'block' }}>
                    {error}
                </Text>
            )}
        </div>
    );
}
