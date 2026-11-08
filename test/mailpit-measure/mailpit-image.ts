/**
 * THE MAILPIT IMAGE GENIE MAIL IS MEASURED AGAINST (Tynn story #487).
 *
 * Genie runs `axllent/mailpit:v1.30` (core/services.ts, the mailpit catalog entry). CI pulls the SAME manifest from GHCR,
 * by digest, so the measurement never depends on Docker Hub's unauthenticated pull quota (the reason ci.yml has no
 * Docker otherwise; genie#864). Read 2026-11-07 from both registries' manifest endpoints:
 *   registry-1.docker.io/v2/axllent/mailpit/manifests/v1.30  docker-content-digest: sha256:d5ecbb06…a748a
 *   ghcr.io/v2/axllent/mailpit/manifests/v1.30               docker-content-digest: sha256:d5ecbb06…a748a
 * The tag `v1.30` is Mailpit's moving tag for the 1.30 line (v1.30.7 when read). A newer 1.30 patch re-tags it; this pin
 * does not move with it, so the findings stay the findings of the image named here.
 */
export const MAILPIT_V130_DIGEST = 'sha256:d5ecbb067db3705fa953d79e1b7f81ef84038df67aba6c52825d8c02a1ea748a';
export const MAILPIT_MEASURED_IMAGE = `ghcr.io/axllent/mailpit@${MAILPIT_V130_DIGEST}`;
