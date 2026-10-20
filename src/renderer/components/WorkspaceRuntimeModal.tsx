import { Modal } from '@particle-academy/react-fancy';
import type { FeatureAction, FeatureData } from '../features.js';
import { AddSiteForm } from './AddForms.js';
import { ProcessesPanel, SiteRow } from './FeatureSurfaces.js';

/**
 * A WORKSPACE'S PROCESSES OR SITES, IN A MODAL — Genie 1's Processes and Site Manager modals (the owner, 2026-10-19:
 * "Other features that have config like bg process and sites can open those config screens in modals like genie 1
 * did"). Opened from the workspace row's indicators. The Hosting tab's own panel and rows, scoped to this workspace.
 */
export function WorkspaceRuntimeModal({ kind, workspace, data, onAction, onClose }: {
    kind: 'processes' | 'sites';
    workspace: { id: string; path: string; name?: string | undefined };
    data: FeatureData;
    onAction: (action: FeatureAction) => void;
    onClose: () => void;
}) {
    const name = workspace.name ?? workspace.id;
    const hosting = data.hosting;
    const sites = (hosting?.sites ?? []).filter((s) => s.workspaceId === workspace.id);
    const processes = (hosting?.processes ?? []).filter((p) => p.workspaceId === workspace.id);
    // The Add-a-site form, here when it was asked for here (this workspace) — the Hosting tab's own form and fields.
    const adding = hosting?.adding && hosting.adding.workspaceId === workspace.id ? hosting.adding : null;
    return (
        <Modal open onClose={onClose} size="lg">
            <Modal.Header>{kind === 'processes' ? `Background processes — ${name}` : `Sites — ${name}`}</Modal.Header>
            <Modal.Body>
                <div data-workspace-runtime={kind} data-workspace={workspace.id}>
                    {kind === 'processes' ? (
                        <ProcessesPanel processes={processes} workspaces={[workspace]} onAction={onAction} />
                    ) : (
                        <>
                            <div className="flex items-center gap-3 px-5 py-2 text-sm">
                                {sites.length === 0 ? <span className="text-[var(--fg-3)]">No sites in {name} yet.</span> : null}
                                <button type="button" data-action="add-site" className="ml-auto rounded-lg border border-[var(--border-1)] px-2.5 py-1 text-[13px]" onClick={() => onAction({ kind: 'hosting.addSite', workspaceId: workspace.id, repoPath: workspace.path })}>Add a site</button>
                            </div>
                            {adding ? (
                                <AddSiteForm
                                    root={adding.repoPath}
                                    defaults={adding.defaults}
                                    existingHosts={(hosting?.sites ?? []).map((s) => s.host)}
                                    problems={adding.problems}
                                    {...(adding.phpVersions ? { phpVersions: adding.phpVersions } : {})}
                                    onSubmit={(f) => onAction({
                                        kind: 'hosting.createSite',
                                        workspaceId: adding.workspaceId,
                                        repoPath: adding.repoPath,
                                        form: { name: f.name, mode: f.mode, devServer: f.command ? { stack: adding.defaults.devServer?.stack ?? 'node', command: f.command } : null, hostPort: f.hostPort, root: f.root, spa: f.spa, phpVersion: f.mode === 'php' ? f.phpVersion : null },
                                    })}
                                    onCancel={() => onAction({ kind: 'hosting.cancelForm' })}
                                />
                            ) : null}
                            {sites.length > 0 ? (
                                <ul className="divide-y divide-[var(--border-1)]">
                                    {sites.map((s) => <SiteRow key={s.id} site={s} editing={hosting?.editing?.siteId === s.id ? hosting.editing : null} onAction={onAction} />)}
                                </ul>
                            ) : null}
                        </>
                    )}
                </div>
            </Modal.Body>
        </Modal>
    );
}
