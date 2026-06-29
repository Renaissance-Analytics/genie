import { describe, expect, it } from 'vitest';
import {
    appImageUpdateUnavailable,
    planManualDownload,
    planUpdateNotification,
} from '../update-surface';

const tag = (v: string) => `https://github.com/o/genie/releases/tag/v${v}`;

describe('appImageUpdateUnavailable', () => {
    it('is true for a packaged Linux build with APPIMAGE unset (the bail case)', () => {
        expect(
            appImageUpdateUnavailable({ platform: 'linux', isPackaged: true, appimage: undefined }),
        ).toBe(true);
    });
    it('is false when APPIMAGE is set (the updater works)', () => {
        expect(
            appImageUpdateUnavailable({ platform: 'linux', isPackaged: true, appimage: '/a/Genie.AppImage' }),
        ).toBe(false);
    });
    it('is false off Linux and for an unpackaged build', () => {
        expect(appImageUpdateUnavailable({ platform: 'win32', isPackaged: true, appimage: undefined })).toBe(false);
        expect(appImageUpdateUnavailable({ platform: 'linux', isPackaged: false, appimage: undefined })).toBe(false);
    });
});

describe('planManualDownload', () => {
    it('flags a newer version with a download URL', () => {
        expect(planManualDownload('0.7.1', '0.7.0', tag)).toEqual({
            available: true,
            version: '0.7.1',
            url: tag('0.7.1'),
        });
    });
    it('reports not-available when up to date or the check found nothing', () => {
        expect(planManualDownload('0.7.0', '0.7.0', tag)).toMatchObject({ available: false });
        expect(planManualDownload(null, '0.7.0', tag)).toEqual({ available: false, version: null, url: null });
    });
    it('respects pre-release ordering (a newer beta supersedes)', () => {
        expect(planManualDownload('0.7.0-beta.84', '0.7.0-beta.83', tag).available).toBe(true);
        expect(planManualDownload('0.7.0-beta.82', '0.7.0-beta.83', tag).available).toBe(false);
    });
});

describe('planUpdateNotification', () => {
    const avail = { state: 'available', latestVersion: '0.7.1', manualDownloadUrl: null as string | null };

    it('fires once for a new available version when notifications are supported', () => {
        const n = planUpdateNotification(avail, { supported: true, notifiedVersion: null });
        expect(n.fire).toBe(true);
        expect(n.action).toBe('open');
        expect(n.title).toContain('v0.7.1');
    });
    it('does NOT fire when unsupported, already-notified, or not available', () => {
        expect(planUpdateNotification(avail, { supported: false, notifiedVersion: null }).fire).toBe(false);
        expect(planUpdateNotification(avail, { supported: true, notifiedVersion: '0.7.1' }).fire).toBe(false);
        expect(
            planUpdateNotification(
                { state: 'up-to-date', latestVersion: '0.7.1', manualDownloadUrl: null },
                { supported: true, notifiedVersion: null },
            ).fire,
        ).toBe(false);
    });
    it('routes the click to the download URL when it is a manual-download update', () => {
        const n = planUpdateNotification(
            { state: 'available', latestVersion: '0.7.1', manualDownloadUrl: tag('0.7.1') },
            { supported: true, notifiedVersion: null },
        );
        expect(n.fire).toBe(true);
        expect(n.action).toBe('download');
        expect(n.url).toBe(tag('0.7.1'));
    });
});
