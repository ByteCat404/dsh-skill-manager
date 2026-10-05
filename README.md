# DSH Skill Manager

A skill management plugin for DeepSeek Harness. Organize your user skill library, group skills into collections, and enable multiple skills for the current conversation.

## Features

- **Session-based activation** — enable individual skills or entire collections without changing your message draft.
- **Flexible imports** — import Markdown, folders, or ZIP, RAR, and 7z archives, including bundled scripts and resources.
- **Collections** — organize shared skills, edit membership in a dedicated dialog, and rename items inline.
- **Local editing** — open skill files in your computer's default Markdown application.
- **Guided creation** — create a skill using a local questionnaire with presets and optional custom answers. No model calls are required.
- **Isolated UI** — Shadow DOM styling reduces conflicts with themes and other UI plugins.

## Requirements

- DeepSeek Harness with the `dsh` CLI available.
- Node.js **22.5 or later** and npm.
- A desktop browser with folder-selection support for folder imports.

Session integration has been tested against DeepSeek Harness **0.2.0-rc.2** contracts. Other host versions require compatibility verification.

## Installation

Run these commands in PowerShell:

```powershell
git clone https://github.com/ByteCat404/dsh-skill-manager.git
cd dsh-skill-manager
npm ci --ignore-scripts
npm run build:client
dsh plugin --profile desktop add "$PWD"
```

Replace `desktop` if you use a different profile. Save your work, then fully quit and reopen DeepSeek Harness.

Alternatively, download the repository as a ZIP, extract it, and run the last three commands in the extracted folder.

## Quick Start

1. Open **Skills (技能)** next to the conversation input.
2. Import a skill file, folder, or archive. Review the detected skills and confirm the import.
3. Turn on a skill or collection. Your selection applies from the **next conversation turn**.

Use **New Collection (新建集合)** to group skills. Use the rename icon to edit a name, then press Enter to save or Esc to cancel. The file icon opens the skill in your default application; save your changes there, then refresh the library.

Display names can be changed without renaming internal skill identifiers. A skill can belong to multiple collections. Deleting a collection does not delete its skills.

## Update or Uninstall

To update, run the following in your cloned repository, then fully quit and reopen DeepSeek Harness:

```powershell
git pull
npm ci --ignore-scripts
npm run build:client
```

If your installation uses a copied package rather than a linked directory, update that installed copy as well. Refreshing the page alone does not reload the backend.

To uninstall the plugin:

```powershell
dsh plugin --profile desktop remove dsh-skill-manager
```

## Important Notes

- **Library scope:** only `DSH_HOME/skills` is managed (default: `~/.dsh/skills`). Project-local skill libraries are not managed. Back up the entire user skill directory, including hidden metadata.
- **Independent copies:** imports copy skill files and resources into the library. Removing the original download does not remove the installed copy. Resources must be contained within each skill's directory; ambiguous nested skill roots are rejected.
- **Activation:** selections are saved per conversation. Changes do not affect an in-progress turn. Turning a skill off stops future automatic application but does not remove instructions already in conversation history.
- **File editing:** files open on the host computer, not necessarily the browser's computer. An accepted open request does not guarantee an editor window or a saved file. Preserve the internal frontmatter `name`, file location, and resources when editing.
- **Trusted content only:** importing or enabling a skill does not itself execute its scripts or grant extra permissions. Script execution depends on the host's tools and available runtimes.
- **Archive support:** encrypted, multipart, self-extracting, and ZIP64 archives are unsupported. RAR4 has been tested; RAR5 has not been specifically verified. Archives inside archives are not recursively extracted.
- **Capacity:** v0.3.7 removes fixed import byte quotas, but processing remains memory-based. Large imports can exhaust available memory. File-count, preview-count, compression-ratio, concurrency, and timeout protections remain in place.

## Development

```powershell
npm ci --ignore-scripts
npm run verify
```

Verification uses disposable skill libraries. React and ReactDOM are provided by the host. Archive support uses the pinned `7zip-bin-full@26.3.1` dependency; its multi-platform binaries are installed through npm, not stored in this repository.

See [Verification](./VERIFICATION.md) for test coverage and known validation limits, and [Third-party licenses](./src/ARCHIVE-LICENSES.md) for archive dependency licensing.

## License

[MIT](./LICENSE). Third-party components retain their respective licenses.
