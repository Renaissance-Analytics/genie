import { createPublicKey, verify } from 'node:crypto';

/**
 * PLUGINS (§6.7) — pure. A plugin is a package with a `genie-plugin.json`. The manifest is STRICT:
 * unknown keys are refused, because "undeclared access does not exist" — every capability a plugin may
 * use is declared here, granted at install, and the bridge refuses anything else BY NAME, with the fix in
 * the reason. Nothing defaults open. Plugins are SIGNED BY DEFAULT (Ed25519 over the manifest bytes by a
 * publisher key Genie carries); unsigned runs only under developer mode and is labelled so.
 */

export interface PluginTool {
    readonly name: string;
    readonly description: string;
    readonly inputSchema: Record<string, unknown>;
    readonly run: string;
    readonly process: 'worker' | 'subprocess';
    readonly gated: boolean;
}

// The vetted list and the panel shape live in a module with no Node imports, because the renderer draws them.
import { VETTED_FANCY_EXPORTS, type PluginPanel, type VettedFancyExport } from './plugin-panels.js';
import { VETTED_FANCY_EDITORS, type PluginEditor, type VettedFancyEditor } from './plugin-editors.js';
export { VETTED_FANCY_EXPORTS, type PluginPanel, type VettedFancyExport };
export { VETTED_FANCY_EDITORS, type PluginEditor, type VettedFancyEditor };

export interface PluginCapabilities {
    readonly fs?: { scope: 'workspace'; extensions: readonly string[] };
    readonly network: { hosts: readonly string[] };
    readonly genieApi: readonly string[];
}

export interface PluginManifest {
    readonly id: string;
    readonly name: string;
    readonly version: string;
    readonly publisher: { name: string; keyId: string; url?: string };
    readonly engines?: { genie: string };
    readonly mcpTools: readonly PluginTool[];
    readonly capabilities: PluginCapabilities;
    readonly panels: readonly PluginPanel[];
    /** The file types this plugin's editors claim (beta.33 item 14). The parser always fills it (`[]` for none). */
    readonly editors?: readonly PluginEditor[];
}

export type ParseResult = { ok: true; manifest: PluginManifest } | { ok: false; reason: string };

const TOP_KEYS = new Set(['id', 'name', 'version', 'publisher', 'engines', 'mcpTools', 'editors', 'panels', 'capabilities', 'dependencies']);
const PANEL_KEYS = new Set(['id', 'title', 'fancyComponent', 'props']);
const EDITOR_KEYS = new Set(['id', 'title', 'extensions', 'fancyEditor']);
const CAP_KEYS = new Set(['fs', 'network', 'genieApi']);
const TOOL_KEYS = new Set(['name', 'description', 'inputSchema', 'run', 'process', 'gated']);
const REVERSE_DNS = /^[a-z0-9]+(\.[a-z0-9-]+)+$/;
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const refuse = (reason: string): ParseResult => ({ ok: false, reason });

