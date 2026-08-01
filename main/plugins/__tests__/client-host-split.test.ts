import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
    initDatabase,
    upsertPlugin,
    deletePlugin,
    emptyPluginGrants,
    type PluginGrants,
} from '../../db';
import { runPluginEditorFs } from '../editor-bridge';
import { runPluginFsOp } from '../fs-bridge';
import type { PluginManifest } from '../manifest';

/**
 * CLIENT / HOST plugin separation (genie remote editors).
 *
 * Two independent axes:
 *   - a plugin's EDITOR surface is CLIENT-side. The client picks the editor and
 *     the client's user consents to it; over a remote connection the HOST is only
 *     asked for the document's BYTES. Requiring the editor plugin to be
 *     enabled/granted ON THE HOST is the bug — a remote member saw the redacted
 *     "plugin file operation failed" for every `.md` they opened.
 *   - a plugin's MCP-TOOL / recipe surface is HOST-side. That code RUNS on the
 *     host, so it keeps the full enable + consent-grant gate.
 *
 * The host's residual job for a client editor is the SANDBOX, and it must not
 * weaken: workspace-contained (no `..`), extension-limited to what that plugin's
 * OWN editor declares it opens, and never for an untrusted/tampered plugin.
 */

// A CLIENT-SIDE plugin: editors only, no MCP tools. Its fs capability declares a
// WIDER extension list (`.pdf`) than any editor claims — the editor path must
// only ever serve the editor-claimed subset.
const CLIENT_EDITOR_MANIFEST: Record<string, unknown> = {
    id: 'test.clientside.docs',
    namespace: 'testdocs',
    name: 'Test Docs',
    version: '1.0.0',
    description: 'Editors-only test plugin.',
    engines: { genie: '>=0.7.0' },
    entry: { tools: 'tools.cjs' },
    mcpTools: [],
    editors: [
        {
            id: 'document',
            title: 'Document',
            extensions: ['.md', '.markdown'],
            fancyEditor: {
                package: '@particle-academy/react-fancy',
                version: '>=4.9.0',
                export: 'Editor',
            },
        },
    ],
    capabilities: {
        fs: { scope: 'workspace', extensions: ['.md', '.markdown', '.pdf'] },
        network: { hosts: [] },
    },
};

const CLIENT_ID = 'test.clientside.docs';
/** Genie's own bundled, editors-only Document plugin (`.md`/`.markdown`/`.docx`). */
const BUNDLED_DOC_ID = 'ai.genie.document';
const SEEDED = [CLIENT_ID, BUNDLED_DOC_ID];

let userData: string;
let root: string;

/** Seed the client-side editor plugin into the HOST's plugin db. */
function seedClientEditor(over: Partial<Parameters<typeof upsertPlugin>[0]> = {}): void {
    upsertPlugin({
        id: CLIENT_ID,
        namespace: 'testdocs',
        name: 'Test Docs',
        version: '1.0.0',
        source_type: 'folder',
        install_path: path.join(userData, 'plugins', CLIENT_ID),
        // The bug's shape: present on the host, trusted, but the host user never
        // toggled it on and never completed the capability-consent flow.
        enabled: false,
        manifest_json: JSON.stringify(CLIENT_EDITOR_MANIFEST),
        grants: emptyPluginGrants(),
        trust: 'trusted',
        ...over,
    });
}

beforeAll(() => {
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-client-host-'));
    initDatabase(userData);
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-client-host-ws-'));
    fs.writeFileSync(path.join(root, 'classification.md'), '# Classification\n\nremote doc.\n');
    fs.writeFileSync(path.join(root, 'report.pdf'), 'not really a pdf');
    fs.writeFileSync(path.join(root, '.env'), 'SECRET=hunter2\n');
    fs.writeFileSync(path.join(os.tmpdir(), 'genie-outside-secret.md'), 'outside\n');
});

beforeEach(() => {
    for (const id of SEEDED)
        try {
            deletePlugin(id);
        } catch {
            /* not seeded */
        }
});

afterEach(() => {
    for (const id of SEEDED)
        try {
            deletePlugin(id);
        } catch {
            /* not seeded */
        }
});

afterAll(() => {
    for (const dir of [userData, root])
        try {
            fs.rmSync(dir, { recursive: true, force: true });
        } catch {
            /* best-effort */
        }
});

