import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { updateChip } from '../src/core/update-chip.js';
import { UpdateHost, type UpdaterPort } from '../src/main/updater.js';
import { UpdateWindow } from '../src/renderer/components/UpdateWindow.js';

// Real host, chip and window; only the updater library boundary is controlled. No feed, installer or Electron.
const VERSION = '2.0.0-beta.62';
const CHECK_REASON = 'Update metadata is not published yet (HTTP 404).';
const DOWNLOAD_REASON = 'The update download was interrupted. Check your connection.';
function rig() {
    let check: UpdaterPort['check'] = async () => ({ version: VERSION });
    let download: UpdaterPort['download'] = async () => {};
    const calls = { check: 0, download: 0, install: 0 };
    const port: UpdaterPort = {
        configure: () => {},
        check: () => { calls.check += 1; return check(); },
        download: (progress) => { calls.download += 1; return download(progress); },
        quitAndInstall: () => { calls.install += 1; },
    };
    const host = new UpdateHost({ port, installDir: '/synthetic/genie', ownPid: 1, processes: () => [], kill: () => true, clock: () => 42 });
    return { host, calls, checkWith: (next: typeof check) => { check = next; }, downloadWith: (next: typeof download) => { download = next; } };
}
// Follow the existing update-window test's element inspection: avoids pretending a native modal portal is mounted.
function find(node: ReactNode, match: (el: ReactElement<Record<string, unknown>>) => boolean): ReactElement<Record<string, unknown>>[] {
    const out: ReactElement<Record<string, unknown>>[] = [];
    const walk = (child: ReactNode): void => {
        if (Array.isArray(child)) { child.forEach(walk); return; }
        if (!isValidElement(child)) return;
        const element = child as ReactElement<Record<string, unknown>>;
        if (match(element)) out.push(element);
        walk(element.props.children as ReactNode);
    };
    walk(node); return out;
}
function expectRetryWindow(host: UpdateHost, reason: string) {
    const chip = updateChip(host.state());
    expect(chip).not.toBeNull(); // Shell uses this same result to decide whether the open window still exists.
    expect(chip).toMatchObject({ phase: 'error', action: 'update-check' });
    const onAction = vi.fn();
    const tree = UpdateWindow({ update: chip!, onAction, onClose: () => {} });
    const body = find(tree, (el) => el.props['data-update-window'] !== undefined);
    expect(body).toHaveLength(1);
    expect(renderToStaticMarkup(<>{body}</>)).toContain(reason);
    const retry = find(tree, (el) => el.props['data-action'] === 'update-check');
    expect(retry).toHaveLength(1);
    expect(retry[0]!.props.disabled).not.toBe(true);
    (retry[0]!.props.onClick as () => void)();
    expect(onAction).toHaveBeenCalledExactlyOnceWith('update-check');
}

describe('failed update checks and downloads remain actionable (#670)', () => {
    it('an initial failed check has an error window and a working Retry even without a known version', async () => {
        const w = rig(); w.checkWith(async () => { throw new Error(CHECK_REASON); });
        await w.host.check();
        expect(w.host.state()).toMatchObject({ phase: 'error', version: null });
        expectRetryWindow(w.host, CHECK_REASON);
        expect(w.calls).toEqual({ check: 1, download: 0, install: 0 });
    });

    it('a failed recheck retains the previously offered version rather than erasing the Upgrade door', async () => {
        const w = rig(); await w.host.check();
        w.checkWith(async () => { throw new Error(CHECK_REASON); }); await w.host.check();
        expect(w.host.state()).toMatchObject({ phase: 'error', version: VERSION });
        expectRetryWindow(w.host, CHECK_REASON);
        expect(w.calls).toEqual({ check: 2, download: 0, install: 0 });
    });

    it('a recheck in flight keeps the open upgrade window present without enabling another action', async () => {
        const w = rig(); await w.host.check();
        let finish: () => void = () => {};
        w.checkWith(() => new Promise((resolve) => { finish = () => resolve({ version: VERSION }); }));
        const checking = w.host.check();
        try {
            expect(w.host.state().phase).toBe('checking');
            expect(updateChip(w.host.state())).toMatchObject({ version: VERSION, action: null });
        } finally { finish(); await checking; }
        expect(w.calls).toEqual({ check: 2, download: 0, install: 0 });
    });

    it('a failed download says why in the same window and offers Retry without downloading again itself', async () => {
        const w = rig(); await w.host.check();
        w.downloadWith(async () => { throw new Error(DOWNLOAD_REASON); });
        expect(await w.host.download()).toBe(false);
        expect(w.host.state()).toMatchObject({ phase: 'error', version: VERSION });
        expectRetryWindow(w.host, DOWNLOAD_REASON);
        expect(w.calls).toEqual({ check: 1, download: 1, install: 0 });
    });

    it('CONTROL: a successful check offers Download and never starts it automatically', async () => {
        const w = rig(); await w.host.check();
        expect(updateChip(w.host.state())).toMatchObject({ phase: 'available', version: VERSION, action: 'update-download' });
        expect(w.calls).toEqual({ check: 1, download: 0, install: 0 });
    });

    it('CONTROL: a successful download still requires a separate Restart to install action', async () => {
        const w = rig(); await w.host.check(); expect(await w.host.download()).toBe(true);
        expect(updateChip(w.host.state())).toMatchObject({ phase: 'downloaded', version: VERSION, action: 'update-install' });
        expect(w.calls).toEqual({ check: 1, download: 1, install: 0 });
    });
});
