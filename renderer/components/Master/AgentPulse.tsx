import type { CSSProperties } from 'react';
import {
    AGENT_PULSE_MARKER_KINDS,
    type AgentPulseMarkerBucket,
    type AgentPulseMarkerKind,
} from '../../../main/terminal/agent-pulse';

/**
 * The AgentPulse a workspace row draws: the byte sparkline, and the inbox /
 * automation markers layered over it.
 *
 * ## Why the markers are a SEPARATE layer, in this module
 *
 * The sparkline is pty OUTPUT. Every moment the markers describe happens with
 * ZERO bytes — a delivery is a broker event, an inbox read and a reply are MCP
 * calls, a raised question and a hand-run flow are main-process calls. So the two
 * cannot be one drawing: `AgentPulseSparkline` bails on an all-zero ring, and an
 * idle agent receiving a message, reading it and answering produces exactly that
 * ring. A marker layer that inherited the early-out would be invisible in the
 * situation it exists for.
 *
 * They live in ONE module (owner, 2026-09-06: "put it in the agent pulse
 * component though so that is easily reusable and not duplicated code") so the
 * pair moves together and a second row surface gets both by importing {@link
 * AgentPulse} rather than re-deriving the geometry.
 *
 * ## The geometry, and why the markers are not SVG
 *
 * The sparkline is a 100×100 viewBox with `preserveAspectRatio="none"` — it is
 * MEANT to stretch to whatever width the row is. A glyph inside that same SVG
 * would stretch with it, so a diamond becomes a lozenge on a wide window. The
 * markers are therefore absolutely-positioned DOM at `left: <pct>%`, which keeps
 * each shape's own geometry while still landing on the sparkline's time axis.
 */

/** Slots in a ring — one second each, index 59 = the current second. */
const BUCKET_COUNT = 60;

/**
 * What each kind looks like, and what it is called.
 *
 * A TABLE, deliberately: more kinds are expected (owner), and this is the row a
 * sixth one costs. `AgentPulseMarkerLayer` iterates
 * {@link AGENT_PULSE_MARKER_KINDS} — the model's own list — so a kind added to
 * the model without a row here fails the render test instead of quietly drawing
 * nothing.
 */
const GLYPH: Record<AgentPulseMarkerKind, { label: string; className: string }> = {
    delivered: { label: 'delivered', className: 'apm-diamond' },
    checked: { label: 'checked', className: 'apm-dot' },
    replied: { label: 'replied', className: 'apm-triangle' },
    question: { label: 'asked a question', className: 'apm-question' },
    'flow-run': { label: 'ran a flow', className: 'apm-flow' },
};

/** The glyph body. `?` and `!` are text; the rest are CSS shapes. */
const GLYPH_TEXT: Partial<Record<AgentPulseMarkerKind, string>> = {
    question: '?',
    'flow-run': '!',
};

export interface AgentPulseMarkerLayerProps {
    /** 60 slots, oldest→newest; `null` for a second in which nothing happened. */
    markers?: (AgentPulseMarkerBucket | null)[] | null;
}

/**
 * The markers alone — every kind that landed in each second, stacked.
 *
 * ## What happens when several land in one slot
 *
 * A slot is one second and a few pixels. Two rules keep that from losing
 * anything:
 *
 * - **Different kinds stack**, in {@link AGENT_PULSE_MARKER_KINDS} order, so a
 *   slot reads the same way every time and no kind is displaced by another.
 * - **A repeated kind draws once and CARRIES ITS COUNT** — `data-count`, and the
 *   title says "3 delivered". Three diamonds cannot be told apart at this size,
 *   so the second and third are deliberately not drawn; the count is what makes
 *   that a collapse rather than a disappearance. Nothing is dropped silently.
 */
export function AgentPulseMarkerLayer({ markers }: AgentPulseMarkerLayerProps) {
    if (!markers || markers.length === 0) return null;
    const filled = markers
        .map((bucket, i) => ({ bucket, i }))
        .filter((s): s is { bucket: AgentPulseMarkerBucket; i: number } => !!s.bucket);
    if (filled.length === 0) return null;

    const span = markers.length > 1 ? markers.length - 1 : 1;

    return (
        <span className="agent-pulse-markers">
            {filled.map(({ bucket, i }) => {
                const kinds = AGENT_PULSE_MARKER_KINDS.filter((k) => (bucket[k] ?? 0) > 0);
                if (kinds.length === 0) return null;
                const left = `${((i / span) * 100).toFixed(2).replace(/\.?0+$/, '')}%`;
                return (
                    <span className="apm-slot" key={i} style={{ left } as CSSProperties}>
                        {kinds.map((kind) => {
                            const count = bucket[kind] ?? 0;
                            const { label, className } = GLYPH[kind];
                            return (
                                <i
                                    key={kind}
                                    className={`apm ${className}`}
                                    data-marker={kind}
                                    data-count={count}
                                    title={count > 1 ? `${count} ${label}` : label}
                                >
                                    {GLYPH_TEXT[kind] ?? ''}
                                </i>
                            );
                        })}
                    </span>
                );
            })}
        </span>
    );
}

export interface AgentPulseSparklineProps {
    ring?: number[];
    active: boolean;
}

/**
 * The 1-minute byte trace.
 *
 * Moved here verbatim from `Chooser.tsx` so it sits beside the layer that draws
 * over it. `max <= 0` still returns null — a workspace that produced no output
 * has no trace to draw, and inventing a flat line would say "quiet" where the
 * truth is "nothing". The MARKERS are what now render in that case, which is why
 * {@link AgentPulse} composes the two rather than nesting one inside the other.
 */
export function AgentPulseSparkline({ ring, active }: AgentPulseSparklineProps) {
    if (!ring || ring.length === 0) return null;
    const max = Math.max(...ring);
    if (max <= 0) return null;

    const w = 100;
    const h = 100;
    const n = ring.length;
    const step = n > 1 ? w / (n - 1) : w;
    const pts = ring.map((v, i) => {
        const x = i * step;
        const y = h - (v / max) * (h - 6) - 3;
        return `${x.toFixed(2)},${y.toFixed(2)}`;
    });
    const line = pts.join(' ');
    const area = `0,${h} ${line} ${w},${h}`;

    return (
        <svg
            className={`agent-pulse-spark${active ? ' active' : ''}`}
            viewBox={`0 0 ${w} ${h}`}
            preserveAspectRatio="none"
            aria-hidden="true"
        >
            <polygon className="aps-fill" points={area} />
            <polyline className="aps-line" points={line} />
        </svg>
    );
}

export interface AgentPulseProps extends AgentPulseSparklineProps, AgentPulseMarkerLayerProps {}

/**
 * Both layers — what a workspace row actually mounts.
 *
 * COMPOSED rather than nested so each half decides for itself whether it has
 * anything to say. A row with markers and no output draws the markers; a row with
 * output and no markers draws the trace; a row with neither renders nothing at
 * all, which is what keeps an idle workspace visually quiet.
 */
export function AgentPulse({ ring, markers, active }: AgentPulseProps) {
    return (
        <>
            <AgentPulseSparkline ring={ring} active={active} />
            <AgentPulseMarkerLayer markers={markers} />
        </>
    );
}

export { BUCKET_COUNT as AGENT_PULSE_BUCKETS };
