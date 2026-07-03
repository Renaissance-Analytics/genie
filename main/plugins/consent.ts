/**
 * Install-time CONSENT gate (Plugin System, Phase 1, §5.3 / deliverable #3).
 *
 * A manifest DECLARES capabilities; enabling a plugin is where the user GRANTS
 * them. When the user enables a plugin that declares capabilities and hasn't
 * been granted any yet, this raises the SAME OS-modal consent primitive every
 * other Genie gate uses (`ask/force-question.ts`) — one Grant/Deny question per
 * declared capability, granular (§12.1) — and records only the GRANTED subset.
 *
 * Fail-closed throughout: dismissing the modal enables NOTHING and grants
 * NOTHING; an unselected capability stays denied, so the plugin's tool that
 * needs it fails closed at the bridge. A previously-consented plugin (it already
 * holds a grant) re-enables silently, respecting the granular grants the user
 * set in Settings.
 */

import {
    getPlugin,
    setPluginEnabled,
    setPluginGrants,
    emptyPluginGrants,
    type PluginGrants,
} from '../db';
import { validatePluginManifest, type PluginManifest } from './manifest';
import { forceQuestion } from '../ask/force-question';
import type { ForceQuestion } from '../mcp/protocol';

/** One declared, independently-grantable permission (§12.1). */
export interface DeclaredPermission {
    category: 'fs' | 'network' | 'genieApi';
    key: string;
    label: string;
    /** A one-line rationale shown in the consent option. */
    grantDescription: string;
}

/** A short chip tag for the consent question header. */
function capTag(category: DeclaredPermission['category']): string {
    return category === 'fs' ? 'Files' : category === 'network' ? 'Network' : 'Genie API';
}

/** The granular permissions a manifest DECLARES (independent of what's granted). */
export function declaredPermissions(manifest: PluginManifest): DeclaredPermission[] {
    const out: DeclaredPermission[] = [];
    const caps = manifest.capabilities;
    if (caps?.fs && caps.fs.scope !== 'none') {
        const exts = caps.fs.extensions?.length ? ` (${caps.fs.extensions.join(', ')})` : '';
        out.push({
            category: 'fs',
            key: caps.fs.scope,
            label: `Files: ${caps.fs.scope}${exts}`,
            grantDescription: `Read/write ${caps.fs.extensions?.join(', ') || 'files'} inside the workspace it runs in.`,
        });
    }
    for (const host of caps?.network?.hosts ?? []) {
        out.push({
            category: 'network',
            key: host,
            label: `Network: ${host}`,
            grantDescription: `Make network requests to ${host}.`,
        });
    }
    for (const api of caps?.genieApi ?? []) {
        out.push({
            category: 'genieApi',
            key: api,
            label: `Genie API: ${api}`,
            grantDescription: `Call the Genie API "${api}".`,
        });
    }
    return out;
}

export interface ConsentResult {
    ok: boolean;
    enabled: boolean;
    error?: string;
}

/**
 * Consent-and-enable a plugin. Returns `{ ok, enabled }` on success, or
 * `{ ok:false }` with a reason when the user dismissed the modal (nothing was
 * granted or enabled). Up to four capabilities are asked (the ForceTheQuestion
 * cap); any beyond four remain ungranted (fail-closed) until toggled in Settings.
 */
export async function consentAndEnablePlugin(id: string): Promise<ConsentResult> {
    const row = getPlugin(id);
    if (!row) return { ok: false, enabled: false, error: 'unknown plugin' };

    const parsed = validatePluginManifest(JSON.parse(row.manifest_json));
    const manifest = parsed.ok ? parsed.manifest : null;
    const perms = manifest ? declaredPermissions(manifest) : [];

    // Nothing to grant, or already consented (holds a grant) → enable silently,
    // respecting whatever granular grants are already recorded.
    const alreadyGranted = perms.some((p) => row.grants[p.category][p.key] === true);
    if (perms.length === 0 || alreadyGranted) {
        setPluginEnabled(id, true);
        return { ok: true, enabled: true };
    }

    const toolCount = manifest?.mcpTools?.length ?? 0;
    const asked = perms.slice(0, 4);
    const questions: ForceQuestion[] = asked.map((p, i) => ({
        header: capTag(p.category),
        question:
            (i === 0
                ? `Enable “${row.name}”? It will expose ${toolCount} tool${toolCount === 1 ? '' : 's'} to agents in this workspace.\n\n`
                : '') + `Grant this capability?\n\n• ${p.label}`,
        options: [
            { label: 'Grant', description: p.grantDescription },
            { label: 'Deny', description: 'Keep this capability off — the plugin runs without it.' },
        ],
    }));

    const result = await forceQuestion(questions, row.name);
    if (result.cancelled) {
        // Dismiss = deny the whole thing. Nothing granted, plugin stays disabled.
        return {
            ok: false,
            enabled: false,
            error: `Enabling ${row.name} was cancelled — no capabilities were granted.`,
        };
    }

    // Record only the GRANTED subset (start from a clean, fail-closed map).
    const grants: PluginGrants = emptyPluginGrants();
    asked.forEach((p, i) => {
        const selected = result.answers[i]?.selected ?? [];
        grants[p.category][p.key] = selected.includes('Grant');
    });
    setPluginGrants(id, grants);
    setPluginEnabled(id, true);
    return { ok: true, enabled: true };
}
