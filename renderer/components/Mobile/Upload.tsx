import { useRef, useState } from 'react';
import { Icon, Text } from '@particle-academy/react-fancy';
import { MobileApiError, uploadToAi } from '../../lib/mobile-client';

/**
 * A per-workspace "Upload to .ai" affordance for the phone: a touch-friendly
 * button that opens the native file picker, reads the file to base64, POSTs it
 * to `/api/workspace/:id/upload`, and shows progress + the result/error inline.
 *
 * Viewer-safe: a 423 (desktop kill-switch) surfaces via `onLocked` so the shell
 * shows the locked banner, exactly like the other write actions.
 */
export default function UploadToAi({
    workspaceId,
    onLocked,
}: {
    workspaceId: string;
    onLocked?: () => void;
}) {
    const inputRef = useRef<HTMLInputElement>(null);
    const [busy, setBusy] = useState(false);
    const [result, setResult] = useState<{ kind: 'ok' | 'err'; text: string } | null>(
        null,
    );

    const pick = () => {
        if (busy) return;
        setResult(null);
        inputRef.current?.click();
    };

    const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        // Reset the input so picking the same file again re-fires onChange.
        e.target.value = '';
        if (!file) return;
        setBusy(true);
        setResult(null);
        try {
            const { path } = await uploadToAi(workspaceId, file);
            // Show just the final segment — the full path is long on a phone.
            const name = path.split(/[\\/]/).pop() ?? file.name;
            setResult({ kind: 'ok', text: `Uploaded ${name} to .ai/` });
        } catch (err) {
            if (err instanceof MobileApiError && err.isLocked) {
                onLocked?.();
                setResult({ kind: 'err', text: 'Locked on desktop — upload disabled.' });
            } else {
                setResult({
                    kind: 'err',
                    text: err instanceof Error ? err.message : 'Upload failed',
                });
            }
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="m-upload">
            <button type="button" className="m-upload-btn" disabled={busy} onClick={pick}>
                <Icon name={busy ? 'loader' : 'upload'} size="xs" className={busy ? 'm-spin' : ''} />
                <Text size="xs" style={{ fontWeight: 600 }}>
                    {busy ? 'Uploading…' : 'Upload to .ai'}
                </Text>
            </button>
            <input
                ref={inputRef}
                type="file"
                className="m-upload-input"
                onChange={(e) => void onFile(e)}
            />
            {result && (
                <Text
                    size="xs"
                    className={`m-truncate ${result.kind === 'ok' ? 'text-emerald-500' : 'text-rose-500'}`}
                >
                    {result.text}
                </Text>
            )}
        </div>
    );
}
