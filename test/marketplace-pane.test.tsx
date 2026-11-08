// @vitest-environment happy-dom
import { act, type ComponentType } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginCapabilities, PluginManifest } from '../src/core/plugins.js';

// Tests-first contract; replace the loader/interfaces with actual imports after measured CI RED.
interface PackageRow {
    id: string; name: string;
    publisher: { id: string; name: string; verification: { method: 'domain'; identity: string } };
    version: { version: string; digest: string; key_id: string; permissions: PluginCapabilities; file_count: number; uncompressed_size: number; published_at: string; download_url: string };
    installedVersion: string | null;
    updateAvailable: boolean;
}
interface Review {
    token: string;
    package: PackageRow;
    manifest: PluginManifest;
    installedVersion: string | null;
    needsConsent: boolean;
}
interface MarketplaceApi {
    search(query: string, cursor?: string): Promise<{ packages: readonly PackageRow[]; nextCursor: string | null }>;
    prepare(id: string, version: string): Promise<Review>;
    install(token: string, consent: boolean): Promise<{ id: string; version: string }>;
    discard(token: string): Promise<void>;
}
const source = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'renderer', 'components', 'MarketplacePane.tsx')).href;
const id = 'org.example.plugin';
const capabilities: PluginCapabilities = { network: { hosts: ['api.example.org'] }, genieApi: ['knowledge'] };
const row = (installedVersion: string | null = null): PackageRow => ({
    id, name: 'Example plugin', publisher: { id: '01ARZ3NDEKTSV4RRFFQ69G5FAV', name: 'Example Publisher', verification: { method: 'domain', identity: 'publisher.example.org' } },
    version: { version: '1.1.0', digest: 'a'.repeat(64), key_id: `sha256:${'b'.repeat(64)}`, permissions: capabilities, file_count: 3, uncompressed_size: 1024, published_at: '2026-11-08T12:00:00Z', download_url: `https://tynn.ai/api/v1/marketplace/packages/${id}/versions/1.1.0/download` },
    installedVersion, updateAvailable: installedVersion !== null,
});
const review = (installedVersion: string | null = null, needsConsent = true): Review => ({
    token: 'review-opaque-token', package: row(installedVersion), installedVersion, needsConsent,
    manifest: { id, name: 'Example plugin', version: '1.1.0', publisher: { name: 'Example Publisher', keyId: `sha256:${'b'.repeat(64)}` }, capabilities, panels: [], editors: [], mcpTools: [{ name: 'hello', description: 'Say hello', run: 'tools.cjs', process: 'subprocess', gated: true, inputSchema: { type: 'object' } }] },
});
const deferred = <T,>() => { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

let host: HTMLDivElement;
let root: Root;
let api: { [K in keyof MarketplaceApi]: ReturnType<typeof vi.fn<MarketplaceApi[K]>> };
const globals = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
beforeEach(() => {
    globals.IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
    api = {
        search: vi.fn<MarketplaceApi['search']>().mockResolvedValue({ packages: [row()], nextCursor: null }),
        prepare: vi.fn<MarketplaceApi['prepare']>().mockResolvedValue(review()),
        install: vi.fn<MarketplaceApi['install']>().mockResolvedValue({ id, version: '1.1.0' }),
        discard: vi.fn<MarketplaceApi['discard']>().mockResolvedValue(undefined),
    };
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); document.body.innerHTML = ''; });
const draw = async () => {
    const module = await import(/* @vite-ignore */ source) as { MarketplacePane: ComponentType<{ api: MarketplaceApi }> };
    await act(async () => { root.render(<module.MarketplacePane api={api} />); });
};
const button = (action: string) => document.querySelector(`[data-marketplace-action="${action}"]`) as HTMLButtonElement | null;
const click = async (action: string) => {
    const target = button(action); expect(target, `missing Marketplace action ${action}`).not.toBeNull();
    await act(async () => target!.click());
};

