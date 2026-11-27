# Track releases (the launcher's feed)

Tynn #1058 L8. The launcher installs and updates four tracks, each from its own release on this repository:
`launcher-v<build>`, `client-v<build>`, `browser-v<build>` and `host-v<build>`. A build is a date and a release number,
`2026.11.28-1` (a hotfix is `-1.1`). The app's own `v*` releases, read by electron-updater, are unchanged; the bridge (L9)
is one of them.

## A round

One approved tag starts a round. Pushing it is a release action, and like any release it needs the owner's go for that
round (RULES.md, "Publishing and release approval").

| Tag | Channel | Drafts are |
|---|---|---|
| `tracks-v<build>` | stable | full releases (stable and dev installs read them) |
| `tracks-dev-v<build>` | dev | prereleases (dev installs only) |

`.github/workflows/release.yml` then:

1. **tracks-guard** builds `dist/` and fingerprints each track (`scripts/track-release-plan.ts`; what each covers is in
   `src/core/track-release-plan.ts`). A track is drafted only when its fingerprint differs from its last **published**
   release's. A changed host brings its client, and a client brings its browser (the browser runs on the client build its
   manifest names). Each drafted track needs `docs/releases/<track>-v<build>.md` with a `## What's new` section. The run
   stops, naming the file, when one is missing. The drafts are made at the round's commit. A track's tag is created only
   when its draft is published.
2. **tracks-linux** and **tracks-windows** build the packages (`scripts/build-track-packages.mjs`). On Windows,
   Authenticode comes first: the launcher is signed (`scripts/sign-windows-files.mjs`, the same Trusted Signing identity as
   the app), the client is built `--signed`, and the trees are verified (`scripts/verify-track-signatures.ps1`) before
   their bytes are packed.
3. **tracks-sign** is the only job that sees the manifest signing key. It signs each drafted track's manifests
   (`scripts/sign-manifest.mjs`) and uploads that track's own files into that track's draft, with its fingerprint.
4. **tracks-verify** writes the notes again and checks every draft (`src/core/release-check.ts`): it is still a draft, it
   has its notes, it has every package with its manifest and signature, it has nothing else, and its prerelease flag
   matches the channel.

Nothing in the workflow publishes. The owner publishes each draft after approving the round, the host's after its client's
(the launcher refuses a host whose client is not in the feed):

    gh release edit <track>-v<build> -R Renaissance-Analytics/genie --draft=false

## The manifest signing key

- The private key is the secret `GENIE_MANIFEST_SIGNING_KEY` (an Ed25519 PKCS#8 PEM) of the `release` environment.
- Its public half is the variable `GENIE_MANIFEST_PUBLIC_KEY` (the raw 32 bytes, base64) of the same environment.
- The same public key is built into every launcher as `RELEASE_PUBLIC_KEY` in `native/launcher/src/keys.rs`
  (`test/release-public-key.test.ts` pins it).

The owner created both on 2026-11-27. With either missing, or with a variable that is not the built-in key, `tracks-sign`
stops before it signs or uploads anything and says which. The launcher builds refuse to build without the variable.

Only the owner holds the private key. No agent creates, reads or prints it. Test runs sign with throwaway keys made inside
the test VM (`scripts/ci/throwaway-manifest-key.mjs`), and their launchers are built to trust that key too.

**Rotation.** A manifest may name `nextKey`, signed by the current key. A launcher that verified it trusts the next key
from then on, with no launcher update. Change `RELEASE_PUBLIC_KEY`, and the environment's two values, together.

**Approvals.** `tracks-linux`, `tracks-windows` and `tracks-sign` each run in the `release` environment, so each waits for
its reviewers. The Linux and Windows jobs wait together, and signing comes after them.
