import { Input } from '@particle-academy/react-fancy';
import type { FlowForm, Problem, SiteFormDefaults, SiteMode } from '../../core/forms.js';

/**
 * THE FORMS — "Add a site" and "Add a flow".
 *
 * Defaults are prefilled from disk (core/forms.ts decides them), the hint says what Genie will do,
 * and every problem is shown beside its field at once — the person fixes the form in one pass.
 * Submit and Cancel are the only ways out. These are plain controlled-by-default forms rendered
 * server-side in tests, so they read their values from the DOM on submit rather than from state.
 */

function ProblemLine({ field, problems }: { field: string; problems: readonly Problem[] }) {
    const mine = problems.filter((p) => p.field === field);
    if (mine.length === 0) return null;
    return (
        <div data-problem={field} className="mt-1 text-xs text-[var(--danger)]">
            {mine.map((p) => <div key={p.message}>{p.message}</div>)}
        </div>
    );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">{label}</span>
            {children}
        </label>
    );
}

export interface AddSiteFormProps {
    readonly defaults: SiteFormDefaults;
    readonly existingHosts: readonly string[];
    readonly problems: readonly Problem[];
    readonly onSubmit: (form: { name: string; mode: SiteMode; command: string; hostPort: number | null; root: string | null; spa: boolean }) => void;
    readonly onCancel: () => void;
}

export function AddSiteForm({ defaults, problems, onSubmit, onCancel }: AddSiteFormProps) {
    return (
        <form
            data-form="add-site"
            className="flex flex-col gap-4 p-5"
            onSubmit={(e) => {
                e.preventDefault();
                const data = new FormData(e.currentTarget);
                const port = String(data.get('hostPort') ?? '').trim();
                onSubmit({
                    name: String(data.get('name') ?? ''),
                    mode: (String(data.get('mode') ?? 'proxy') as SiteMode),
                    command: String(data.get('command') ?? ''),
                    hostPort: port === '' ? null : Number(port),
                    root: String(data.get('root') ?? '') || null,
                    spa: data.get('spa') === 'on',
                });
            }}
        >
            <p className="text-sm text-[var(--fg-3)]">{defaults.hint}</p>
            <Row label="Name">
                <Input name="name" defaultValue={defaults.name} placeholder="tynn" />
                <ProblemLine field="name" problems={problems} />
            </Row>
            <Row label="Serve mode">
                <select name="mode" defaultValue={defaults.mode} className="rounded-md border border-[var(--border-1)] bg-[var(--bg-1)] px-2 py-1 text-sm">
                    <option value="proxy">proxy — the repo’s own dev server, or a port you run</option>
                    <option value="static">static — a built directory</option>
                    <option value="php">php — public/ behind a FastCGI worker</option>
                </select>
            </Row>
            <Row label="Dev server command ({port} is the free port Genie picks)">
                <Input name="command" defaultValue={defaults.devServer?.command ?? ''} placeholder="npm run dev -- --port {port}" />
            </Row>
            <Row label="Or a port you already run on">
                <Input name="hostPort" type="number" defaultValue={defaults.hostPort === null ? '' : String(defaults.hostPort)} placeholder="5173" />
                <ProblemLine field="hostPort" problems={problems} />
            </Row>
            <Row label="Root (static: the built directory; php: public)">
                <Input name="root" defaultValue={defaults.root ?? ''} placeholder="dist" />
                <ProblemLine field="root" problems={problems} />
            </Row>
            <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="spa" defaultChecked={defaults.spa} />
                Single-page app — serve index.html for unknown paths
            </label>
            <div className="flex gap-2">
                <button type="submit" className="rounded-lg bg-[var(--primary)] px-3 py-1.5 text-sm text-white">Add site</button>
                <button type="button" onClick={onCancel} className="rounded-lg border border-[var(--border-1)] px-3 py-1.5 text-sm">Cancel</button>
            </div>
        </form>
    );
}

export interface AddFlowFormProps {
    readonly defaults: FlowForm;
    readonly problems: readonly Problem[];
    readonly onSubmit: (form: FlowForm) => void;
    readonly onCancel: () => void;
}

function cronOf(form: FlowForm): string {
    const doc = form.document as { nodes?: Array<{ kind: string; config?: Record<string, unknown> }> };
    const trigger = doc.nodes?.find((n) => /(^|\/)schedule_trigger$/.test(n.kind));
    return typeof trigger?.config?.cron === 'string' ? trigger.config.cron : '';
}

function withCron(form: FlowForm, cron: string): FlowForm {
    const doc = structuredClone(form.document) as { nodes?: Array<{ kind: string; config?: Record<string, unknown> }> };
    for (const n of doc.nodes ?? []) if (/(^|\/)schedule_trigger$/.test(n.kind)) n.config = { ...(n.config ?? {}), cron };
    return { ...form, document: doc };
}

export function AddFlowForm({ defaults, problems, onSubmit, onCancel }: AddFlowFormProps) {
    return (
        <form
            data-form="add-flow"
            className="flex flex-col gap-4 p-5"
            onSubmit={(e) => {
                e.preventDefault();
                const data = new FormData(e.currentTarget);
                onSubmit({ ...withCron(defaults, String(data.get('cron') ?? '')), name: String(data.get('name') ?? ''), armed: data.get('armed') === 'on' });
            }}
        >
            <p className="text-sm text-[var(--fg-3)]">A schedule and the work it runs. You can edit the full graph on the canvas afterwards.</p>
            <Row label="Name">
                <Input name="name" defaultValue={defaults.name} />
                <ProblemLine field="name" problems={problems} />
            </Row>
            <Row label="Schedule (cron, five fields, UTC)">
                <Input name="cron" defaultValue={cronOf(defaults)} placeholder="0 * * * *" />
                <ProblemLine field="cron" problems={problems} />
                <ProblemLine field="timezone" problems={problems} />
            </Row>
            <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="armed" defaultChecked={defaults.armed} />
                Arm now — the schedule starts firing. Off by default; an agent can create a flow but only you can arm it.
            </label>
            <div className="flex gap-2">
                <button type="submit" className="rounded-lg bg-[var(--primary)] px-3 py-1.5 text-sm text-white">Add flow</button>
                <button type="button" onClick={onCancel} className="rounded-lg border border-[var(--border-1)] px-3 py-1.5 text-sm">Cancel</button>
            </div>
        </form>
    );
}
