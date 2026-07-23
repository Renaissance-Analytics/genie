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
    setPluginTrust,
    emptyPluginGrants,
    type PluginGrants,
} from '../db';
import { validatePluginManifest, type PluginManifest } from './manifest';
import { isDeveloperMode, restrictGrantsForTrust } from './trust';
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

    // --- TRUST GATE (Phase 3) — before any capability grant -------------------
    // Untrusted (tampered / wrong key / bad signature) is REFUSED outright; it can
    // never run, so there is nothing to consent to.
    if (row.trust === 'untrusted') {
        return {
            ok: false,
            enabled: false,
            error: `Refused to enable ${row.name}: it is not from a trusted publisher (its signature is invalid or its code was tampered with).`,
        };
    }
    // Outdated is NOT a trust failure: the stored manifest predates a newer schema
    // requirement. It reads (and self-heals, for bundled plugins) differently from a
    // tamper — reinstalling picks up the current manifest.
    if (row.trust === 'outdated') {
        return {
            ok: false,
            enabled: false,
            error: `Refused to enable ${row.name}: its manifest predates a newer Genie requirement. Reinstall it to update before enabling.`,
        };
    }
    const unsigned = row.trust === 'unsigned';
    // Unsigned code may only run under Developer Mode, and then RESTRICTED.
    if (unsigned && !isDeveloperMode()) {
        return {
            ok: false,
            enabled: false,
            error: `${row.name} is not signed by a trusted publisher. Turn on Developer Mode in Settings → Plugins to install unsigned plugins.`,
        };
    }

    const parsed = validatePluginManifest(JSON.parse(row.manifest_json));
    const manifest = parsed.ok ? parsed.manifest : null;
    // Unsigned plugins run restricted: never offer (or keep) network grants.
    const perms = (manifest ? declaredPermissions(manifest) : []).filter(
        (p) => !(unsigned && p.category === 'network'),
    );

    // Nothing left to (re-)ask AND no unsigned confirmation needed → enable
    // silently, respecting whatever granular grants are already recorded. A plugin
    // that already holds ANY grant is treated as previously-consented.
    const alreadyGranted = perms.some((p) => row.grants[p.category][p.key] === true);
    const nothingToAsk = perms.length === 0 || alreadyGranted;
    const unsignedAlreadyApproved = unsigned && row.dev_approved;
    if (nothingToAsk && (!unsigned || unsignedAlreadyApproved)) {
        if (unsigned) setPluginTrust(id, 'unsigned', true); // record dev-approval
        setPluginEnabled(id, true);
        return { ok: true, enabled: true };
    }

    const toolCount = manifest?.mcpTools?.length ?? 0;
    const questions: ForceQuestion[] = [];
    // An UNSIGNED plugin gets a loud, explicit "enable this unverified code?"
    // confirmation FIRST (§5.5 escalated consent).
    if (unsigned) {
        questions.push({
            header: 'Unsigned',
            question:
                `⚠ “${row.name}” is NOT signed by a trusted publisher — its code and origin are unverified.\n\n` +
                `Enable it anyway? It will run its ${toolCount} tool${toolCount === 1 ? '' : 's'} in a restricted sandbox (no network).`,
            options: [
                { label: 'Enable', description: 'I trust this developer plugin and want to run its unverified code.' },
                { label: 'Cancel', description: "Don't enable — keep it off." },
            ],
        });
    }
    // Fill the remaining question budget (ForceTheQuestion caps at 4) with the
    // granular capability grants.
    const asked = perms.slice(0, 4 - questions.length);
    for (const p of asked) {
        questions.push({
            header: capTag(p.category),
            question: `Grant this capability to “${row.name}”?\n\n• ${p.label}`,
            options: [
                { label: 'Grant', description: p.grantDescription },
                { label: 'Deny', description: 'Keep this capability off — the plugin runs without it.' },
            ],
        });
    }

    const result = await forceQuestion(questions, row.name);
    if (result.cancelled) {
        return {
            ok: false,
            enabled: false,
            error: `Enabling ${row.name} was cancelled — no capabilities were granted.`,
        };
    }
    // An unsigned plugin's first answer is the enable/cancel confirmation.
    if (unsigned && !(result.answers[0]?.selected ?? []).includes('Enable')) {
        return {
            ok: false,
            enabled: false,
            error: `Enabling ${row.name} was declined (unsigned plugin).`,
        };
    }

    // Record only the GRANTED subset (start from a clean, fail-closed map).
    const offset = unsigned ? 1 : 0;
    const grants: PluginGrants = emptyPluginGrants();
    asked.forEach((p, i) => {
        const selected = result.answers[i + offset]?.selected ?? [];
        grants[p.category][p.key] = selected.includes('Grant');
    });
    // Belt + braces: strip any network grant for a restricted (unsigned) plugin.
    const finalGrants = restrictGrantsForTrust(row.trust, grants);
    setPluginGrants(id, finalGrants);
    if (unsigned) setPluginTrust(id, 'unsigned', true); // record dev-approval
    setPluginEnabled(id, true);
    return { ok: true, enabled: true };
}
