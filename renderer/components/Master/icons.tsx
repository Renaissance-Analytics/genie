/**
 * Tiny inline SVG icons used across the master workspace chrome. Kept
 * inline (vs pulling a Lucide bundle) so the master window stays light
 * and renders without a network fetch on first paint.
 */
import React from 'react';

interface Props {
    size?: number;
    className?: string;
    style?: React.CSSProperties;
}

const wrap = (size: number, children: React.ReactNode, className?: string, style?: React.CSSProperties) => (
    <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={className}
        style={style}
        aria-hidden="true"
    >
        {children}
    </svg>
);

export const IconChevronDown = ({ size = 15, ...p }: Props) =>
    wrap(size, <polyline points="6 9 12 15 18 9" />, p.className, p.style);
export const IconAlert = ({ size = 14, ...p }: Props) =>
    wrap(
        size,
        <>
            <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
        </>,
        p.className,
        p.style,
    );
export const IconPanelLeftOpen = ({ size = 18, ...p }: Props) =>
    wrap(
        size,
        <>
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <path d="M9 3v18" />
            <path d="M14 10l3 2-3 2" />
        </>,
        p.className,
        p.style,
    );
export const IconPin = ({ size = 15, ...p }: Props) =>
    wrap(
        size,
        <>
            <line x1="12" y1="17" x2="12" y2="22" />
            <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V17z" />
        </>,
        p.className,
        p.style,
    );
export const IconSearch = ({ size = 14, ...p }: Props) =>
    wrap(
        size,
        <>
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </>,
        p.className,
        p.style,
    );
export const IconBox = ({ size = 14, ...p }: Props) =>
    wrap(
        size,
        <>
            <path d="M21 8a2 2 0 0 0-1.06-1.76L13 2.18a2 2 0 0 0-2 0L4.06 6.24A2 2 0 0 0 3 8v8a2 2 0 0 0 1.06 1.76L11 21.82a2 2 0 0 0 2 0l6.94-4.06A2 2 0 0 0 21 16z" />
            <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
            <line x1="12" y1="22.08" x2="12" y2="12" />
        </>,
        p.className,
        p.style,
    );
export const IconCpu = ({ size = 18, ...p }: Props) =>
    wrap(
        size,
        <>
            <rect x="4" y="4" width="16" height="16" rx="2" />
            <rect x="9" y="9" width="6" height="6" />
            <line x1="9" y1="2" x2="9" y2="4" />
            <line x1="15" y1="2" x2="15" y2="4" />
            <line x1="9" y1="20" x2="9" y2="22" />
            <line x1="15" y1="20" x2="15" y2="22" />
            <line x1="20" y1="9" x2="22" y2="9" />
            <line x1="20" y1="15" x2="22" y2="15" />
            <line x1="2" y1="9" x2="4" y2="9" />
            <line x1="2" y1="15" x2="4" y2="15" />
        </>,
        p.className,
        p.style,
    );
/** Home / system glyph — roots the synthetic System Workspace (a house). */
export const IconHome = ({ size = 18, ...p }: Props) =>
    wrap(
        size,
        <>
            <path d="M3 10.5 12 3l9 7.5" />
            <path d="M5 9.5V20a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9.5" />
            <path d="M9 21v-6h6v6" />
        </>,
        p.className,
        p.style,
    );
export const IconTerminal = ({ size = 18, ...p }: Props) =>
    wrap(
        size,
        <>
            <polyline points="4 17 10 11 4 5" />
            <line x1="12" y1="19" x2="20" y2="19" />
        </>,
        p.className,
        p.style,
    );
export const IconGlobe = ({ size = 18, ...p }: Props) =>
    wrap(
        size,
        <>
            <circle cx="12" cy="12" r="10" />
            <line x1="2" y1="12" x2="22" y2="12" />
            <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
        </>,
        p.className,
        p.style,
    );
export const IconPlus = ({ size = 14, ...p }: Props) =>
    wrap(
        size,
        <>
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
        </>,
        p.className,
        p.style,
    );
export const IconCheck = ({ size = 11, ...p }: Props) =>
    wrap(size, <polyline points="20 6 9 17 4 12" />, p.className, p.style);
