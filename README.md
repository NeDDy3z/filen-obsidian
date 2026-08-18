# Filen Sync for Obsidian

Sync your vault with [Filen](https://filen.io) end-to-end encrypted cloud storage, on desktop and mobile. Talks to Filen directly through the official [SDK](https://github.com/FilenCloudDienste/filen-sdk-ts), so there is no server to run and nothing to configure outside Obsidian.

**Back up your vault before using this.** It is early software that has not yet been run against a real Filen account, and a sync plugin writes and deletes files on both sides by design. Deletions go to a trash you can recover from and conflicts keep both copies, but neither is a substitute for a copy of your notes somewhere this plugin cannot reach.

## Install

Not in the community plugin list yet, so pick one of these until it is.

**With BRAT**, which also keeps it updated:

1. Install [BRAT](https://github.com/TfTHacker/obsidian42-brat) from Settings, Community plugins, Browse.
2. In BRAT's settings, press **Add Beta plugin** and enter `NeDDy3z/filen-obsidian`.
3. Enable **Filen Sync** under Settings, Community plugins.

**By hand**, if you would rather not add another plugin:

1. Download `main.js` and `manifest.json` from the [latest release](https://github.com/NeDDy3z/filen-obsidian/releases/latest).
2. Put both into `<your vault>/.obsidian/plugins/filen-sync/`, creating the folder if needed.
3. Restart Obsidian, then enable **Filen Sync** under Settings, Community plugins.

Once it is in the community list, Settings, Community plugins, Browse, search for Filen will replace both of these.

## Setup

1. Set **Folder on Filen** if you want something other than `Obsidian/<vault name>`. It is created if it does not exist.
2. Enter your Filen email, password and two-factor code, then press **Log in**. Only the derived account keys are stored, never the password. Pasted values are tidied up, so a trailing newline from a password manager or the space in `123 456` from an authenticator app does not break the login.
3. Press **Check connection**. It uploads, downloads, compares and deletes a small test file, so a pass means the whole round trip works against your account.
4. Pick a direction and an auto-sync trigger.
5. Sync from the ribbon icon, the status bar item, or the **Sync now** command.

On a second device, install, log in, and point it at the same folder on Filen.

## Direction

| Mode | Effect |
| --- | --- |
| Both ways (default) | Changes travel in both directions |
| Vault to Filen only | Your vault is the source of truth |
| Filen to vault only | Filen is the source of truth |
| Off, do not sync | Nothing runs, including the automatic triggers |

One-way modes do not simply ignore the other side. If the non-authoritative side deleted a file, it is put back from the authoritative one, because ignoring it would leave the two sides permanently disagreeing and re-deciding the same thing on every sync. So in "Vault to Filen", deleting a note on another device brings it back from this vault; in "Filen to vault", deleting a note here brings it back from Filen.

Conflicts follow the direction too. Pushing uploads your copy, and Filen's version history keeps the old one. Pulling saves your copy beside the note as `note.conflict-20260818-143005.md` before writing Filen's version, so nothing is lost either way.

## Auto-sync

Three independent triggers, configurable in settings:

- **After you stop typing.** Waits for the vault to be quiet for N seconds. Runs once after a writing session, not once per keystroke. Edits made while a sync is already running are not lost, another sync follows it. The plugin's own downloads do not count as edits.
- **On an interval.** Every N minutes.
- **On startup.** One sync shortly after Obsidian opens.

On desktop the status bar shows the current state and clicking it syncs. Mobile has no status bar, so it reports through notices instead.

## How it works

Every sync compares three things: your vault now, Filen now, and a snapshot of the last successful sync kept per device. The snapshot is what tells a deletion apart from a new file.

| At last sync | In vault | On Filen | Result |
| --- | --- | --- | --- |
| no | yes | no | upload |
| no | no | yes | download |
| no | yes | yes | same: skip. different: conflict |
| yes | yes | no | deleted on Filen, so delete locally |
| yes | no | yes | deleted locally, so delete on Filen |
| yes | changed | unchanged | upload |
| yes | unchanged | changed | download |
| yes | changed | changed | conflict |

Conflicts keep both copies. The Filen version is saved next to yours as `note.conflict-20260818-143005.md` and your version is uploaded. Nothing is merged, nothing is silently overwritten.

Deletions are recoverable. Local ones go to the vault `.trash`, remote ones to the Filen trash, and Filen keeps previous versions of overwritten files.

Modification times travel in both directions, which is what stops two devices bouncing the same file back and forth forever.

**Force sync** reconciles as if this device had never synced. It starts from an empty snapshot, so no delete branch above can fire: nothing is removed on either side, and anything that differs becomes a kept-both-copies conflict. Reach for it when two devices have drifted apart.

## Syncing the .obsidian folder

| Mode | Syncs |
| --- | --- |
| Off (default) | Notes only |
| Plugins and themes | Plugin code, the enabled-plugin lists, `appearance.json`, `hotkeys.json`, `themes/`, `snippets/` |
| Everything except window layout | The whole folder, per-plugin settings included |

`workspace.json` is never synced in any mode. Obsidian rewrites it every time you move a pane, so syncing it means two devices fighting over window layout forever, and a phone layout is not a desktop layout anyway.

The middle mode exists because plugin code is what you actually want on a new device, while `plugins/<id>/data.json` is the risky part: a running plugin rewrites its own settings from memory at unpredictable moments, so a downloaded copy can be clobbered or read half-written, and those settings are often device-specific. Pick "Everything" if you want it anyway.

This plugin's own folder is always skipped, so your credentials and this device's snapshot stay on this device.

## Development

```bash
npm install
npm run dev     # watch build into main.js
npm run build   # typecheck and minified build
```

| File | What it is |
| --- | --- |
| `src/sync.ts` | Decision table, direction narrowing, config filtering, snapshot format. No I/O |
| `src/local.ts` | The vault side, via Obsidian's adapter |
| `src/filen.ts` | The Filen side, via the SDK's `cloud()` calls |
| `src/main.ts` | Plugin, settings, commands, action executor |

Releases are built by GitHub Actions, not locally. Push a tag matching the version in `manifest.json` and `.github/workflows/release.yml` builds `main.js`, signs it with a [build provenance attestation](https://docs.github.com/en/actions/security-for-github-actions/using-artifact-attestations/using-artifact-attestations-to-establish-provenance-for-builds), and publishes the release. That lets anyone confirm the shipped bundle came from this source rather than someone's laptop:

```bash
gh attestation verify main.js -R NeDDy3z/filen-obsidian
```

`src/filen.ts` avoids `sdk.fs()` deliberately. Those helpers resolve paths through an internal cache only `sdk.fs().readdir()` fills, and `sdk.fs().writeFile()` is node-only. One `getDirectoryTree()` call gives the whole subtree instead, and uploads go through `cloud().uploadWebFile()`.

## Caveats

- Credentials sit unencrypted in `.obsidian/plugins/filen-sync/data.json`, as with any Obsidian sync plugin. They grant full access to your Filen drive, so treat vault backups as sensitive.
- `@filen/sdk` calls itself a work in progress. The version is pinned exactly.
- Files are held in memory during transfer, so exclude very large attachments.
- No file watcher beyond the triggers above, so notes can be up to one interval stale.
- Requires Obsidian 1.13.0 or later, since the settings use the declarative settings API added in that release.

## Contributing

Issues and pull requests are welcome. The plugin is small on purpose, so the bar for adding a setting or a dependency is high: if a few lines of plain code will do, prefer that.

Getting set up:

```bash
git clone https://github.com/NeDDy3z/filen-obsidian
cd filen-obsidian
npm install
npm run dev
```

`npm run dev` rebuilds `main.js` on every change. To try it in a real vault, symlink the repo into that vault's plugin folder and reload Obsidian after each build:

```bash
ln -s "$(pwd)" "<your vault>/.obsidian/plugins/filen-sync"
```

Use a scratch vault rather than your real notes. This plugin deletes files on both sides when the decision table says to, and a bug in that table is the kind that eats notes.

Before opening a pull request, run `npm run build`, which typechecks and produces the bundle. Keep an eye on the size of `main.js`: most of it is the Filen SDK, and anything that pulls in another large dependency needs a good reason.

A few conventions:

- Commit subjects read as plain past-tense verbs, for example "Added the sync direction dropdown" or "Removed the redundant snapshot write".
- Comments explain why, not what. If a comment restates the code, delete it. The ones worth keeping record something you cannot see from the code, like why `sdk.fs()` is avoided or why `workspace.json` is never synced.
- Releases are cut by pushing a tag that matches the version in `manifest.json`. GitHub Actions builds, signs and publishes it.

Contributions are accepted under the same license as the project.

## License

Copyright 2026 Erik Vaněk. Licensed under the [Apache License, Version 2.0](http://www.apache.org/licenses/LICENSE-2.0).

### Third-party code

The built `main.js` bundles [`@filen/sdk`](https://github.com/FilenCloudDienste/filen-sdk-ts), which is licensed under the **GNU Affero General Public License v3.0**. AGPL-3.0 is a strong copyleft licence, so a distributed build that includes the SDK is a combined work and has to be offered under AGPL-3.0, whatever licence this repository's own source carries. Apache-2.0 code may be combined into an AGPL-3.0 work, but the result cannot be relicensed back to Apache-2.0.

In practice that means the Apache-2.0 licence above covers the source in `src/`, while any release artifact that embeds the SDK must be distributed under AGPL-3.0 with its source made available. Resolve this before publishing a release: either license the whole plugin AGPL-3.0 to match, or obtain different terms from Filen.

Other bundled dependencies are MIT (`buffer`, `events`, `path-browserify`, and the SDK's own MIT dependencies), BSD-2-Clause (`dotenv`, `progress-stream`), and BSD-3-Clause or GPL-2.0 (`node-forge`).