export function parseManifest(raw: unknown): ParseResult {
    if (!isRecord(raw)) return refuse('genie-plugin.json must be a JSON object');
    for (const key of Object.keys(raw)) {
        if (!TOP_KEYS.has(key)) return refuse(`unknown key "${key}" — undeclared access does not exist; remove it or declare a known capability`);
    }
    if (typeof raw.id !== 'string' || !REVERSE_DNS.test(raw.id)) return refuse('id must be reverse-DNS, like com.example.plugin');
    if (typeof raw.name !== 'string' || raw.name.length === 0) return refuse('name must be a non-empty string');
    if (typeof raw.version !== 'string' || !SEMVER.test(raw.version)) return refuse('version must be semver, like 1.2.0');
    if (!isRecord(raw.publisher) || typeof raw.publisher.name !== 'string' || typeof raw.publisher.keyId !== 'string') return refuse('publisher must name itself and its keyId');
    if (raw.engines !== undefined && (!isRecord(raw.engines) || typeof raw.engines.genie !== 'string')) return refuse('engines.genie must be a version range');

    const tools: PluginTool[] = [];
    if (raw.mcpTools !== undefined) {
        if (!Array.isArray(raw.mcpTools)) return refuse('mcpTools must be an array');
        for (const t of raw.mcpTools) {
            if (!isRecord(t)) return refuse('each mcpTools entry must be an object');
            for (const key of Object.keys(t)) if (!TOOL_KEYS.has(key)) return refuse(`unknown key "${key}" in mcpTools — undeclared access does not exist`);
            if (typeof t.name !== 'string' || typeof t.description !== 'string') return refuse('each tool needs a name and a description');
            if (!isRecord(t.inputSchema)) return refuse(`tool "${String(t.name)}" needs an inputSchema (JSON Schema object)`);
            if (typeof t.run !== 'string') return refuse(`tool "${t.name}" needs a run module`);
            if (t.process !== 'worker' && t.process !== 'subprocess') return refuse(`tool "${t.name}": process must be "worker" or "subprocess"`);
            if (typeof t.gated !== 'boolean') return refuse(`tool "${t.name}": gated must be true or false`);
            tools.push({ name: t.name, description: t.description, inputSchema: t.inputSchema, run: t.run, process: t.process, gated: t.gated });
        }
    }

    let capabilities: PluginCapabilities = { network: { hosts: [] }, genieApi: [] };
    if (raw.capabilities !== undefined) {
        if (!isRecord(raw.capabilities)) return refuse('capabilities must be an object');
        for (const key of Object.keys(raw.capabilities)) if (!CAP_KEYS.has(key)) return refuse(`unknown capability "${key}" — undeclared access does not exist`);
        const c = raw.capabilities;
        let fs: PluginCapabilities['fs'];
        if (c.fs !== undefined) {
            if (!isRecord(c.fs) || c.fs.scope !== 'workspace' || !Array.isArray(c.fs.extensions) || !c.fs.extensions.every((e) => typeof e === 'string' && e.startsWith('.'))) return refuse('capabilities.fs must be { scope: "workspace", extensions: [".ext", …] }');
            fs = { scope: 'workspace', extensions: c.fs.extensions as string[] };
        }
        let hosts: string[] = [];
        if (c.network !== undefined) {
            if (!isRecord(c.network) || !Array.isArray(c.network.hosts) || !c.network.hosts.every((h) => typeof h === 'string')) return refuse('capabilities.network must be { hosts: [...] } — an allow-list, [] for none');
            hosts = c.network.hosts as string[];
        }
        let genieApi: string[] = [];
        if (c.genieApi !== undefined) {
            if (!Array.isArray(c.genieApi) || !c.genieApi.every((a) => typeof a === 'string')) return refuse('capabilities.genieApi must be a list of Genie API names');
            genieApi = c.genieApi as string[];
        }
        capabilities = { ...(fs ? { fs } : {}), network: { hosts }, genieApi };
    }

    const panels: PluginPanel[] = [];
    if (raw.panels !== undefined) {
        if (!Array.isArray(raw.panels)) return refuse('panels must be an array');
        for (const p of raw.panels) {
            if (!isRecord(p)) return refuse('each panels entry must be an object');
            for (const key of Object.keys(p)) if (!PANEL_KEYS.has(key)) return refuse(`unknown key "${key}" in panels — a panel is an id, a title, a vetted fancyComponent and props; a plugin ships no UI code`);
            if (typeof p.id !== 'string' || p.id.length === 0) return refuse('each panel needs an id');
            if (typeof p.title !== 'string' || p.title.length === 0) return refuse(`panel "${p.id}" needs a title`);
            const exportName = isRecord(p.fancyComponent) ? p.fancyComponent.export : undefined;
            if (typeof exportName !== 'string' || !(VETTED_FANCY_EXPORTS as readonly string[]).includes(exportName)) return refuse(`panel "${p.id}": "${String(exportName)}" is not a vetted Fancy component (one of ${VETTED_FANCY_EXPORTS.join(', ')})`);
            if (p.props !== undefined && !isRecord(p.props)) return refuse(`panel "${p.id}": props must be an object`);
            panels.push({ id: p.id, title: p.title, fancyComponent: { export: exportName as VettedFancyExport }, props: (p.props as Record<string, unknown> | undefined) ?? {} });
        }
    }

    // EDITORS (beta.33 item 14): accepted since the start and DROPPED until now, so no file ever reached a plugin's editor.
    const editors: PluginEditor[] = [];
    if (raw.editors !== undefined) {
        if (!Array.isArray(raw.editors)) return refuse('editors must be an array');
        for (const e of raw.editors) {
            if (!isRecord(e)) return refuse('each editors entry must be an object');
            for (const key of Object.keys(e)) if (!EDITOR_KEYS.has(key)) return refuse(`unknown key "${key}" in editors — an editor is an id, a title, the extensions it claims and a vetted fancyEditor; a plugin ships no UI code`);
            if (typeof e.id !== 'string' || e.id.length === 0) return refuse('each editor needs an id');
            if (typeof e.title !== 'string' || e.title.length === 0) return refuse(`editor "${e.id}" needs a title`);
            if (!Array.isArray(e.extensions) || e.extensions.length === 0) return refuse(`editor "${e.id}" must claim at least one extension`);
            if (!e.extensions.every((x) => typeof x === 'string' && /^\.[A-Za-z0-9]+$/.test(x))) return refuse(`editor "${e.id}": extensions like ".md" — a dot, then letters or digits`);
            const exportName = isRecord(e.fancyEditor) ? e.fancyEditor.export : undefined;
            if (typeof exportName !== 'string' || !(VETTED_FANCY_EDITORS as readonly string[]).includes(exportName)) return refuse(`editor "${e.id}": "${String(exportName)}" is not a vetted Fancy editor (one of ${VETTED_FANCY_EDITORS.join(', ')})`);
            editors.push({ id: e.id, title: e.title, extensions: (e.extensions as string[]).map((x) => x.toLowerCase()), fancyEditor: { export: exportName as VettedFancyEditor } });
        }
    }

    return {
        ok: true,
        manifest: {
            id: raw.id,
            name: raw.name,
            version: raw.version,
            publisher: { name: raw.publisher.name, keyId: raw.publisher.keyId, ...(typeof raw.publisher.url === 'string' ? { url: raw.publisher.url } : {}) },
            ...(isRecord(raw.engines) ? { engines: { genie: String(raw.engines.genie) } } : {}),
            mcpTools: tools,
            capabilities,
            panels,
            editors,
        },
    };
}

