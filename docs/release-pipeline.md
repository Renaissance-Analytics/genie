# Release pipeline

Genie ships signed installers for Windows, macOS, and Linux via a
GitHub Actions workflow that builds on a matrix of native runners.
This doc covers what the workflow does, the secrets it expects, and
the one-time setup to obtain those secrets.

## What CI runs

Two workflows live in `.github/workflows/`:

- **`ci.yml`** — runs on every push to `main` and every PR. Typechecks
  both `tsconfig`s, runs Vitest, builds the renderer static export.
  Doesn't build installers; no secrets required.
- **`release.yml`** — runs on every `v*` tag push (and on manual
  dispatch). Builds installers on each of `windows-latest`,
  `macos-latest`, `ubuntu-latest` and publishes them to the GitHub
  Release for the tag. Uses code-signing secrets if they're present.

## Cutting a release

```bash
# bump the version in package.json first
npm version 0.7.1 --no-git-tag-version
git add package.json package-lock.json
git commit -m "v0.7.1"
git tag -a v0.7.1 -m "v0.7.1"
git push origin main --tags
```

> The existing GitHub release for the tag must be a **pre-release**
> (`electron-builder.yml → publish.releaseType: prerelease`) — if the
> release was created as Draft, `electron-builder` refuses to attach
> assets with "existing type not compatible with publishing type".
> Easiest path: don't create the release manually; let
> `electron-builder` create it from the tag push.

The release workflow picks up the tag, builds all three platforms,
and attaches the installers + `latest.yml` / `latest-mac.yml` to the
GitHub Release.

## Unsigned releases — the alpha default

Genie's alpha releases ship **unsigned** so anyone can try them
without us first paying for certificates. When signing secrets are
absent, the workflow exports `CSC_IDENTITY_AUTO_DISCOVERY=false` and
`electron-builder` produces installers that load and run normally,
but trigger OS reputation warnings the first time they're opened on
a given machine. Auto-update via `electron-updater` is unaffected —
it verifies SHA-512 against `latest.yml` regardless of signing
status.

What users see on a fresh install (and what to put in release notes):

- **Windows / SmartScreen** — "Windows protected your PC". Click
  **More info** → **Run anyway**.
- **macOS / Gatekeeper** — "can't be opened because Apple cannot
  check it for malicious software". Open **System Settings → Privacy
  & Security**, scroll to bottom, **Open Anyway**.
- **Linux** — `chmod +x` the AppImage, no prompt.

### When the unsigned installer silently fails on Windows

A common alpha-tester report: SmartScreen prompts, user clicks "Run
anyway", the installer window flashes and disappears, nothing
installs, no error. **SmartScreen and Windows Defender are different
defense layers** — SmartScreen's "Run anyway" lets the installer
launch, but Defender's real-time protection can then quarantine the
unsigned binary in the background without showing a dialog. To
recover:

1. **Windows Security → Virus & threat protection → Protection
   history**. Look for a "Quarantined" or "Blocked" entry referring
   to `Genie-Setup-<version>.exe`. Click it → **Actions → Restore**
   (and **Allow on device** to prevent it happening again).
2. If nothing's in Protection history, run the `.exe` from a
   Command Prompt — `cd` to the download folder and execute
   `Genie-Setup-<version>.exe`. Defender quarantines surface as
   stderr output; NSIS errors surface as MessageBox dialogs the GUI
   path may have suppressed.
3. **Right-click → Properties** at the bottom of the General tab —
   if there's an **Unblock** checkbox (zone identifier from Internet
   download), tick it and Apply.

Signed installers don't hit this failure mode because Defender's
reputation system gives signed binaries (especially EV-signed) the
benefit of the doubt.

## Required secrets

Configure these under repo **Settings → Secrets and variables →
Actions**.

### `GH_TOKEN` (optional)

A personal access token with `repo:write` scope so
`electron-builder` can attach release artifacts. The default
`secrets.GITHUB_TOKEN` works fine for same-repo releases and the
workflow falls back to it automatically. (Note: the workflow already
sets `permissions: contents: write` on `secrets.GITHUB_TOKEN`, which
is the actual fix for the "403 Forbidden on upload" failure mode.)

### Windows code signing — the CA/B Forum 2023 reality

As of **June 1 2023**, the CA/B Forum requires code-signing
certificate private keys to live on a FIPS-140-2 Level 2 (or
equivalent) cryptographic device. A normal software-only `.pfx`
file is no longer issuable. You have three paths:

