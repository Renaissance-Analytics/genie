/**
 * TYNN'S MARK (genie#1295) — ported from Genie 1 (v0.7.0-beta.342, `renderer/components/Master/icons.tsx` `IconTynn`): the
 * three-stroke logo traced from tynn's public/tynn-icon.svg, one monochrome `currentColor` glyph so it takes the theme's
 * text colour in light and dark. Tynn is shown by its logo, not its name (the owner: logos over words); the name is the
 * accessible name, so dropping the word costs a screen reader nothing.
 */
export function TynnLogo({ size = 14, className = '' }: { size?: number; className?: string }) {
    return (
        <span role="img" aria-label="Tynn" title="Tynn" data-tynn-logo="" className={`inline-flex shrink-0 items-center justify-center ${className}`.trim()}>
            <svg width={size} height={size} viewBox="0 0 1500 1500" fill="none" stroke="currentColor" strokeWidth={70} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M962.08,450.64c26.96-50.68,62.84-108.34,110.55-167.67c80.73-100.4,166.44-169.65,234.12-215.58c5.1,22.03,11.86,53.89,17.85,92.59c11.09,71.64,25.34,163.69,11.52,271.31c-6.9,53.76-23.91,135.52-70.94,229.4" />
                <path d="M542.9,450.18c-28.99-51.07-66.56-108.36-115.15-167.21c-80.88-97.96-165.33-167.62-234.12-215.58c-5.1,22.03-11.86,53.89-17.85,92.59c-10.49,67.77-24.84,160.76-11.52,271.31c6.64,55.07,22.96,137.82,67.71,233.08" />
                <path d="M28.48,926.25c14.77-20.61,37.59-51.77,66.68-88.67c143.57-182.15,241.74-306.7,400.75-370.81c102.56-41.35,194.77-41.73,244.65-41.99c49.64-0.26,154.54,0.19,271.92,49.12c134.77,56.18,213.88,146.2,315.34,261.65c66.3,75.45,113.63,143.49,143.69,190.08c-42.74,0.89-104.56,6.47-174.79,28.96c-39.24,12.56-130.75,46.3-219.49,124.37c-175.18,154.1-180.54,341.01-313.92,353.08c-11.94,1.08-20.85,0.39-24.87,0c-114.89-11.24-127.67-164.71-273.25-312.69c-36.97-37.57-108.15-100.86-212.49-144.49C163.48,937.54,82.49,928.19,28.48,926.25z" />
            </svg>
        </span>
    );
}