export type AccessRequest =
    | { kind: 'genieApi'; name: string }
    | { kind: 'network'; host: string }
    | { kind: 'fs'; path: string; workspacePath: string };

export type AccessDecision = { allowed: true } | { allowed: false; reason: string };

const normalise = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');

/** The bridge's check, BY NAME: what was not declared does not exist, and the reason says how to declare it. */
export function bridgeAccess(manifest: PluginManifest, request: AccessRequest): AccessDecision {
    const no = (what: string, fix: string): AccessDecision => ({ allowed: false, reason: `${manifest.id} did not declare ${what} — undeclared access does not exist; ${fix}` });
    switch (request.kind) {
        case 'genieApi':
            return manifest.capabilities.genieApi.includes(request.name) ? { allowed: true } : no(`genieApi "${request.name}"`, 'declare it in genie-plugin.json capabilities.genieApi and reinstall');
        case 'network':
            return manifest.capabilities.network.hosts.includes(request.host) ? { allowed: true } : no(`network host "${request.host}"`, 'declare it in genie-plugin.json capabilities.network.hosts and reinstall');
        case 'fs': {
            const fs = manifest.capabilities.fs;
            if (!fs) return no('fs access', 'declare it in genie-plugin.json capabilities.fs and reinstall');
            const root = normalise(request.workspacePath);
            const path = normalise(request.path);
            if (!path.startsWith(`${root}/`)) return { allowed: false, reason: `${manifest.id} may only touch files inside the workspace; ${request.path} is outside the workspace` };
            const dot = path.lastIndexOf('.');
            const ext = dot >= 0 ? path.slice(dot) : '';
            if (!fs.extensions.includes(ext)) return { allowed: false, reason: `${manifest.id} may touch ${fs.extensions.join(', ')} only; ${ext || 'a file without an extension'} is not among the declared extensions` };
            return { allowed: true };
        }
    }
}

export type SignatureCheck = { signed: true; keyId: string } | { signed: false; reason: string };

/** Ed25519 over the manifest bytes, against the publisher keys Genie carries (PEM, by keyId). */
export function verifyPluginSignature(input: { bytes: Buffer; signature: string | null; keyId: string }, keys: Readonly<Record<string, string>>): SignatureCheck {
    if (input.signature === null) return { signed: false, reason: 'no signature file (genie-plugin.sig) beside the manifest' };
    const pem = keys[input.keyId];
    if (pem === undefined) return { signed: false, reason: `Genie does not know publisher key "${input.keyId}"` };
    let ok = false;
    try {
        const sig = Buffer.from(input.signature.trim(), 'base64');
        ok = sig.length > 0 && verify(null, input.bytes, createPublicKey(pem), sig);
    } catch {
        return { signed: false, reason: 'genie-plugin.sig is not a valid signature' };
    }
    return ok ? { signed: true, keyId: input.keyId } : { signed: false, reason: 'the signature does not match the manifest — the bytes changed after signing' };
}

export type InstallDecision = { install: true; label: string } | { install: false; reason: string };

/** Signed by default. Unsigned runs only under developer mode, and then it is labelled wherever it shows. */
export function installDecision(check: SignatureCheck, options: { developerMode: boolean }): InstallDecision {
    if (check.signed) return { install: true, label: `signed by ${check.keyId}` };
    if (options.developerMode) return { install: true, label: 'UNSIGNED — developer mode' };
    return { install: false, reason: `unsigned plugins are not installed: ${check.reason}. Turn on developer mode to run a local unsigned plugin, labelled as such.` };
}
