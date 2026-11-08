import { useEffect, useRef, useState } from 'react';
import { Badge, Button, Card, Input, Modal, Skeleton, Table, Toast, useToast } from '@particle-academy/react-fancy';
import type { MarketplaceApi, MarketplaceReview, MarketplaceRow } from '../../core/marketplace.js';
import type { PluginCapabilities } from '../../core/plugins.js';

function Permissions({ capabilities }: { capabilities: PluginCapabilities }) {
    return <Table aria-label="Package permissions">
        <Table.Head><Table.Row><Table.Column label="Access" /><Table.Column label="Requested permissions" /></Table.Row></Table.Head>
        <Table.Body>
            <Table.Row><Table.Cell>Workspace files</Table.Cell><Table.Cell>{capabilities.fs ? capabilities.fs.extensions.join(', ') || 'No file extensions' : 'None'}</Table.Cell></Table.Row>
            <Table.Row><Table.Cell>Network hosts</Table.Cell><Table.Cell>{capabilities.network.hosts.join(', ') || 'None'}</Table.Cell></Table.Row>
            <Table.Row><Table.Cell>Genie APIs</Table.Cell><Table.Cell>{capabilities.genieApi.join(', ') || 'None'}</Table.Cell></Table.Row>
        </Table.Body>
    </Table>;
}

/** B8 owns the Settings tabs. This pane needs only its host API and can live in that Marketplace slot. */
export function MarketplacePane({ api }: { api: MarketplaceApi }) {
    return <Toast.Provider><MarketplaceContent api={api} /></Toast.Provider>;
}