export const IconWrap = ({ size = 14, ...p }: Props) =>
    wrap(
        size,
        <>
            <line x1="3" y1="6" x2="21" y2="6" />
            <path d="M3 12h15a3 3 0 0 1 0 6h-4" />
            <polyline points="16 16 14 18 16 20" />
            <line x1="3" y1="18" x2="10" y2="18" />
        </>,
        p.className,
        p.style,
    );
export const IconEye = ({ size = 13, ...p }: Props) =>
    wrap(
        size,
        <>
            <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
            <circle cx="12" cy="12" r="3" />
        </>,
        p.className,
        p.style,
    );
export const IconEyeOff = ({ size = 13, ...p }: Props) =>
    wrap(
        size,
        <>
            <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c6.5 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
            <path d="M6.61 6.61A13.5 13.5 0 0 0 2 12s3.5 7 10 7a9.12 9.12 0 0 0 5.39-1.61" />
            <line x1="2" y1="2" x2="22" y2="22" />
        </>,
        p.className,
        p.style,
    );
export const IconLayoutGrid = ({ size = 15, ...p }: Props) =>
    wrap(
        size,
        <>
            <rect x="3" y="3" width="7" height="7" />
            <rect x="14" y="3" width="7" height="7" />
            <rect x="3" y="14" width="7" height="7" />
            <rect x="14" y="14" width="7" height="7" />
        </>,
        p.className,
        p.style,
    );
export const IconPanelLeft = ({ size = 15, ...p }: Props) =>
    wrap(
        size,
        <>
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <line x1="9" y1="3" x2="9" y2="21" />
        </>,
        p.className,
        p.style,
    );
export const IconColumns = ({ size = 15, ...p }: Props) =>
    wrap(
        size,
        <>
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <line x1="9" y1="3" x2="9" y2="21" />
            <line x1="15" y1="3" x2="15" y2="21" />
        </>,
        p.className,
        p.style,
    );
export const IconMaximize = ({ size = 16, ...p }: Props) =>
    wrap(
        size,
        <>
            <polyline points="15 3 21 3 21 9" />
            <polyline points="9 21 3 21 3 15" />
            <line x1="21" y1="3" x2="14" y2="10" />
            <line x1="3" y1="21" x2="10" y2="14" />
        </>,
        p.className,
        p.style,
    );
export const IconMinimize = ({ size = 14, ...p }: Props) =>
    wrap(
        size,
        <>
            <polyline points="4 14 10 14 10 20" />
            <polyline points="20 10 14 10 14 4" />
            <line x1="14" y1="10" x2="21" y2="3" />
            <line x1="3" y1="21" x2="10" y2="14" />
        </>,
        p.className,
        p.style,
    );
export const IconX = ({ size = 14, ...p }: Props) =>
    wrap(
        size,
        <>
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
        </>,
        p.className,
        p.style,
    );
export const IconSettings = ({ size = 16, ...p }: Props) =>
    wrap(
        size,
        <>
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </>,
        p.className,
        p.style,
    );
export const IconHelp = ({ size = 16, ...p }: Props) =>
    wrap(
        size,
        <>
            <circle cx="12" cy="12" r="10" />
            <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
        </>,
        p.className,
        p.style,
    );
export const IconTrash = ({ size = 13, ...p }: Props) =>
    wrap(
        size,
        <>
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
            <path d="M10 11v6" />
            <path d="M14 11v6" />
            <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
        </>,
        p.className,
        p.style,
    );
export const IconCode = ({ size = 14, ...p }: Props) =>
    wrap(
        size,
        <>
            <polyline points="16 18 22 12 16 6" />
            <polyline points="8 6 2 12 8 18" />
        </>,
        p.className,
        p.style,
    );
export const IconCopy = ({ size = 14, ...p }: Props) =>
    wrap(
        size,
        <>
            <rect x="9" y="9" width="13" height="13" rx="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </>,
        p.className,
        p.style,
    );
export const IconLock = ({ size = 13, ...p }: Props) =>
    wrap(
        size,
        <>
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </>,
        p.className,
        p.style,
    );
export const IconUnlock = ({ size = 13, ...p }: Props) =>
    wrap(
        size,
        <>
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
            <path d="M7 11V7a5 5 0 0 1 9.9-1" />
        </>,
        p.className,
        p.style,
    );
