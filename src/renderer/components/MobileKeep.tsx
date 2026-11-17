import { Button } from '@particle-academy/react-fancy';
import type { PhonePlatform } from '../../core/pairing-guide.js';
import { CopyAnnounce, copyWords, useCopyText } from './CopyText.js';

/**
 * KEEP GENIE ON THIS PHONE (Tynn #752). Shown once, right after a PIN pairing: the address to come back to (the MagicDNS
 * name the phone opened, never a typed IP), the browser's own "Add to Home Screen", and that Tailscale stays on on both.
 */
export interface MobileKeepProps {
    readonly address: string;
    readonly platform: PhonePlatform;
    readonly onDone: () => void;
}

/** The browser's own words for it: Safari's Share sheet, Chrome's menu. */
const HOW: Record<PhonePlatform, string> = {
    ios: 'Share, then Add to Home Screen.',
    android: 'Browser menu ⋮, then Add to Home screen (or Install app).',
    other: 'Bookmark this page, or add it to your home screen.',
};

export function MobileKeep({ address, platform, onDone }: MobileKeepProps) {
    // Every copy goes through Genie's one door (renderer/clipboard.ts), which says when it failed. A page with no clipboard
    // at all (plain HTTP on the tailnet) gets no button: the address is selectable text.
    const { state, copy } = useCopyText();
    const canCopy = typeof navigator !== 'undefined' && 'clipboard' in navigator;
    return (
        <section data-mobile-keep={platform} className="flex flex-col gap-2 rounded-xl border border-[var(--accent)]/40 bg-[var(--bg-1)] p-3 text-[13px]">
            <h2 className="text-sm font-semibold">Keep Genie on this phone</h2>
            <p className="select-all break-all font-mono text-xs text-[var(--fg-2)]">{address}</p>
            <p>{HOW[platform]}</p>
            <p className="text-xs text-[var(--fg-3)]">Keep Tailscale on, on this phone and on the computer.</p>
            <div className="flex gap-2">
                {canCopy ? (
                    <Button size="xs" type="button" data-action="keep-copy" onClick={() => { void copy(address); }}>{copyWords(state, 'Copy address')}</Button>
                ) : null}
                <Button size="xs" type="button" data-action="keep-done" onClick={onDone}>Done</Button>
                <CopyAnnounce state={state} />
            </div>
        </section>
    );
}
