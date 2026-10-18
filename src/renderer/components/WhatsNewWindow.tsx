import { ContentRenderer, Modal } from '@particle-academy/react-fancy';

/**
 * WHAT'S NEW (Tynn #762; Genie 1's What's New modal): once per version, after an upgrade, the release's own "What's new"
 * in a window over the page. Close records the version as seen; it is not shown again for it.
 */
export interface WhatsNewProps {
    /** `null`/`undefined`: nothing to show. */
    whatsNew: { version: string; notes: string } | null | undefined;
    onClose: () => void;
}

export function WhatsNewWindow({ whatsNew, onClose }: WhatsNewProps) {
    if (!whatsNew) return null;
    return (
        <Modal open onClose={onClose} size="lg">
            <Modal.Header>What’s new in Genie {whatsNew.version}</Modal.Header>
            <Modal.Body>
                <WhatsNewBody whatsNew={whatsNew} onClose={onClose} />
            </Modal.Body>
        </Modal>
    );
}

export function WhatsNewBody({ whatsNew, onClose }: { whatsNew: { version: string; notes: string }; onClose: () => void }) {
    return (
        <div data-whats-new={whatsNew.version} className="flex flex-col gap-4">
            <ContentRenderer value={whatsNew.notes} format="markdown" lineSpacing={1.5} className="max-h-[60vh] overflow-auto text-sm text-[var(--fg-2)]" />
            <div className="flex justify-end">
                <button type="button" data-action="whats-new-close" onClick={onClose} className="rounded-lg bg-[var(--primary)] px-3 py-1.5 text-sm font-medium text-white">Close</button>
            </div>
        </div>
    );
}
