# Sounds

Genie's alert sounds (core/alerts.ts maps each alert kind to one). Shipped with the app; played by the renderer when the
matching sound setting and the master switch are on.

- The five `.wav` files are the owner's own design sounds.
- The `.ogg` files are the library (Tynn #441): Kenney's, CC0. `CREDITS.md` names each one's source and
  `LICENSE-kenney-cc0.txt` holds Kenney's licence texts.

Every sound file here is a choice in `SOUND_CHOICES`, and every choice is a file here (test/alert-sound-library.test.ts).
CI checks the built renderer emitted each one (scripts/sound-assets-check.mjs).