export const IconListTree = ({ size = 14, ...p }: Props) =>
    wrap(
        size,
        <>
            <path d="M21 12h-8" />
            <path d="M21 6h-8" />
            <path d="M21 18h-8" />
            <path d="M3 6v4c0 1.1.9 2 2 2h3" />
            <path d="M3 10v6c0 1.1.9 2 2 2h3" />
        </>,
        p.className,
        p.style,
    );
/** Suspend / disable (keep running, hide panel) — Tier 2. */
export const IconPause = ({ size = 13, ...p }: Props) =>
    wrap(
        size,
        <>
            <rect x="6" y="4" width="4" height="16" rx="1" />
            <rect x="14" y="4" width="4" height="16" rx="1" />
        </>,
        p.className,
        p.style,
    );
/** Resume / enable a suspended view — Tier 2. */
export const IconPlay = ({ size = 13, ...p }: Props) =>
    wrap(size, <polygon points="6 4 20 12 6 20 6 4" />, p.className, p.style);
/** Restart / relaunch — circular arrows. */
export const IconRefresh = ({ size = 13, ...p }: Props) =>
    wrap(
        size,
        <>
            <path d="M23 4v6h-6" />
            <path d="M1 20v-6h6" />
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
        </>,
        p.className,
        p.style,
    );
/**
 * Tynn brand mark — the abstract three-stroke logo (a teardrop body with two
 * rising antennae). Traced from public/tynn-icon.svg in the tynn repo and
 * flattened to a single monochrome `currentColor` glyph so it fits the inline
 * rail-icon convention (no asset fetch, themes via colour). Keeps the source's
 * 1500-unit viewBox; stroke width is tuned to read at ~12–14px.
 */
export const IconTynn = ({ size = 13, ...p }: Props) => (
    <svg
        width={size}
        height={size}
        viewBox="0 0 1500 1500"
        fill="none"
        stroke="currentColor"
        strokeWidth={70}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={p.className}
        style={p.style}
        aria-hidden="true"
    >
        <path d="M962.08,450.64c26.96-50.68,62.84-108.34,110.55-167.67c80.73-100.4,166.44-169.65,234.12-215.58c5.1,22.03,11.86,53.89,17.85,92.59c11.09,71.64,25.34,163.69,11.52,271.31c-6.9,53.76-23.91,135.52-70.94,229.4" />
        <path d="M542.9,450.18c-28.99-51.07-66.56-108.36-115.15-167.21c-80.88-97.96-165.33-167.62-234.12-215.58c-5.1,22.03-11.86,53.89-17.85,92.59c-10.49,67.77-24.84,160.76-11.52,271.31c6.64,55.07,22.96,137.82,67.71,233.08" />
        <path d="M28.48,926.25c14.77-20.61,37.59-51.77,66.68-88.67c143.57-182.15,241.74-306.7,400.75-370.81c102.56-41.35,194.77-41.73,244.65-41.99c49.64-0.26,154.54,0.19,271.92,49.12c134.77,56.18,213.88,146.2,315.34,261.65c66.3,75.45,113.63,143.49,143.69,190.08c-42.74,0.89-104.56,6.47-174.79,28.96c-39.24,12.56-130.75,46.3-219.49,124.37c-175.18,154.1-180.54,341.01-313.92,353.08c-11.94,1.08-20.85,0.39-24.87,0c-114.89-11.24-127.67-164.71-273.25-312.69c-36.97-37.57-108.15-100.86-212.49-144.49C163.48,937.54,82.49,928.19,28.48,926.25z" />
    </svg>
);
/** Drag handle (six dots) — reorder affordance. */
export const IconGrip = ({ size = 12, ...p }: Props) =>
    wrap(
        size,
        <>
            <circle cx="9" cy="6" r="1" />
            <circle cx="9" cy="12" r="1" />
            <circle cx="9" cy="18" r="1" />
            <circle cx="15" cy="6" r="1" />
            <circle cx="15" cy="12" r="1" />
            <circle cx="15" cy="18" r="1" />
        </>,
        p.className,
        p.style,
    );
