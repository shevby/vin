# vin — Roadmap

Feature roadmap; milestones are in rough dependency order. Item IDs (`2.3`) are stable — don't renumber when items are added, finished, or dropped; a new item takes the next free number in its milestone, and a dropped item's number is never reused (1.13 and 2.19 were dropped). An item not yet accepted ends with *(proposed)*. Keys for any of these features go in [CONTROLS.md](CONTROLS.md).

Section names in parentheses (Tech Stack 2, Architecture, Glossary, …) refer to [CLAUDE.md](CLAUDE.md).

## 0. Foundation

- [x] 0.1 Git repo on `master`, branch per feature/fix.
- [x] 0.2 Project skeleton — CommonJS backend, ESM UI, `Vin` entry point, `node --test`.
- [x] 0.3 JSX build with esbuild (`npm start`, `npm run dev`).
- [x] 0.4 JSDoc, `jsconfig.json`, and `@types/*` for VS Code autocompletion.
- [x] 0.5 `npm run typecheck` — TypeScript as a dev-only checker of the JSDoc types (`tsc --noEmit`; code stays plain JS); run it with the tests before merging.
- [x] 0.6 Tests for `.jsx` components — a module hook transpiles JSX on load; ink-testing-library 4 works with Ink 7.
- [x] 0.7 `prepare` script that builds `dist/` (it's git-ignored), so a fresh `npm install` + `npm link` gives a working global `vin`.
- [x] 0.8 Debug log file (`VIN_LOG=<file>`) — stdout/stderr belong to Ink while the TUI runs.

## 1. Core architecture

- [x] 1.1 `Handler` base class — name, sub-handlers nested to any depth, dotted-path addressing (`handler.subhandler.method()`), lifecycle (init/dispose).
- [x] 1.2 State API — `this.state` as a deep proxy that records edits as path-based patches; `this.update(state)` for full replacement; patches from one tick batched into one message.
- [x] 1.3 UI store and `useSelector` — a per-window mirror of handler state that applies patches; built on React's `useSyncExternalStore`, so only components reading a changed path re-render.
- [x] 1.4 In-process transport and `ui/tui/handler.js` (`init(handlerName)`) — the TUI's direct proxy, using the same message shapes the JSON-RPC transport will (4.5).
- [x] 1.5 Event system — `Vin`-level bus for events between handlers (and later plugins); subscriptions released on dispose.
- [x] 1.6 Contribution registry — the one extension-point mechanism for commands (with `tui`/`cli` surface flags), context-menu entries, and keybindings.
- [x] 1.7 Keybindings — keys map to registered commands; multi-key sequences; scoped per window/mode; user remapping in config.
- [x] 1.8 TUI window manager — overlays (see Glossary) stacked over the main view, with focus and key input routed to the topmost one.
- [x] 1.9 Configuration — `config.json5` in the project root, user values merged over defaults declared in code, validated with readable errors.
- [x] 1.10 Path module — parses Windows native (`C:\…`) and Git Bash (`/c/…`) forms, UNC shares, and `~`; displays Unix-style (`~/…`, `/c/…`), keeping the native form for the OS.
- [x] 1.11 `FileSystemProvider` and the local-disk provider — the interface from Architecture plus `createDirectory`, `copy`, and streamed reads/writes, so large and cross-provider copies never buffer whole files; resources addressed by URI whose scheme picks the provider (as in VS Code).
- [x] 1.12 Error reporting — expected failures (`EACCES`, `ENOENT`, `EBUSY`, …) shown as messages in the UI, never crashes; unexpected ones also go to the log (0.8).
- [x] 1.14 Standard dialogs — confirm, text input, and choice list as reusable windows (1.8), with their keys, for delete (2.9), rename and create (2.7), conflict prompts (2.10), and passphrases (5.2). Built-in handlers with their own Ink components; the declarative vocabulary foreign plugins build UI from stays in 4.6.

## 2. Local file manager (MVP)

- [x] 2.1 Main window — two-pane split view (the panes as sub-handlers of its handler), switching the active pane, optional single-pane mode.
- [ ] 2.2 Directory listing — windowed rows (Tech Stack 2); `readdir` with file types first, `stat` lazily so huge directories open instantly; name/size/modified columns; markers and colors for directories, symlinks, and executables; long names truncated.
- [ ] 2.3 Navigation — cursor movement, enter directory / go to parent, top/bottom, page up/down, home; returning to a parent puts the cursor on the directory you came from; back/forward history.
- [ ] 2.4 Windows drives — the parent of `C:\` is a list of drives (Node has no API for this; probe drive letters or ask the OS).
- [ ] 2.5 Opening files — with the OS default app (`start`/`open`/`xdg-open`), or in `$EDITOR`/`$PAGER` through a terminal takeover (suspend Ink, hand over the tty, restore on exit) — the same mechanism later offered to plugins (4.7); "open with" associations in config.
- [ ] 2.6 Selection — toggle, all/none/invert, range; operations act on the selection, or on the entry under the cursor when nothing is selected.
- [ ] 2.7 File operations — copy/move (to the other pane, and via yank/paste), rename, delete, create file/directory, create symlink (on Windows this needs Developer Mode or admin rights).
- [ ] 2.8 Bulk rename — edit the list of selected names in `$EDITOR`, as vifm does.
- [ ] 2.9 Safe delete — to the OS trash by default; permanent delete behind a confirmation.
- [ ] 2.10 Long operations — background jobs with progress and cancel, so the UI stays responsive; conflict prompts (overwrite / skip / rename / apply to all).
- [ ] 2.11 Sorting and hidden files — by name (natural order), extension, size, modified time; ascending/descending; directories first; hidden-files toggle (dotfiles; the Windows hidden attribute isn't in `fs.stat`, so it needs a platform call).
- [ ] 2.12 Search and filter — incremental search in the listing with next/previous match; a name filter that hides non-matching entries.
- [ ] 2.13 Preview pane — text files (first few KB, binaries detected), directory contents, file details; loads asynchronously and cancels when the cursor moves on.
- [ ] 2.14 Status bar — current path, selection count and size, details of the entry under the cursor (size, modified time, permissions/owner on Unix), free space (`fs.statfs`), messages.
- [ ] 2.15 Auto-refresh — watch the visible directories through the provider, debounced; manual refresh.
- [ ] 2.16 Help window — generated from the contribution registry, so plugin keys and commands appear automatically.
- [ ] 2.17 Session state — restore each pane's directory and view options on start, from a file in `.vin/`; a `--choose-dir`-style option (vifm has one) so a shell function can `cd` to vin's last directory on exit.
- [ ] 2.18 Startup paths — `vin [left-path] [right-path]` opens the panes there, as vifm does.
- [ ] 2.20 Quitting — a `core.quit` command, bound to vifm's `ZZ` (and `:q` once 6 lands), that exits through keybindings like everything else; today only Ctrl+C quits, handled by Ink before keybindings see it. *(proposed)*
- [x] 2.21 Color scheme — set in `config.json5`: a `colors` section of groups by kind (`pane: { titleActive: { … } }`), validated like any option, giving each element `fg`, `bg`, `bold`, `italic`, `underline`, `inverse`, with colors as 256-color numbers, `#hex`, names, or `default` (Ink takes all of them; chalk downsamples them for terminals with fewer colors). The default is vifm's [papercolor-dark](https://github.com/vifm/vifm-colors/blob/master/papercolor-dark.vifm); its background (234) fills the whole screen, overlays included, instead of the terminal's own. Done: `Win`/`Border`/`CmdLine`/`ErrorMsg`/`CurrLine`/`LineNr` as `core`'s shared groups, `TopLine`/`TopLineSel` as the pane titles. Groups for elements not built yet are declared by the items that add them: `CurrLine`/`OtherLine` for the cursor in the active and the other pane, `Selected` (2.6), the file types for 2.2 (`Directory`, `Link`, `BrokenLink`, `Executable`, `Socket`, `Device`, `Fifo`), `StatusLine` (2.14), `JobLine` (2.10), `AuxWin` (2.13), `CmdLine`/`WildMenu` (6).
- [ ] 2.22 Sessions — named snapshots of runtime state (not configuration, which stays in `config.json5`): each pane's directory and view options, directory history (2.3), bookmarks (7.2), macros, command and search history (6, 2.12), each feature adding its part as it lands. A `session` handler with `session.save [name]`, `session.load`, `session.delete`, and a list to pick from (1.14); as `<kind>.<method>` commands they work the same from keys, `:session.save` (6), and the CLI (3.2). As in [vifm's sessions](https://vifm.info/vimdoc.shtml#vifm-sessions): one JSON5 file per session in a flat `.vin/sessions/` folder in the project root (`.vin/` holds everything vin writes as it runs, git-ignored) (so names must be valid file names); the current session is saved on exit and before switching to another, and can be left without saving; its data overrides the unnamed state 2.17 restores.

## 3. Context menu and CLI

- [ ] 3.1 Context menu (`Space`) — the first extension point: built-in entries (open, open with, rename, copy, move, delete, properties) plus contributed ones, shown by condition (file or directory, single or multiple selection, extension, provider); users hide, reorder, and add entries in config.
- [ ] 3.2 CLI dispatcher — yargs command modules (yargs 18 loads fine with `require()` on Node 24): `vin` opens the TUI, `vin <handler>.<command> <args>` runs a `cli: true` command, per-handler `--help`, `--version`; plain output and meaningful exit codes for scripting.
- [ ] 3.3 CLI adapters — build the context the TUI would supply (e.g. target files from arguments), so the handler method runs unchanged.
- [ ] 3.4 Resolve the ambiguity between `vin <path>` (2.18) and `vin <handler>.<command>` — `zip.zip` could be either; e.g. registered commands win, and `vin ./zip.zip` forces a path.

## 4. Plugins

- [ ] 4.1 Discovery — every plugin lives in `plugins/` in the project root; enable/disable in config.
- [ ] 4.2 Manifest schema (`plugin.json5`) — name, version, `native`/`foreign`, entry or spawn command (with per-OS overrides, e.g. `python` vs `python3`), protocol version, declared contributions (commands with surfaces, menu entries, keybindings, config options); validated with readable errors.
- [ ] 4.3 Lazy activation — contributions are read from the manifest, so menus, keybindings, and `vin --help` work without loading or spawning the plugin; it's activated on first use (like VS Code's activation events).
- [ ] 4.4 Native plugins — `require`d and registered as Handlers; a plugin that throws is disabled with a message instead of taking vin down.
- [ ] 4.5 Foreign plugin host — spawn, JSON-RPC over stdio (`vscode-jsonrpc`), protocol-version handshake, shutdown on exit, crash detection; the plugin's stderr goes to the log (stdout is reserved for the protocol).
- [ ] 4.6 Declarative UI vocabulary — list, table, form field, text, progress bar, menu entry — rendered by vin, versioned with the protocol.
- [ ] 4.7 Terminal takeover for plugins — expose the mechanism from 2.5.
- [ ] 4.8 Plugin docs and typings — a `.d.ts` for the native plugin API (per Code Conventions) and a written spec of the JSON-RPC protocol.
- [ ] 4.9 Reference plugins — `zip` as a native plugin (context-menu entries plus `vin zip.zip` / `vin zip.unzip`), and a small foreign plugin in another language (e.g. Python) to prove the protocol is language-agnostic.
- [ ] 4.10 Trust model — a separate process isolates crashes, not permissions: a foreign plugin can still do anything the user can. Decide how plugins get trusted (explicit install/enable), and whether Node-based ones run under Node's permission model (`--permission`, `--allow-fs-read`, …).
- [ ] 4.11 Name collisions — top-level handler names share one namespace (`Vin.register` rejects a duplicate), so a plugin named like a built-in or another plugin must fail with a readable message that names both sources, not crash startup; possibly an alias in config to rename one.

