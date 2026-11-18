import { useId, type CSSProperties } from 'react';
import type { Arc, Point } from '../../core/flight-arcs.js';

/**
 * THE COMMS FLIGHT PATHS, DRAWN (Tynn #750, option D). One raised arch per conversation over the board, from the pointer on
 * the hovered Comms cell to the partner's name: a gradient stroke, its shadow on the ground (from the same two contact
 * points, thin and faint, no blur), glowing dots running the way the last message went (static arrows under reduced
 * motion), a pulse where unread mail waits. Never takes a click (`pointer-events-none`) and never clips
 * (`overflow-visible`, above the table). Mounted only while a Comms cell is hovered.
 *
 * COLOUR (owner 2026-11-17): each arc, its dots and its label are in the SENDING agent's workspace colour, as
 * `arc.paint` gives it per theme; the stylesheet below picks the theme's (`--arc`, `--arc-text`). A sender with no
 * colour keeps the old violet. A thread waiting on an answer is DASHED, now that colour says who sent.
 */
const FALLBACK = 'var(--violet-400)';
const DOTS = 3;
const THEME_CSS =
    '[data-flight-arc]{--arc:var(--arc-light);--arc-text:var(--arc-text-light)}' +
    ':is(.dark,[data-theme="dark"]) [data-flight-arc]{--arc:var(--arc-dark);--arc-text:var(--arc-text-dark)}' +
    '@keyframes genie-arc-pulse{0%{transform:scale(.6);opacity:.95}100%{transform:scale(2.6);opacity:0}}';

/** The arc's colours as CSS variables on its group: everything inside reads `var(--arc)` / `var(--arc-text)`. */
function arcVars(arc: Arc): CSSProperties {
    const p = arc.paint;
    return {
        '--arc-light': p?.light.stroke ?? FALLBACK,
        '--arc-dark': p?.dark.stroke ?? FALLBACK,
        '--arc-text-light': p?.light.text ?? FALLBACK,
        '--arc-text-dark': p?.dark.text ?? FALLBACK,
    } as CSSProperties;
}

export function FlightPaths({ arcs, size, pointer, reducedMotion }: { arcs: readonly Arc[]; size: { width: number; height: number }; pointer: Point; reducedMotion: boolean }) {
    const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
    return (
        <svg
            data-flight-paths=""
            data-motion={reducedMotion ? 'reduced' : 'full'}
            aria-hidden="true"
            width={size.width}
            height={size.height}
            className="pointer-events-none absolute left-0 top-0 z-20 overflow-visible"
        >
            <defs>
                <filter id={`${uid}-glow`} x="-200%" y="-200%" width="500%" height="500%"><feGaussianBlur stdDeviation="1.2" /></filter>
            </defs>
            <style>{THEME_CSS}</style>
            {arcs.map((arc, n) => {
                const color = 'var(--arc)';
                const pathId = `${uid}-p-${n}`;
                const dur = Math.max(1.4, 1.1 + Math.log(arc.ageSeconds / 60 + 1) * 0.5 + arc.dist * 0.12);
                return (
                    <g key={arc.peer} data-flight-arc="" data-peer={arc.peer} data-tone={arc.tone} data-direction={arc.direction} data-arc-color={arc.color ?? undefined} opacity={arc.opacity} style={arcVars(arc)}>
                        {/* Inside the arc's group, so its stops inherit the arc's colour variables. */}
                        <defs>
                            <linearGradient id={`${uid}-g-${n}`} gradientUnits="userSpaceOnUse" x1={arc.start.x} y1={arc.start.y} x2={arc.end.x} y2={arc.end.y}>
                                <stop offset="0" style={{ stopColor: 'var(--arc)', stopOpacity: 0.55 }} />
                                <stop offset="1" style={{ stopColor: 'var(--arc)', stopOpacity: 1 }} />
                            </linearGradient>
                        </defs>
                        <path data-arc-shadow="" d={arc.shadow.d} fill="none" stroke="#000" strokeWidth={arc.shadow.width} strokeOpacity={arc.shadow.opacity} strokeLinecap="round" />
                        <path id={pathId} data-arc-main="" d={arc.d} fill="none" stroke={`url(#${uid}-g-${n})`} strokeWidth={arc.width} strokeLinecap="round" strokeDasharray={arc.tone === 'waiting' ? '6 4' : undefined} />
                        {reducedMotion ? (
                            <path data-arc-arrow="" d="M-6,-4.5 L4,0 L-6,4.5 z" style={{ fill: color }} transform={`translate(${arc.arrow.x},${arc.arrow.y}) rotate(${arc.arrow.angle})`} />
                        ) : (
                            <g filter={`url(#${uid}-glow)`}>
                                {Array.from({ length: DOTS }, (_, k) => (
                                    <circle key={k} data-arc-dot="" r={2.8} style={{ fill: 'var(--arc)' }}>
                                        <animateMotion
                                            dur={`${dur}s`}
                                            repeatCount="indefinite"
                                            begin={`${(-dur * k) / DOTS}s`}
                                            {...(arc.direction === 'in' ? { keyPoints: '1;0', keyTimes: '0;1', calcMode: 'linear' } : {})}
                                        >
                                            <mpath href={`#${pathId}`} />
                                        </animateMotion>
                                    </circle>
                                ))}
                            </g>
                        )}
                        {arc.pulseAt ? (
                            <g data-arc-pulse="">
                                {reducedMotion ? null : <circle cx={arc.pulseAt.x} cy={arc.pulseAt.y} r={4.5} style={{ fill: 'var(--success)', transformBox: 'fill-box', transformOrigin: 'center', animation: 'genie-arc-pulse 1.6s ease-out infinite' }} />}
                                <circle cx={arc.pulseAt.x} cy={arc.pulseAt.y} r={3.2} style={{ fill: 'var(--success)' }} />
                            </g>
                        ) : null}
                        <circle cx={arc.end.x} cy={arc.end.y} r={3} style={{ fill: color }} />
                        {arc.label ? (
                            <text
                                data-arc-label=""
                                data-x={arc.label.x}
                                data-y={arc.label.y}
                                data-w={arc.label.w}
                                data-h={arc.label.h}
                                x={arc.label.x}
                                y={arc.label.y}
                                fontSize={10.5}
                                fontFamily="var(--font-mono, ui-monospace, monospace)"
                                style={{ fill: 'var(--arc-text)', paintOrder: 'stroke', stroke: 'var(--bg-1)', strokeWidth: 3 }}
                            >
                                {arc.label.text}
                            </text>
                        ) : null}
                    </g>
                );
            })}
            <circle data-arc-origin="" cx={pointer.x} cy={pointer.y} r={9} fill="none" strokeWidth={1.4} opacity={0.9} style={{ stroke: 'var(--violet-400)' }} />
        </svg>
    );
}
