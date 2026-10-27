import type { ComponentType } from 'react';
import { AnthropicIcon, OpenaiIcon } from '@particle-academy/fancy-brand-icons';
import { providerLogin } from '../../core/provider-login.js';

/**
 * A PROVIDER IS ITS LOGO, NOT ITS NAME (genie#1266; the owner, 2026-10-27: "We should be using provider logo icons like
 * genie 1 had everywhere we show the provider. Using the words takes more space than it needs to and forces users to read
 * more.").
 *
 * Ported from Genie 1 (v0.7.0-beta.342): `renderer/lib/provider-brand.ts` chose the mark, `renderer/components/Master/
 * BrandMark.tsx` drew it from `@particle-academy/fancy-brand-icons` — `AnthropicIcon` for claude, `OpenaiIcon` for codex
 * — and a provider with no mark got its INITIAL (`AgentAvatarStack`'s `Face`, `AgentTuiSwitcher`'s `Mark`): borrowing
 * another vendor's logo asserts a relationship that does not exist, and a blank reads as "no agent".
 *
 * The marks are the CC0 Simple Icons paths the package inlines, monochrome `currentColor`: the logo takes the theme's
 * text token, so it reads in light and in dark with nothing per-theme here. Its NAME is the accessible name — `aria-label`
 * for a screen reader, `title` on hover — so dropping the word costs nobody the information.
 */
const MARKS: Readonly<Record<string, ComponentType<{ size?: number; className?: string }>>> = {
    claude: AnthropicIcon,
    codex: OpenaiIcon,
};

export const PROVIDER_LOGO_PX = { xs: 12, sm: 14, md: 16, lg: 20 } as const;
export type ProviderLogoSize = keyof typeof PROVIDER_LOGO_PX;
/** The box each size takes, as Tailwind utilities (docs/decisions.md D2: no inline style objects). */
const BOX: Readonly<Record<ProviderLogoSize, string>> = { xs: 'size-3', sm: 'size-3.5', md: 'size-4', lg: 'size-5' };

/** The provider as a person reads it: the login table's name (`Claude Code`, `Codex`), else what the agent's file says. */
export function providerName(provider: string): string {
    return providerLogin(provider)?.name ?? provider;
}

export function ProviderLogo({ provider, size = 'sm', className = '' }: { provider: string; size?: ProviderLogoSize; className?: string }) {
    const name = providerName(provider);
    const px = PROVIDER_LOGO_PX[size];
    const Mark = MARKS[provider];
    return (
        <span
            role="img"
            aria-label={name}
            title={name}
            data-provider-logo={provider}
            // The caller's colour token wins; with none, the secondary text token. Never both: two `text-` colours resolve by
            // stylesheet order, not by which was meant.
            className={`inline-flex shrink-0 items-center justify-center ${/\btext-\[var\(--fg-/.test(className) ? '' : 'text-[var(--fg-2)] '}${BOX[size]} ${className}`.trim()}
        >
            {Mark ? (
                <Mark size={px} />
            ) : (
                <span aria-hidden="true" className="flex h-full w-full items-center justify-center rounded-sm border border-[var(--border-1)] font-mono text-[9px] font-semibold leading-none">
                    {provider.slice(0, 1).toUpperCase()}
                </span>
            )}
        </span>
    );
}
