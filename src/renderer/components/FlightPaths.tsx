import { useId } from 'react';
import type { Arc, Point } from '../../core/flight-arcs.js';

/**
 * THE COMMS FLIGHT PATHS, DRAWN (Tynn #750, option D). One raised arch per conversation over the board, from the pointer on
 * the hovered Comms cell to the partner's name: a gradient stroke, a soft shadow below it, glowing dots running the way the
 * last message went (static arrows under reduced motion), a pulse where unread mail waits. Never takes a click
 * (`pointer-events-none`) and never clips (`overflow-visible`, above the table). Mounted only while a Comms cell is hovered.
 */
const TONE: Record<Arc['tone'], string> = { flow: 'var(--violet-400)', waiting: 'var(--warning)' };
const DOTS = 3;

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
                <filter id={`${uid}-blur`} x="-20%" y="-60%" width="140%" height="220%"><feGaussianBlur stdDeviation="3" /></filter>
                <filter id={`${uid}-glow`} x="-200%" y="-200%" width="500%" height="500%"><feGaussianBlur stdDeviation="1.2" /></filter>
                {arcs.map((arc, n) => (
                    <linearGradient key={arc.peer} id={`${uid}-g-${n}`} gradientUnits="userSpaceOnUse" x1={arc.start.x} y1={arc.start.y} x2={arc.end.x} y2={arc.end.y}>
                        <stop offset="0" style={{ stopColor: TONE[arc.tone], stopOpacity: 0.45 }} />
                        <stop offset="1" style={{ stopColor: TONE[arc.tone], stopOpacity: 1 }} />
                    </linearGradient>
                ))}
            </defs>
            <style>{'@keyframes genie-arc-pulse{0%{transform:scale(.6);opacity:.95}100%{transform:scale(2.6);opacity:0}}'}</style>
            {arcs.map((arc, n) => {
                const color = TONE[arc.tone];
                const pathId = `${uid}-p-${n}`;
                const dur = Math.max(1.4, 1.1 + Math.log(arc.ageSeconds / 60 + 1) * 0.5 + arc.dist * 0.12);
                return (
                    <g key={arc.peer} data-flight-arc="" data-peer={arc.peer} data-tone={arc.tone} data-direction={arc.direction} opacity={arc.opacity}>
                        <path d={arc.d} fill="none" stroke="#000" strokeWidth={arc.width + 4} opacity={0.6} filter={`url(#${uid}-blur)`} transform="translate(0,16)" />
                        <path id={pathId} data-arc-main="" d={arc.d} fill="none" stroke={`url(#${uid}-g-${n})`} strokeWidth={arc.width} strokeLinecap="round" style={{ filter: 'drop-shadow(0 0 3px color-mix(in srgb, var(--violet-400) 40%, transparent))' }} />
                        {reducedMotion ? (
                            <path data-arc-arrow="" d="M-6,-4.5 L4,0 L-6,4.5 z" style={{ fill: color }} transform={`translate(${arc.arrow.x},${arc.arrow.y}) rotate(${arc.arrow.angle})`} />
                        ) : (
                            <g filter={`url(#${uid}-glow)`}>
                                {Array.from({ length: DOTS }, (_, k) => (
                                    <circle key={k} data-arc-dot="" r={2.8} style={{ fill: arc.tone === 'waiting' ? 'var(--warning)' : 'var(--violet-300, var(--violet-400))' }}>
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
                                style={{ fill: color, paintOrder: 'stroke', stroke: 'var(--bg-1)', strokeWidth: 3 }}
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
