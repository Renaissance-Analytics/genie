import { useState } from 'react';

/**
 * A GENIE SITE IN A PANEL (Tynn #282): `https://<host>.gen` shown in the tab, served by Genie's front door with its own
 * certificate. With no site chosen yet the panel asks for one — never an empty frame that reads as a site that failed.
 */
export function SitePanel({ host, onPick }: { host: string | null; onPick: (host: string) => void }) {
    const [typed, setTyped] = useState('');
    if (!host) {
        const valid = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.gen$/i.test(typed.trim());
        return (
            <form data-site-pick="" onSubmit={(e) => { e.preventDefault(); if (valid) onPick(typed.trim().toLowerCase()); }} className="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-[12px] text-[var(--fg-3)]">
                <label htmlFor="site-host">Which site? A .gen address this workstation serves.</label>
                <div className="flex gap-1.5">
                    <input id="site-host" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="moic.gen" className="rounded-md border border-[var(--border-1)] bg-transparent px-2 py-1 text-[var(--fg-1)]" />
                    <button type="submit" disabled={!valid} className="rounded-md border border-[var(--border-1)] px-2 py-1 disabled:opacity-50">Show</button>
                </div>
            </form>
        );
    }
    return <iframe data-site-frame={host} title={host} src={`https://${host}/`} className="min-h-0 flex-1 border-0 bg-white" />;
}
