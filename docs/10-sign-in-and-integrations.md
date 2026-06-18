# Sign In & Integrations

Genie is **backend-agnostic**: it can connect to **Tynn** and/or **Aionima** for
your project work, and to **GitHub** for creating `.agi` repositories. All of
this lives in **Settings** (the gear in the title bar).

## Tynn (browser sign-in)

Tynn is signed in through your browser:

1. In Settings → **Tynn**, click **Sign in at &lt;host&gt;…**. Genie opens your
   browser to the Tynn sign-in page.
2. Sign in (password, or a social provider — Google / GitHub / Facebook /
   Discord).
3. Tynn hands the session back to Genie via its `genie://` callback. Genie shows
   **Connected as &lt;your name&gt;**.

**Sign out** clears the session. Under **Advanced**, a **Tynn host override**
lets you point Genie at a self-hosted or staging Tynn (blank = the environment
default — `tynn.test` in dev, `tynn.ai` when installed).

## Aionima (token sign-in)

Aionima is a local/LAN AGI gateway, signed in with a bearer token:

1. In Settings → **Aionima**, set the **Aionima host** (e.g.
   `http://192.168.0.144:3100` — the machine running AGI).
2. Mint a **Bearer token** in your Aionima dashboard and paste it in.
3. Click **Save + test**. Genie probes the host immediately and shows
   **Connected as &lt;your name&gt;** on success, or a "couldn't reach" message
   otherwise.

**Disconnect** clears the token.

## GitHub (GitHub App — device flow + install)

Genie authenticates as the **"Genie IDE" GitHub App** via **device flow** — no
embedded browser, no secret baked into the app. Connecting has **two distinct
steps**, because a GitHub App's repo access only exists where the App is
*installed*:

1. **Authorize.** In Settings → **GitHub**, click **Connect GitHub…**. Genie
   shows a short **user code** (click to copy) and an **Open &lt;GitHub URL&gt;**
   button. Open GitHub, paste the code, and approve. Genie polls in the
   background and **catches the token automatically**, then shows **Connected as
   &lt;username&gt;**.
2. **Install.** Authorizing alone grants no repo access. If Genie isn't
   installed anywhere yet, Settings → **GitHub** leads with **Install Genie on
   your accounts/orgs…**, which opens GitHub's account chooser — pick your
   personal account and/or any orgs, and which repositories Genie may touch.
   Click **I've installed it** to re-check. Use **Add account/org…** any time to
   install it on another account.

A GitHub App's permissions are declared **on the App** (no scopes are requested
at sign-in) and apply only where it's installed. Genie discovers what it can
reach via `GET /user/installations`. It's used to **create** and **fork** the
backing repositories for **`.agi` envelopes**.

When you create or fork based on an existing repo, Genie defaults the target to
the **source repo's owner** (personal or org). If Genie isn't installed on that
account, it surfaces an install prompt **pre-targeted at that exact account**
rather than failing or defaulting to your personal account.

Notes you may encounter:

- If your OS keychain is unavailable, Genie won't store the token unencrypted
  (on Linux, install `gnome-keyring` / `libsecret`).
- An org you belong to but haven't installed Genie on won't appear in the owner
  picker — install Genie there (the picker links to the chooser) rather than
  re-authorizing.
- Under **Advanced** you can paste a custom **GitHub App Client ID** (for
  self-hosters / fork testing); the Client ID is public, not a secret. If a
  build ships without a baked-in Client ID, this is where you supply one
  (register a GitHub App at `github.com/settings/apps/new` with *Enable Device
  Flow* ticked).

## Quick capture (wishes)

Genie can pop a small always-on-top **Capture a wish** window to jot a task into
a project without switching context.

- Open it with the **Quick capture hotkey** you set in
  **[Settings](08-settings.md)** (an Electron accelerator like
  `CommandOrControl+Shift+W`).
- Pick a **project** (the dropdown spans every backend you're signed in to; if
  Genie knows your current workspace's project, it's pre-selected).
- Type into **"What needs to happen?"** and press **Enter** to send
  (**Shift+Enter** for a newline). **Esc** cancels.

The wish is captured to the selected project's backend, and the window hides on
success.

## Inbox

When signed in, Genie can surface a merged **inbox** across your connected
backends, so items from Tynn and Aionima show up together.
