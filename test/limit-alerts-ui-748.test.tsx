import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { serializeLimitAlerts, type RateLimitAlert } from '../src/core/limit-alerts.js';
import { SettingsSurface } from '../src/renderer/components/FeatureSurfaces.js';
import { EMPTY_FEATURES } from '../src/renderer/features.js';

// Tynn #748: Settings -> Notifications and sounds carries "Rate-limit alerts": add, edit, remove; each a threshold, a window
// and its own sound, ordered by threshold.
const alerts: RateLimitAlert[] = [
    { id: 'l9', thresholdPct: 98, window: '7d', sound: 'alert-rigel' },
    { id: 'l1', thresholdPct: 75, window: '5h', sound: 'chime-jade' },
];

const render = (raw: string | undefined) =>
    renderToStaticMarkup(
        <SettingsSurface data={{ ...EMPTY_FEATURES, settings: { values: raw === undefined ? {} : { rate_limit_alerts: raw } } }} onAction={() => {}} onNavigate={() => {}} section="notifications" />,
    );

describe('Rate-limit alerts in Settings, Notifications and sounds', () => {
    it('is not drawn as a raw JSON box', () => {
        expect(render(serializeLimitAlerts(alerts))).not.toContain('data-setting="rate_limit_alerts"');
    });

    it('with none added says how to start and still offers Add', () => {
        const html = render(undefined);
        expect(html).toContain('data-rate-limit-alerts');
        expect(html.match(/data-rate-limit-alert="/g)).toBeNull();
        expect(html).toContain('No rate-limit alerts yet');
        expect(html).toContain('data-action="limit-alert-add"');
    });

    it('draws each alert (threshold, window, sound picker, remove), COUNTED, ordered by threshold', () => {
        const html = render(serializeLimitAlerts(alerts));
        expect(html.match(/data-rate-limit-alert="/g)?.length).toBe(2);
        expect(html.indexOf('data-rate-limit-alert="l1"')).toBeLessThan(html.indexOf('data-rate-limit-alert="l9"'));
        expect(html).toContain('data-limit-threshold="l1"');
        expect(html).toContain('data-limit-window="l9"');
        expect(html.match(/data-sound-picker/g)?.length).toBeGreaterThanOrEqual(2);
        expect(html).toContain('Chimes · Jade');
        expect(html).toContain('Alerts · Rigel');
        expect(html).toContain('data-action="limit-alert-remove"');
    });
});
