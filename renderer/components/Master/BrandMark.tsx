import type { ComponentType } from 'react';
import { AnthropicIcon, OpenaiIcon } from '@particle-academy/fancy-brand-icons';
import { IconTynn } from './icons';

/**
 * A brand mark by name — the one place the brand-icon package is touched.
 *
 * `@particle-academy/fancy-brand-icons` exports one component per mark
 * (`AnthropicIcon`, `OpenaiIcon`, …). Resolving names to components HERE keeps
 * the rest of the renderer talking about providers rather than importing a
 * vendor logo wherever an avatar happens to be drawn — and it means adding a
 * provider is one entry in `provider-brand.ts` plus one here, not a hunt.
 *
 * `genie` is deliberately not from that package: it is Genie's own mark, not a
 * third-party one.
 */
const MARKS: Record<string, ComponentType<{ size?: number; className?: string }>> = {
    anthropic: AnthropicIcon as ComponentType<{ size?: number; className?: string }>,
    openai: OpenaiIcon as ComponentType<{ size?: number; className?: string }>,
    genie: IconTynn,
};

/** Renders nothing for a name with no mark, so the caller can fall back. */
export function BrandMark({ name, size = 14 }: { name: string; size?: number }) {
    const Mark = MARKS[name];
    return Mark ? <Mark size={size} /> : null;
}