## 5. Network protocols

- [ ] 5.1 Decide the Architecture TBD — protocol provider as its own concept or a kind of Handler; if the latter, protocols could ship as native plugins. A foreign one can't hand over Node streams, so its reads and writes need chunks over JSON-RPC.
- [ ] 5.2 Connections — saved in config (host, port, user, auth method); SSH agent or key files, with passphrase/password prompts at connect time — secrets never stored in plain config; SFTP host keys checked against `known_hosts` (ssh2 only verifies through a caller-supplied `hostVerifier`).
- [ ] 5.3 SFTP provider (`ssh2-sftp-client`) — the full provider interface including streams; SFTP has no change notifications, so `watch` falls back to polling or manual refresh.
- [ ] 5.4 FTP/FTPS provider (`basic-ftp`) — prefer FTPS (plain FTP sends credentials in cleartext); one operation at a time per connection, so queue operations or pool connections.
- [ ] 5.5 Cross-provider copy/move — streamed between any two providers with progress and cancel; a move across providers is copy + delete; names invalid on the target OS (e.g. `:` or `?` from a Linux server to Windows) are reported or renamed.
- [ ] 5.6 Remote open/edit — download to a temp file, open it, upload on save/exit (as mc and WinSCP do); temp files cleaned up.
- [ ] 5.7 Resilience — timeouts, keep-alive, reconnect; slow listings show a loading state and can be cancelled, never blocking the UI.