describe('a CLIENT-side editor over a remote connection', () => {
    it('reads a workspace document when the plugin is present + trusted but NOT enabled on the host', async () => {
        seedClientEditor();

        const r = await runPluginEditorFs(CLIENT_ID, root, 'classification.md', 'fs.readBytes');

        expect(r.error).toBeUndefined();
        expect(r.ok).toBe(true);
        expect(Buffer.from((r.value as { base64: string }).base64, 'base64').toString('utf8')).toContain(
            '# Classification',
        );
    });

    it('reads when the plugin is enabled on the host but holds NO fs grant (the headless-host shape)', async () => {
        // `ensureBundledPluginsInstalled({enable:true})` turns bundled plugins ON
        // without running the consent flow, so a headless host's rows are enabled
        // with EMPTY grants — the second deny path behind the same redacted string.
        seedClientEditor({ enabled: true, grants: emptyPluginGrants() });

        const r = await runPluginEditorFs(CLIENT_ID, root, 'classification.md', 'fs.readBytes');

        expect(r.error).toBeUndefined();
        expect(r.ok).toBe(true);
    });

    it('reads a BUNDLED first-party editor the host never installed at all', async () => {
        // A desktop host only installs bundled plugins on user action, so a remote
        // member opening a `.md` hit `getPlugin() → null → "unknown plugin"`. The
        // bundled manifest ships INSIDE Genie — the host always has the sandbox rules.
        const r = await runPluginEditorFs(BUNDLED_DOC_ID, root, 'classification.md', 'fs.readBytes');

        expect(r.error).toBeUndefined();
        expect(r.ok).toBe(true);
    });

    it('writes the document back (save) under the same authorization', async () => {
        seedClientEditor();
        const base64 = Buffer.from('# Edited remotely\n', 'utf8').toString('base64');

        const w = await runPluginEditorFs(CLIENT_ID, root, 'notes.md', 'fs.writeBytes', base64);

        expect(w.error).toBeUndefined();
        expect(w.ok).toBe(true);
        expect(fs.readFileSync(path.join(root, 'notes.md'), 'utf8')).toBe('# Edited remotely\n');
    });
});

describe('the host sandbox still holds for a client editor', () => {
    it('denies a path that escapes the workspace root', async () => {
        seedClientEditor();

        const r = await runPluginEditorFs(
            CLIENT_ID,
            root,
            '../genie-outside-secret.md',
            'fs.readBytes',
        );

        expect(r.ok).toBe(false);
    });

    it('denies an extension no editor and no fs scope declares', async () => {
        seedClientEditor();

        const r = await runPluginEditorFs(CLIENT_ID, root, '.env', 'fs.readBytes');

        expect(r.ok).toBe(false);
    });

    it('denies an extension the fs scope declares but NO editor claims', async () => {
        // `.pdf` is in `capabilities.fs.extensions` yet no editor opens it: the
        // client-editor path serves only what that plugin's editor is declared for.
        seedClientEditor();

        const r = await runPluginEditorFs(CLIENT_ID, root, 'report.pdf', 'fs.readBytes');

        expect(r.ok).toBe(false);
    });

    it('denies an UNTRUSTED (tampered) plugin even when it is enabled and granted', async () => {
        const granted: PluginGrants = { fs: { workspace: true }, network: {}, genieApi: {} };
        seedClientEditor({ enabled: true, grants: granted, trust: 'untrusted' });

        const r = await runPluginEditorFs(CLIENT_ID, root, 'classification.md', 'fs.readBytes');

        expect(r.ok).toBe(false);
    });

    it('denies an UNSIGNED plugin the user never dev-approved', async () => {
        seedClientEditor({ trust: 'unsigned', dev_approved: false });

        const r = await runPluginEditorFs(CLIENT_ID, root, 'classification.md', 'fs.readBytes');

        expect(r.ok).toBe(false);
    });

    it('denies a plugin the host has never heard of', async () => {
        const r = await runPluginEditorFs(
            'test.unknown.plugin',
            root,
            'classification.md',
            'fs.readBytes',
        );

        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/unknown plugin/i);
    });

    it('denies a plugin that declares no workspace fs scope', async () => {
        const noFs = { ...CLIENT_EDITOR_MANIFEST, capabilities: { network: { hosts: [] } } };
        seedClientEditor({ manifest_json: JSON.stringify(noFs) });

        const r = await runPluginEditorFs(CLIENT_ID, root, 'classification.md', 'fs.readBytes');

        expect(r.ok).toBe(false);
    });
});

describe('HOST-side plugin gating is unchanged', () => {
    it('still refuses a worker fs op when the user has not granted the fs capability', async () => {
        const manifest = CLIENT_EDITOR_MANIFEST as unknown as PluginManifest;

        const r = await runPluginFsOp(manifest, emptyPluginGrants(), root, 'fs.readBytes', {
            rel: 'classification.md',
        });

        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/not granted/i);
    });
});