function MarketplaceContent({ api }: { api: MarketplaceApi }) {
    const [query, setQuery] = useState('');
    const [rows, setRows] = useState<readonly MarketplaceRow[]>([]);
    const [cursor, setCursor] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [browseError, setBrowseError] = useState<string | null>(null);
    const [phase, setPhase] = useState<'idle' | 'preparing' | 'review' | 'installing' | 'success' | 'error'>('idle');
    const [selected, setSelected] = useState<MarketplaceRow | null>(null);
    const [review, setReview] = useState<MarketplaceReview | null>(null);
    const [message, setMessage] = useState<string | null>(null);
    const mounted = useRef(false), occupied = useRef(false), sequence = useRef(0);
    const currentReview = useRef<MarketplaceReview | null>(null), searched = useRef('');
    const { toast } = useToast();
    const reason = (error: unknown): string => error instanceof Error ? error.message : String(error);

    async function browse(term: string, after?: string): Promise<void> {
        const request = ++sequence.current; searched.current = term; setLoading(true); setBrowseError(null);
        try {
            const result = after ? await api.search(term, after) : await api.search(term);
            if (!mounted.current || request !== sequence.current) return;
            setRows(previous => after ? [...previous, ...result.packages.filter(row => !previous.some(old => old.id === row.id))] : result.packages);
            setCursor(result.nextCursor);
        } catch (error) { if (mounted.current && request === sequence.current) setBrowseError(reason(error)); }
        finally { if (mounted.current && request === sequence.current) setLoading(false); }
    }
    useEffect(() => {
        mounted.current = true; void browse('');
        return () => { mounted.current = false; sequence.current++; const staged = currentReview.current; if (staged) void api.discard(staged.token).catch(() => {}); };
    }, [api]);

    function failed(error: unknown): void {
        occupied.current = false;
        if (!mounted.current) return;
        const text = reason(error); setPhase('error'); setMessage(text); setReview(null); currentReview.current = null;
        toast({ title: 'Package could not be installed', description: text, variant: 'error' });
    }
    async function install(staged: MarketplaceReview, consent: boolean): Promise<void> {
        occupied.current = true;
        if (mounted.current) { setPhase('installing'); setReview(null); }
        currentReview.current = null;
        try {
            const result = await api.install(staged.token, consent);
            occupied.current = false;
            if (!mounted.current) return;
            const text = `${staged.manifest.name} ${result.version} ${staged.installedVersion ? 'updated' : 'installed'}.`;
            setRows(previous => previous.map(row => row.id === result.id ? { ...row, installedVersion: result.version, updateAvailable: false } : row));
            setPhase('success'); setMessage(text); toast({ title: text, variant: 'success' });
        } catch (error) { void api.discard(staged.token).catch(() => {}); failed(error); }
    }
    async function prepare(row: MarketplaceRow): Promise<void> {
        if (occupied.current) return;
        occupied.current = true; setSelected(row); setPhase('preparing'); setMessage(null); setReview(null);
        try {
            const staged = await api.prepare(row.id, row.version.version);
            if (!mounted.current) { occupied.current = false; await api.discard(staged.token); return; }
            if (staged.needsConsent) { currentReview.current = staged; setReview(staged); setPhase('review'); }
            else await install(staged, false);
        } catch (error) { failed(error); }
    }
    async function cancel(): Promise<void> {
        const staged = currentReview.current; if (!staged) return;
        currentReview.current = null; setReview(null);
        try { await api.discard(staged.token); occupied.current = false; if (mounted.current) setPhase('idle'); }
        catch (error) { failed(error); }
    }
    const busy = phase === 'preparing' || phase === 'review' || phase === 'installing';
    return <section className="space-y-4" aria-label="Plugin Marketplace">
        <form className="flex items-end gap-2" onSubmit={event => { event.preventDefault(); void browse(query); }}>
            <div className="min-w-0 flex-1"><Input data-marketplace-search type="search" label="Search the Marketplace" value={query} maxLength={100} onChange={event => setQuery(event.target.value)} /></div>
            <Button type="submit" data-marketplace-action="search" disabled={loading}>Search</Button>
        </form>
        {loading && <div role="status" aria-label="Loading packages"><Skeleton shape="text" width="70%" /><Skeleton shape="text" width="50%" /></div>}
        {browseError && <div role="alert" className="space-y-2"><p>{browseError}</p><Button data-marketplace-action="retry-search" onClick={() => void browse(searched.current)}>Retry</Button></div>}
        {phase === 'preparing' || phase === 'installing' ? <p data-marketplace-progress role="status">{phase === 'preparing' ? 'Downloading and verifying the package for review…' : `Installing ${selected?.name ?? 'package'}…`}</p> : null}
        {message && <div role={phase === 'error' ? 'alert' : 'status'} className="space-y-2"><p>{message}</p>{phase === 'error' && selected && <Button data-marketplace-action="retry" onClick={() => void prepare(selected)}>Retry</Button>}</div>}
        {!loading && !browseError && rows.length === 0 && <p>No packages found.</p>}
        {rows.map(row => <Card key={row.id} size="sm">
            <Card.Header><div className="flex flex-wrap items-center gap-2"><strong>{row.name}</strong><Badge>{row.version.version}</Badge>{row.installedVersion && <Badge>Installed {row.installedVersion}</Badge>}</div><p>{row.publisher.name} · Verified by Tynn ({row.publisher.verification.identity})</p></Card.Header>
            <Card.Body><Permissions capabilities={row.version.permissions} /></Card.Body>
            <Card.Footer><Button data-marketplace-action={row.installedVersion ? 'update' : 'install'} disabled={busy || (!!row.installedVersion && !row.updateAvailable)} onClick={() => void prepare(row)}>{row.installedVersion ? row.updateAvailable ? 'Update' : 'Installed' : 'Install'}</Button></Card.Footer>
        </Card>)}
        {cursor && <Button disabled={loading} onClick={() => void browse(searched.current, cursor)}>Load more</Button>}
        <Modal open={phase === 'review' && review !== null} onClose={() => { void cancel(); }} size="lg">
            <Modal.Header>{review?.installedVersion ? 'Review update permissions' : 'Review package installation'}</Modal.Header>
            <Modal.Body>{review && <div data-marketplace-review className="space-y-4">
                <p>{review.manifest.name} {review.manifest.version} · Signed by {review.package.publisher.name}</p>
                <p>{review.installedVersion ? 'This update requests additional permissions. Review them before continuing.' : 'Allow this package to use the permissions below and run these commands?'}</p>
                <Permissions capabilities={review.manifest.capabilities} />
                <Table aria-label="Package commands"><Table.Head><Table.Row><Table.Column label="Tool" /><Table.Column label="Command module" /><Table.Column label="Process" /></Table.Row></Table.Head><Table.Body>{review.manifest.mcpTools.map((tool, index) => <Table.Row key={`${tool.name}-${index}`}><Table.Cell>{tool.name}</Table.Cell><Table.Cell><code>{tool.run}</code></Table.Cell><Table.Cell>{tool.process}</Table.Cell></Table.Row>)}</Table.Body></Table>
                {review.manifest.mcpTools.length === 0 && <p>This package declares no commands.</p>}
            </div>}</Modal.Body>
            <Modal.Footer><Button variant="ghost" data-marketplace-action="cancel" onClick={() => { void cancel(); }}>Cancel</Button><Button data-marketplace-action="confirm" onClick={() => { const staged = currentReview.current; if (staged) void install(staged, true); }}>Allow and install</Button></Modal.Footer>
        </Modal>
    </section>;
}