#### Path A — SSL.com eSigner (cloud HSM, easiest CI)

- **OV** plan: ~$129–249/yr, suppresses SmartScreen warnings after
  reputation builds (a few hundred installs).
- **EV** plan: ~$249–399/yr, bypasses SmartScreen reputation
  warnings on first install.

Setup:

1. Buy the cert at `ssl.com → Code Signing Certificate`. Complete
   identity validation (D-U-N-S / business documents for EV, lighter
   verification for OV).
2. SSL.com provisions the key in their cloud HSM and ships you
   credentials + a TOTP seed for **CodeSignTool**.
3. In GitHub Actions, add these secrets:
   - `WINDOWS_ESIGNER_USERNAME`
   - `WINDOWS_ESIGNER_PASSWORD`
   - `WINDOWS_ESIGNER_CREDENTIAL_ID`
   - `WINDOWS_ESIGNER_TOTP_SECRET`
4. Add an `electron-builder` `signtoolOptions.sign` hook (an
   `afterSign` script) that calls `CodeSignTool.bat sign` with the
   built `.exe` path. The cleanest pattern: a `build/sign.js` that
   reads the env vars and shells out — wire it via `win.sign` in
   `electron-builder.yml`.

CI cost: ~2–5 seconds per file signed (HSM round-trip).

#### Path B — Azure Trusted Signing (cheapest if you qualify)

- **$9.99/mo** (yes, dollars). Microsoft-operated HSM, integrates
  natively with Windows signing tooling.
- **Eligibility**: business must be ≥3 years old OR has a verified
  EV identity, OR is a verified GitHub Sponsors org. Solo
  developers / new businesses are blocked from the cheap public
  tier and have to use Path A or C.

Setup:

1. Azure portal → **Trusted Signing Account** → create.
2. Add an identity-validation request, wait for Microsoft to
   approve (days to weeks).
3. Configure GitHub Actions with an Azure service principal
   (`AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_CLIENT_SECRET`).
4. Use the `Azure/trusted-signing-action@v0.5.x` action in
   `release.yml` as a post-build step.

#### Path C — Hardware token (cheapest one-off, breaks CI)

DigiCert / Sectigo will sell you a Yubikey-style USB hardware
token (~$200 + cert fee). The key never leaves the token. **This is
unworkable for CI** — GitHub Actions runners can't have a USB
device attached. Only viable if you sign locally on a developer
machine.

#### Wiring Path A into `release.yml`

The current `release.yml` step `Build (Windows)` already uses
`WINDOWS_CSC_LINK` + `WINDOWS_CSC_KEY_PASSWORD` for the legacy
`.pfx` path. When you migrate to eSigner, swap that step to set
the four `WINDOWS_ESIGNER_*` env vars and point
`electron-builder.yml → win.sign` at a Node script that calls
SSL.com's `CodeSignTool sign` CLI. The `CSC_LINK` path stays in
the workflow as a fallback for users who already have a legacy
`.pfx`.

### macOS code signing — `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`

You need an Apple Developer Program membership (**$99/yr**) and a
**Developer ID Application** certificate.

1. **Enroll** at developer.apple.com → Account → Enroll. Personal
   accounts are fine for solo devs; org enrolment needs a D-U-N-S
   number.
2. **Create the certificate**:
   - Keychain Access → **Certificate Assistant → Request a
     Certificate from a Certificate Authority** → save the CSR to
     disk (email + name only, no CA).
   - developer.apple.com → **Certificates → +** → **Developer ID
     Application** → upload the CSR → download the `.cer` →
     double-click to install in Keychain.
3. **Export as `.p12`**:
   - Keychain Access → **My Certificates** → find the new
     "Developer ID Application: <Name> (TEAMID)" → right-click →
     **Export** → format **.p12** → set a strong password.
4. **Base64-encode** and add the secrets:
   ```bash
   base64 -i developer-id.p12 | tr -d '\n' | pbcopy
   ```
   - `MAC_CSC_LINK` = base64 output
   - `MAC_CSC_KEY_PASSWORD` = the .p12 password

### macOS notarisation — `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`

Without notarisation, Gatekeeper refuses to launch the app even when
signed.

