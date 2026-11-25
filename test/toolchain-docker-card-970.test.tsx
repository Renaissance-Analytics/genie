import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { HostingSurface, ToolchainSurface } from '../src/renderer/components/FeatureSurfaces.js';
import { EMPTY_FEATURES, toolchainRefusalOf, type FeatureData } from '../src/renderer/features.js';
import { cardOfAction, toolchainProblems } from '../src/renderer/toolchain-view.js';

/**
 * Tynn #970: Docker's card says its HEALTH, not just a version. The 2026-11-20 run read "29.9.2" with no badge while the
 * daemon was off and no service could start. Not running → the words and Start (one elevated batch); a group just added
 * that this session does not have → "Needs a new login", and no Start (another start would not help). The Services
 * surface, where a service says Docker is not running, links to it.
 */
const docker = (daemon?: 'not-running' | 'needs-login' | 'no-access') => ({ tool: 'docker', installed: '29.9.2', latest: null, tone: 'unknown', source: null, ...(daemon ? { daemon } : {}) });
const tc = (d: ReturnType<typeof docker>, extra: Record<string, unknown> = {}) => ({ tools: [d], checkedAt: 1, ...extra }) as unknown as FeatureData['toolchain'];
const render = (toolchain: FeatureData['toolchain']) => renderToStaticMarkup(<ToolchainSurface data={{ ...EMPTY_FEATURES, toolchain }} onAction={() => {}} onNavigate={() => {}} />);
const card = (html: string, key: string) => { const at = html.indexOf(`data-tool-card="${key}"`); const end = html.indexOf('data-tool-card=', at + 10); return html.slice(at, end === -1 ? undefined : end); };

describe('Docker’s card, by its health', () => {
    it('not running: says so and offers Start', () => {
        const c = card(render(tc(docker('not-running'))), 'docker');
        expect(c).toContain('data-tool="docker"');
        expect(c).toMatch(/data-docker-daemon="not-running"[^>]*>Not running</);
        expect(c).toMatch(/<button[^>]*data-action="toolchain-start-docker"[^>]*>(<span[^>]*>)?Start(<\/span>)?<\/button>/);
    });
    it('no access (the account is not in the group): offers Start, which adds it', () => {
        const c = card(render(tc(docker('no-access'))), 'docker');
        expect(c).toMatch(/data-docker-daemon="no-access"[^>]*>No access</);
        expect(c).toMatch(/data-action="toolchain-start-docker"/);
    });
    it('needs a new login: says so, with why, and offers no Start', () => {
        const c = card(render(tc(docker('needs-login'))), 'docker');
        expect(c).toMatch(/data-docker-daemon="needs-login"[^>]*>Needs a new login</);
        expect(c).toContain('log out and back in');
        expect(c).not.toContain('toolchain-start-docker');
    });
    it('a Start refused is said on the card', () => {
        const c = card(render(tc(docker('not-running'), { refusals: [{ tool: 'docker', reason: 'Docker was not started: you cancelled' }] })), 'docker');
        expect(c).toMatch(/data-tool-refusal="docker"[^>]*>Docker was not started: you cancelled</);
    });
    it('CONTROL: running Docker has no health words and no Start', () => {
        const c = card(render(tc(docker())), 'docker');
        expect(c).toContain('29.9.2');
        expect(c).not.toContain('data-docker-daemon');
        expect(c).not.toContain('toolchain-start-docker');
    });
    it('the problems list leads with it: Start Docker, or the new login', () => {
        const groups = (d: ReturnType<typeof docker>) => toolchainProblems(tc(d)!, 0);
        expect(groups(docker('not-running'))).toEqual(expect.arrayContaining([expect.objectContaining({ card: 'docker', title: "Docker isn't running", label: 'Start Docker', action: { kind: 'toolchain.startDocker' } })]));
        expect(groups(docker('needs-login'))).toEqual(expect.arrayContaining([expect.objectContaining({ card: 'docker', title: 'Docker needs a new login', action: null })]));
        expect(groups(docker()).some((p) => p.card === 'docker')).toBe(false);
    });
    it('Start’s progress and refusal belong to the docker card', () => {
        expect(cardOfAction({ kind: 'toolchain.startDocker' })).toBe('docker');
        const data = { ...EMPTY_FEATURES, toolchain: tc(docker('not-running'), { refusals: [{ tool: 'docker', reason: 'no' }] }) };
        expect(toolchainRefusalOf({ kind: 'toolchain.startDocker' }, data)).toEqual({ tool: 'docker', reason: 'no' });
    });
});

describe('the Services surface links to it', () => {
    const redis = { id: 'svc_r', engine: 'redis', version: '7', scope: { kind: 'shared' }, publishedPort: 54399, credentials: {}, active: true };
    const data = (status: string) => ({ ...EMPTY_FEATURES, hosting: { sites: [], processes: [], adding: null, frontDoor: { running: false, reason: 'x' } }, services: { instances: [{ instance: redis, status, note: 'Cannot connect to the Docker daemon' }], adding: null } }) as unknown as FeatureData;
    const html = (status: string) => renderToStaticMarkup(<HostingSurface data={data(status)} onAction={() => {}} onNavigate={() => {}} tab="services" workspaces={[{ id: 'tynn', path: '/w/tynn' }]} />);
    it('a service waiting on Docker offers Docker in the Toolchain', () => {
        expect(html('docker-not-running')).toMatch(/<button[^>]*data-action="services-open-docker"[^>]*>(<span[^>]*>)?Docker in Toolchain(<\/span>)?<\/button>/);
    });
    it('CONTROL: with Docker running, no link', () => {
        expect(html('running')).not.toContain('services-open-docker');
    });
});
