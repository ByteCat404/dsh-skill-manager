# Verification

## v0.3.7

`npm run verify` passed on Windows with Node.js 24 using isolated, disposable skill libraries:

| Area | Coverage |
| --- | --- |
| Build | Syntax checks, client build, and ModuleLoader validation |
| Host integration | 21 test groups |
| Library API | 23 test groups |
| Edit recovery | 6 test groups |
| Local file opening | 11 test groups using injected launchers |
| Backend safety | 10 test groups |
| Library integration | Stable identity, resource paths, authorization, and disposal |
| Archives | 10 passed; 1 optional fixture-export test skipped |
| Activation | 19 isolated contract test groups |
| Client | 21 test groups with isolated hooks and fetch |
| Guided creation | Presets, custom answers, navigation, and save checks |

Capacity regressions cover streamed JSON above 24 MiB, 19 MiB resources, a stored ZIP above 16 MiB, four pending previews totaling 76 MiB, and Markdown above 16 MiB. Copied resources are compared byte-for-byte. Path, file-count, preview-count, expiry, replay, and compression-ratio checks remain covered.

## UI Validation Scope

The frozen v0.3.6 client passed 20 isolated browser regressions for collection dialogs and inline renaming. Coverage includes background isolation, Tab navigation, synthetic IME composition events, shared-member synchronization, pending-state locks, and focus restoration.

These tests use temporary libraries, mocked APIs and sessions, and synthetic input events. They do **not** establish full production GUI, operating-system IME, or live agent-turn behavior. The previously reported intermittent application-wide input issue has not been proven fixed.

Local file-opening tests do not launch real editors. A successful open response means that the request was handed off, not that an editor appeared or a file was saved.

## Reproduce

```powershell
npm ci --ignore-scripts
npm run verify
```

React and ReactDOM are supplied by the host. Archive binaries are installed through npm and are not committed to this repository.

During publication checks, 7-Zip could not create a test archive in the default Windows temporary directory. The full suite passed after `TEMP` and `TMP` were set to a writable workspace directory, without skipping archive tests or changing product logic. The underlying environment cause remains undetermined. If this occurs, check temporary-directory permissions and security software, or retry with a writable temporary directory.

## Runtime Limits

- Removing fixed import byte quotas does not provide unlimited capacity. JSON, base64, previews, and decompression remain memory-based and subject to machine, Node.js, and host limits.
- Protections retain a maximum of 2,048 files, 32 pending previews, ten-minute preview expiry, compression-ratio checks, bounded concurrency, and timeouts. ZIP64 is unsupported.
- Library metadata and activation state have separate control-file limits; these are not import quotas.
- Backend updates require fully quitting and reopening the host. A page refresh alone is insufficient.

This summary excludes private logs, local absolute paths, and user skills. Test source and synthetic archive fixtures are included in the repository.