describe('C4 Marketplace pane (independent of the pending B8 tab hookup)', () => {
    it('shows registry name, verified publisher, version and declared permissions', async () => {
        await draw();
        expect(api.search).toHaveBeenCalledWith('');
        expect(document.body.textContent).toContain('Example plugin');
        expect(document.body.textContent).toContain('Example Publisher');
        expect(document.body.textContent).toMatch(/verified.*Tynn/i);
        expect(document.body.textContent).toContain('1.1.0');
        expect(document.body.textContent).toContain('api.example.org');
        expect(document.body.textContent).toContain('knowledge');
    });

    it('reviews signed permissions and commands before first-install consent, then shows progress and success', async () => {
        const installing = deferred<{ id: string; version: string }>();
        api.install.mockReturnValueOnce(installing.promise);
        await draw(); await click('install');
        const modal = document.querySelector('[data-marketplace-review]');
        expect(modal).not.toBeNull();
        expect(modal!.textContent).toContain('api.example.org');
        expect(modal!.textContent).toContain('knowledge');
        expect(modal!.textContent).toContain('tools.cjs');
        expect(modal!.textContent).toContain('subprocess');
        expect(api.install).not.toHaveBeenCalled();
        await click('confirm');
        expect(api.install).toHaveBeenCalledWith('review-opaque-token', true);
        expect(document.querySelector('[data-marketplace-progress]')?.textContent).toMatch(/install/i);
        expect(button('install')?.disabled ?? true).toBe(true);
        await act(async () => installing.resolve({ id, version: '1.1.0' }));
        expect(document.body.textContent).toMatch(/installed|updated/i);
        expect(document.querySelector('[data-marketplace-progress]')).toBeNull();
    });

    it('an update with a new capability opens consent again and does not install until confirmed', async () => {
        const next = review('1.0.0', true);
        const wider = { ...capabilities, genieApi: ['knowledge', 'manageTerminals'] };
        next.manifest = { ...next.manifest, capabilities: wider };
        next.package = { ...next.package, version: { ...next.package.version, permissions: wider } };
        api.search.mockResolvedValueOnce({ packages: [next.package], nextCursor: null });
        api.prepare.mockResolvedValueOnce(next);
        await draw(); await click('update');
        expect(document.querySelector('[data-marketplace-review]')?.textContent).toContain('manageTerminals');
        expect(api.install).not.toHaveBeenCalled();
        await click('confirm');
        expect(api.install).toHaveBeenCalledWith('review-opaque-token', true);
    });

    it('an update asking for nothing new installs directly, with no consent modal', async () => {
        api.search.mockResolvedValueOnce({ packages: [row('1.0.0')], nextCursor: null });
        api.prepare.mockResolvedValueOnce(review('1.0.0', false));
        await draw(); await click('update');
        expect(document.querySelector('[data-marketplace-review]')).toBeNull();
        expect(api.install).toHaveBeenCalledWith('review-opaque-token', false);
    });

    it('cancel discards the staged review and grants or installs nothing', async () => {
        await draw(); await click('install'); await click('cancel');
        expect(api.discard).toHaveBeenCalledWith('review-opaque-token');
        expect(api.install).not.toHaveBeenCalled();
        expect(document.querySelector('[data-marketplace-review]')).toBeNull();
    });

    it('a failed install shows the reason and Retry prepares a fresh review before consent', async () => {
        api.install.mockRejectedValueOnce(new Error('The publisher key was revoked'));
        api.prepare.mockResolvedValueOnce(review()).mockResolvedValueOnce({ ...review(), token: 'fresh-review-token' });
        await draw(); await click('install'); await click('confirm');
        expect(document.body.textContent).toContain('The publisher key was revoked');
        await click('retry');
        expect(api.prepare).toHaveBeenCalledTimes(2);
        expect(document.querySelector('[data-marketplace-review]')).not.toBeNull();
        expect(api.install).toHaveBeenCalledTimes(1);
        await click('confirm');
        expect(api.install).toHaveBeenLastCalledWith('fresh-review-token', true);
    });

    it('shows preparation progress and refuses duplicate requests while the signed package is checked', async () => {
        const preparing = deferred<Review>();
        api.prepare.mockReturnValueOnce(preparing.promise);
        await draw(); await click('install');
        expect(document.querySelector('[data-marketplace-progress]')?.textContent).toMatch(/prepar|download|verif/i);
        expect(button('install')?.disabled).toBe(true);
        await click('install');
        expect(api.prepare).toHaveBeenCalledTimes(1);
        await act(async () => preparing.resolve(review()));
        expect(document.querySelector('[data-marketplace-review]')).not.toBeNull();
    });

    it('searches explicitly and retries a failed browse without dropping the query', async () => {
        await draw();
        const input = document.querySelector('[data-marketplace-search]') as HTMLInputElement;
        expect(input).not.toBeNull();
        await act(async () => {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
            setter.call(input, 'notes'); input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        api.search.mockRejectedValueOnce(new Error('Registry unavailable'));
        await click('search');
        expect(api.search).toHaveBeenLastCalledWith('notes');
        expect(document.body.textContent).toContain('Registry unavailable');
        await click('retry-search');
        expect(api.search).toHaveBeenLastCalledWith('notes');
    });

    it('does not render registry names as HTML', async () => {
        api.search.mockResolvedValueOnce({ packages: [{ ...row(), name: '<img src=x onerror=alert(1)>' }], nextCursor: null });
        await draw();
        expect(document.querySelector('img')).toBeNull();
        expect(document.body.textContent).toContain('<img src=x onerror=alert(1)>');
    });
});
