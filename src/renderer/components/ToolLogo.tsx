import type { ComponentType } from 'react';
import { AnthropicIcon, OpenaiIcon } from '@particle-academy/fancy-brand-icons';
import { TOOL_MARKS } from './tool-marks.js';
import { toolTitle } from '../toolchain-view.js';

/**
 * A TOOL IS ITS LOGO (Tynn #962, the approved Toolchain redesign; the owner, 2026-10-27: "Using the words takes more space
 * than it needs to and forces users to read more"). Each card's mark sits on a neutral tile, so a tool with no mark still
 * reads as a tile — its initial, never a blank — and never as a borrowed logo.
 *
 * The agent CLIs are their vendors' marks from fancy-brand-icons, as ProviderLogo draws them (monochrome, the theme's
 * text colour). The languages and tools are the Simple Icons marks in tool-marks.ts, in their brand colour; a black brand
 * mark takes the theme's text colour so it reads in dark and in light. The name is the accessible name.
 */
const VENDOR: Readonly<Record<string, ComponentType<{ size?: number; className?: string }>>> = {
    'claude-code': AnthropicIcon,
    codex: OpenaiIcon,
};

const TILE = { sm: 'size-8 rounded-lg', md: 'size-9 rounded-[9px]', lg: 'size-11 rounded-xl' } as const;
const MARK_PX = { sm: 16, md: 20, lg: 26 } as const;

export function ToolLogo({ tool, size = 'md' }: { tool: string; size?: keyof typeof TILE }) {
    const name = toolTitle(tool);
    const Vendor = VENDOR[tool];
    const mark = TOOL_MARKS[tool] ?? (tool === 'cargo' ? TOOL_MARKS['rust'] : undefined);
    const px = MARK_PX[size];
    return (
        <span
            role="img"
            aria-label={name}
            title={name}
            data-tool-logo={tool}
            className={`grid shrink-0 place-items-center border border-[var(--border-1)] bg-[var(--bg-2)] text-[var(--fg-1)] ${TILE[size]}`}
        >
            {Vendor ? (
                <Vendor size={px} />
            ) : mark ? (
                <svg aria-hidden="true" viewBox="0 0 24 24" width={px} height={px} fill={mark.hex ?? 'currentColor'}>
                    <path d={mark.path} />
                </svg>
            ) : (
                <span aria-hidden="true" className="font-mono text-sm font-semibold leading-none text-[var(--fg-2)]">{name.slice(0, 1).toUpperCase()}</span>
            )}
        </span>
    );
}