## 6. Command line (`:`)

Design deferred (see Use Cases and Interactions).

- [ ] 6.1 Design — syntax, completion, history, user-defined aliases/commands (vifm's `:command`), running shell commands on the selected files.
- [ ] 6.2 Implement on the contribution registry (1.6).

## 7. Later / maybe

- [ ] 7.1 Undo for file operations (vifm has it).
- [ ] 7.2 Directory bookmarks.
- [ ] 7.3 Tabs.
- [ ] 7.4 Directory sizes computed on demand.
- [ ] 7.5 Permission/ownership editing (Unix) and attributes (Windows).
- [ ] 7.6 Recursive find and content search — a good plugin candidate.
- [ ] 7.7 Archives as a `FileSystemProvider` — browse a zip like a directory.
- [ ] 7.8 More color schemes to switch between (e.g. ported from [vifm-colors](https://github.com/vifm/vifm-colors)), and honoring `LS_COLORS` for file types; the scheme itself is 2.21.
- [ ] 7.9 Image previews in terminals with a graphics protocol (Kitty, Sixel).
- [ ] 7.10 Distribution as a single executable — and then where `config.json5`, `plugins/`, and `.vin/` live, since they sit in the project root until then.
- [ ] 7.11 Electron + React GUI — out of scope (Tech Stack 3); the architecture keeps it possible.
- [ ] 7.12 Stacked panes — the split top/bottom as well as side by side (vifm's `ctrl+w s`), with a config option for the starting orientation. *(proposed)*
- [ ] 7.13 Mouse support — clicks, the wheel, and right-click for the context menu (3.1), through the terminal's mouse reporting (SGR, `?1006`). The TUI hit-tests boxes (`measureElement`) and calls the same commands keys do, so the backend never sees coordinates. Ink passes mouse sequences on as input (`[<0;10;5M`), so the key hook must filter them out; reporting must be switched off on exit, on a crash, and during a terminal takeover (2.5). An extra where the terminal allows it, with a config option to turn it off: it works in cmd, but not in Git Bash's own window (mintty), even through `winpty`.

