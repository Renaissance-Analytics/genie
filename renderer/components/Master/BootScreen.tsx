/**
 * BootScreen — the magical loading screen shown while Genie initializes, before
 * the workspace UI is ready. Covers the gap between the window appearing (its
 * native backgroundColor is already brand-dark, so no white flash) and the
 * renderer being ready, then fades out.
 *
 * On-brand "magic lamp / sparkles" motif on Tynn's sky→indigo→violet gradient
 * (#7dd3fc → #818cf8 → #c4b5fd — same palette as the marketing page + update
 * banner). All CSS / inline SVG + Web-Animations-friendly keyframes — no library,
 * no shipped asset. Respects dark/light via the document's `.dark` class.
 *
 * It is purely presentational: it never gates real readiness. The host renders
 * it while `!ready` and unmounts it (with a CSS fade) once ready.
 */
export default function BootScreen({ fadingOut = false }: { fadingOut?: boolean }) {
    return (
        <div className={`boot-screen${fadingOut ? ' boot-fade' : ''}`} role="status" aria-label="Genie is starting">
            {/* Soft gradient aura behind the mark. */}
            <div className="boot-aura" aria-hidden />

            <div className="boot-stage">
                <svg
                    className="boot-mark"
                    viewBox="0 0 96 96"
                    width="96"
                    height="96"
                    fill="none"
                    aria-hidden
                >
                    <defs>
                        <linearGradient id="boot-grad" x1="0" y1="0" x2="96" y2="96" gradientUnits="userSpaceOnUse">
                            <stop offset="0" stopColor="#7dd3fc" />
                            <stop offset="0.5" stopColor="#818cf8" />
                            <stop offset="1" stopColor="#c4b5fd" />
                        </linearGradient>
                    </defs>
                    {/* A stylised genie lamp. */}
                    <g stroke="url(#boot-grad)" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
                        {/* lamp body */}
                        <path d="M20 64 q28 16 56 0 q4 -18 -12 -22 q-16 -4 -32 0 q-16 4 -12 22 Z" />
                        {/* spout */}
                        <path d="M70 50 q14 -2 18 4 q-6 4 -16 2" />
                        {/* lid + knob */}
                        <path d="M40 42 q8 -6 16 0" />
                        <circle cx="48" cy="33" r="3.2" fill="url(#boot-grad)" stroke="none" />
                    </g>
                    {/* escaping "magic" wisp from the spout */}
                    <path
                        className="boot-wisp"
                        d="M86 52 q8 -10 2 -18 q10 -2 8 -14"
                        stroke="url(#boot-grad)"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        fill="none"
                    />
                </svg>

                {/* Sparkles that twinkle around the lamp. */}
                <span className="boot-spark boot-spark-1" aria-hidden />
                <span className="boot-spark boot-spark-2" aria-hidden />
                <span className="boot-spark boot-spark-3" aria-hidden />
                <span className="boot-spark boot-spark-4" aria-hidden />
            </div>

            <div className="boot-word">
                Genie
                {/* gradient shimmer sweep across the wordmark */}
                <span className="boot-shimmer" aria-hidden />
            </div>
            <div className="boot-sub">conjuring your workspace…</div>
        </div>
    );
}