- **`APPLE_ID`** — the email you log into Apple Developer with.
- **`APPLE_APP_SPECIFIC_PASSWORD`** — generate at
  appleid.apple.com → **Sign-In and Security → App-Specific
  Passwords → +**. Save it; you can't view it again.
- **`APPLE_TEAM_ID`** — find at developer.apple.com →
  **Membership** (the 10-character alphanumeric ID under "Team ID").

`electron-builder` submits the signed `.dmg` to Apple's notarisation
service, waits for the result, and staples the ticket so the
installer works offline. First-time notarisation can take 5–15
minutes; subsequent runs are usually under 2.

## Managed / cross-platform signing services

A recurring question: *is there one service that handles signing for
Windows, macOS, and Linux?* The honest answer is shaped by one hard
constraint and one non-requirement:

- **macOS can't be fully outsourced.** Apple is the *sole issuer* of
  Developer ID certificates, and only to an enrolled Apple Developer
  account ($99/yr). No third party can sell you macOS signing. A
  service can *hold your Apple cert and run sign+notarise for you*, but
  you still own the Apple account. This is non-negotiable.
- **Linux needs no mandatory signing.** AppImage runs unsigned; you can
  GPG-sign it with your own free key if you want integrity checks.
  Snap/Flatpak are signed by their stores. There's nothing to buy.
- **Only Windows is freely "buy from anyone"** — the cert can come from
  any CA, and a cloud service can hold the key in an HSM and sign on
  demand (see Paths A–C above).

So there's no single vendor that *issues* certs for all three. Two
categories of service get close:

### Option A — signing-orchestration services (use *your* certs)

Store your keys in their cloud HSM and sign Windows + macOS in CI:

- **SignPath.io** — Windows Authenticode + Apple notarisation,
  CI-integrated, **free tier for open-source**. Closest to "one place"
  for the signing step. You still bring the Apple account; they manage
  the Windows cert + signing mechanics.
- **DigiCert Software Trust Manager** / **Garasign (Garantir)** —
  enterprise, all platforms incl. GPG for Linux. Powerful, pricey,
  overkill at Genie's scale.

These sit *alongside* electron-builder — builder calls them as the sign
step. Lowest disruption to this pipeline.

### Option B — turnkey Electron build/sign/distribute SaaS

- **ToDesktop** — build + sign + notarise + distribute + auto-update,
  Electron-specific. They provide the Windows cert and run macOS
  notarisation (you connect your Apple account). The genuine
  "one service does everything." **Caveat: it replaces
  `electron-builder` + `electron-updater` entirely** — so it would
  subsume this pipeline *and* the in-app update pill / `latest.yml`
  flow. Paid monthly SaaS.

### Recommendation for Genie

Stay on `electron-builder` and feed each platform its own signer — at
this scale the builder pipeline already *is* the "one place,"
orchestrating all three platforms in a single CI run:

| Platform | Provider | Cost | Where |
| -------- | -------- | ---- | ----- |
| Windows  | Azure Trusted Signing (or SSL.com eSigner) | ~$10/mo or ~$130/yr | `electron-builder.yml` sign config (Path A/B) |
| macOS    | Apple Developer + builder notarise | $99/yr | `APPLE_*` env vars (already plumbed) |
| Linux    | self-GPG-sign AppImage (optional) | free | trivial post-build step |

Only reconsider a turnkey SaaS (ToDesktop) if the goal is to never
touch signing/release infra again and you're willing to replace the
build + update stack.

## Verifying a signed build

After CI succeeds, download an installer and verify:

**Windows:**
```powershell
Get-AuthenticodeSignature .\Genie-Setup-0.7.1.exe
# Status should be "Valid"
# SignerCertificate.Subject should show your org's CN
```

**macOS:**
```bash
spctl -a -v --type install Genie-0.7.1.dmg
# Expected: "Genie-0.7.1.dmg: accepted; source=Notarized Developer ID"

codesign --verify --deep --strict --verbose=2 /Applications/Genie.app
# Expected: "satisfies its Designated Requirement"
```

## Falling back to unsigned builds

If you don't have certs yet but want to test the build pipeline,
push a tag without configuring secrets. The workflow still produces
installers — they're just unsigned. The `if [ -n "$WINDOWS_CSC_LINK" ]`
guard in `release.yml` flips to `CSC_IDENTITY_AUTO_DISCOVERY=false`
automatically. Useful for internal dogfooding while procurement is
in progress; not for public release once the alpha reaches a wider
audience.
