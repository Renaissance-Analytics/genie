import { x509Issuer, type CertIssuer } from '../../src/main/gen-ca.js';
import type { IssuedPem } from '../../src/main/x509.js';

/**
 * THE REAL ISSUER, ITS CERTIFICATES MADE ONCE PER TEST FILE (Tynn #790). Every composition opened a fresh CA and leaf —
 * each a synchronous RSA-2048 key generation, a random prime search — so a file that composes in every test spent
 * most of its time minting keys, and under a loaded machine its tests crossed vitest's 5 s budget (the beta.29 Windows
 * release build; WSL batches 2026-10-17). Tests about hosting count writes, prompts and routes; the certificates stay
 * the real issuer's and the CA's own, only not minted again for each test. A test ABOUT issuing passes its own issuer.
 */
const madeCa = new Map<string, IssuedPem>();
const madeLeaf = new Map<string, IssuedPem>();

export const onceIssuer: CertIssuer = {
    ca: (now) => {
        let c = madeCa.get('ca');
        if (!c) { c = x509Issuer.ca(now); madeCa.set('ca', c); }
        return c;
    },
    leaf: (ca, hosts, now) => {
        const key = `${ca.certPem}|${[...hosts].sort().join(',')}`;
        let l = madeLeaf.get(key);
        if (!l) { l = x509Issuer.leaf(ca, hosts, now); madeLeaf.set(key, l); }
        return l;
    },
};
