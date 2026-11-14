import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = (name: string) => { try { return readFileSync(new URL(`../src/main/${name}.ts`, import.meta.url), 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; } };

describe('the production features owner (Tynn #720)', () => {
    it('genie-host constructs exactly one aggregator over its owned contributors', () => {
        const host = source('genie-host');
        expect(host.match(/new HostFeatures\(/g)).toHaveLength(1);
        expect(host).toContain('features: hostFeatures');
        expect(host).toContain('hostFeatures.close()');
        expect(host).toContain('nativeFeatureToolchain(');
    });
    it('the window delegates every feature operation and owns no duplicate builder or state', () => {
        const main = source('main');
        expect(main).toContain('featureReplica(');
        for (const removed of ['featureSnapshot(', 'handleFeatureAction(', 'let featureState', 'new HostPicks(', 'const featurePorts:', 'const processPorts =', 'new LatestPush<FeatureData>']) {
            expect(main, removed).not.toContain(removed);
        }
    });
    it('the engine admits the owning local connection and sends its effects back to that connection', () => {
        const server = source('session-engine-server');
        expect(server).toContain("case 'engine.features':");
        expect(server).toContain('this.#options.features?.dropOwner(conn.id)');
        expect(server).toContain("this.#reverseTo(conn, 'client.featureEffect'");
        const effects = source('feature-window');
        expect(effects).toContain('contentsFor(connectionId)');
        expect(effects).not.toContain('getAllWindows');
    });
    it('the window follows owned invalidations and releases callers instead of holding feature data', () => {
        const replica = source('feature-replica');
        for (const method of ['snapshot', 'act', 'picked', 'soundData', 'releaseCaller', 'onInvalidated']) expect(replica).toContain(method);
        expect(replica).not.toContain('FeatureState');
        expect(source('host-api')).toContain('deps.features.onInvalidated');
    });
});
