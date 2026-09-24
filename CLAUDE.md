# vin

A vifm-inspired terminal file manager with support for network protocols and user extensions.

## Working Together

- Don't hesitate to ask questions — when a requirement is ambiguous, a decision is really the user's to make (scope, UX, naming, trade-offs), or a wrong assumption would be costly to undo, ask instead of guessing. Pure implementation details with a sensible default don't need a question; pick one and mention it.
- Don't hesitate to add new TODO items or suggestions whenever something worth tracking comes up — no need to ask first — but mark them so they're easy to review:
  - **TODO item** — append *(proposed)* until accepted.
  - **Suggestion** — a numbered blockquote (`> **Suggestion N:** …`) in the section it concerns, using the next unused number, and backed by investigation (docs, prior art), not guesses.
- Once accepted, fold it into plain text (drop the *(proposed)* mark or the blockquote); once rejected, delete it. Never renumber the remaining ones.
- When asked to pass the work to the next chat, update two files:
  - this one, with what should last (rules, decisions, TODO status), keeping it about its current size (~230 lines) — tighten it, or move detail into code docs, rather than let it grow;
  - `WILL.md` (repo root, git-ignored), with everything else the next chat needs to carry on: where the work stands and what's next, decisions made with the user and why, the user's preferences, pitfalls, and whatever in the previous `WILL.md` still holds.
- When asked to read `WILL.md`: read all of it, keep it as your memory of the earlier chats, then delete it.

## Tech Stack

1. **Node.js 24 LTS** — plain JavaScript, no TypeScript.
   - Backend (`src/`, native plugins, root `index.js`): CommonJS — `require()`, not `import`.
   - Frontend (`ui/`): ESM — `import`. Ink 7 and its `yoga-layout` dependency use top-level `await`, so they can't be `require()`d; `ui/package.json` sets `"type": "module"`. The backend crosses into the UI with a single dynamic `import()`, and the UI can `import` backend CommonJS modules directly. In ESM files, relative imports include the file extension (`'../../src/vin.js'`).
   - Components use real JSX in `.jsx` files. [esbuild](https://esbuild.github.io/) bundles `ui/tui/index.jsx` into `dist/tui.mjs` (git-ignored), leaving `node_modules` packages external; `Vin` loads that bundle. `npm install` builds it too (the `prepare` script), so after a fresh clone `node index.js` or `npm link` gives a working `vin`; `npm start` builds first; `npm run dev` rebuilds on change.
     - Backend modules the UI imports (e.g. `src/log.js`) are bundled in as CommonJS, so the bundle's banner defines `require` with `createRequire` — without it their `require('node:fs')` fails at startup. `ui/tui/bundle.test.js` loads the bundle as plain ESM to catch that; `node -e` can't, since its global `require` hides the problem.
     - Those bundled modules are separate copies from the ones `Vin` `require()`s, so the UI must never rely on module-level state shared with the backend (an instance registry, a `WeakMap`, `instanceof` a backend class) — backend objects reach the UI only through `start(transport)`.
   - Tests use the built-in runner (`npm test` → `node --test`); test files sit next to the code they test as `*.test.js`, or `*.test.jsx` for UI components (rendered with [ink-testing-library](https://github.com/vadimdemedes/ink-testing-library)). `test/jsx-hooks.js` transpiles `.jsx` on load with esbuild, since Node can't parse JSX.
2. **[Ink](https://github.com/vadimdemedes/ink)** for the TUI — React for interactive command-line apps. A directory with thousands of entries is windowed (only visible rows mounted), never rendered as one giant list — Ink itself renders at a throttled ~32 FPS and runs 50MB+ of RAM, so pagination matters more than the FPS cap.
3. **Electron + React** — out of scope for now. Kept in mind as a possible future GUI, reusing the same component patterns as the Ink TUI.
4. **[JSON5](https://json5.dev/)** for configuration — human-editable (comments, trailing commas, unquoted keys), unlike vifm's proprietary config language. Parsed with [momoa](https://github.com/humanwhocodes/momoa), which keeps line and column for every value, so errors point into the file.
5. **Cross-platform** — Windows, Linux, and macOS. Paths are shown Unix-style on every OS (`~/…`, `/c/…`, `//server/share/…`), but input accepts native ones too (`C:\folder\file`, pasted from Explorer), and the native form is what goes to the OS and, later, the clipboard.

## Code Conventions

- Always write JSDoc for every class, function, method, and exported value — `@param`, `@returns`, `@typedef`, `@type` — so VS Code gives autocompletion and hover docs in plain JS.
- When JSDoc isn't enough (overloads, complex generics, a plugin-facing API, or the shape of a module crossing the CommonJS/ESM boundary), add a `.d.ts` next to the file (`foo.js` → `foo.d.ts`). A sibling `.d.ts` replaces the inferred types for everyone importing that file, so keep it complete and in sync.
- `jsconfig.json` configures VS Code's JS language service (module resolution, JSX) with `checkJs` on, so type errors show in the editor; `npm run typecheck` runs the same check with TypeScript 7, which is used only as a checker, never to compile. `@types/node` is pinned to the Node major version in use.
- Debug output goes through `log` from `src/log.js`, never `console` — Ink owns stdout/stderr while the TUI runs. Unset, `VIN_LOG` sends errors only to `vin.log` in the project root (git-ignored); `VIN_LOG=<file>` logs every level there instead, and an empty one turns logging off (as `test/setup.js` does).

## Project Structure

- `src/` — backend source.
- `plugins/` — one directory per plugin. Each plugin mirrors this project's own structure (minus the `plugins/` folder itself), so a plugin with a `ui/<technology>/` directory supports that UI.
- `plugins/<name>/plugin.json5` — manifest declaring how the plugin is loaded, plus a protocol version. The folder convention alone can't tell a native plugin apart from a foreign one, so this needs to be explicit:
  - **native** — `require`d directly as a JS module (in-process; see Architecture).
  - **foreign** — out-of-process, talking to `Vin` over JSON-RPC over stdio (see Architecture); spawned either as a pure executable (a compiled binary) or an interpreted project (e.g. Node, Python) via its runtime's command (`node index.js`, `python main.py`, …).
- `ui/` — frontend source.
- `ui/tui/` — the Ink TUI implementation.
- `ui/<technology>/` — any other UI implementation (e.g. React, for the Electron GUI, if that's revisited).

## Glossary

- **Window** — in the TUI, an overlay with its own controls that appears over the current view; in the GUI, an ordinary window.
- **UI** — either the TUI or the GUI. The backend only exposes APIs and models; it has no awareness of how they're rendered.

## Architecture

- Backend: OOP. Frontend (Ink TUI now; Electron+React later, if pursued): standard functional React.
- Backend:
  - `Handler` — each subclass is the handler for one window.
  - `Vin` — a standalone class (not a `Handler` subclass) that manages every handler and the event system between them, and starts the UI, connecting it to them.
  - A `Handler` can contain sub-handlers, nested to any depth. The UI addresses one by chaining names — `handler.subhandler.method()`, `handler.subhandler.subsubhandler.method()`, and so on (the same dot-notation already used for the CLI convention in Controls, e.g. `vin zip.zip <files>`).
    - Callable by path: every method a `Handler` subclass defines, except `_underscored` and `#private` ones — prefix helpers accordingly. `Handler`'s own methods (lifecycle, tree management) never are, and neither are fields or getters.
    - Lifecycle: `init()` runs `onInit()`, then initializes sub-handlers in the order they were added; `dispose()` disposes them in reverse, then runs `onDispose()`. Subclasses override the `on…` hooks, never `init`/`dispose` themselves.
  - Every `Handler` exposes two APIs for updating its window's state:
    - `this.update(state)` — fully replaces the window's state (model) and registers its top-level properties (components whose selected slice changed re-render).
    - `this.state.<propName>.<subPropName> = …` — edits a single property (triggers a re-render of just its subscribers, via `useSelector` on the React side).
    - Rules (`src/state.js`): state is JSON data only (no `undefined`, class instances, `Map`, `Date`, …), since the same messages go over JSON-RPC. Top-level properties come only from `update()` — assigning or deleting an unregistered one throws; nested objects take new keys freely. Values are copied in and out, so state never shares objects with callers or the UI. Arrays can't get holes (remove items with `splice()`), and an array method like `push` or `sort` is sent as one patch of the whole array. A reference read from `this.state` goes stale once its object is replaced or moves (e.g. after `shift()`), and writing through it throws — read it again from `this.state`.
    - The UI declares nothing: `ui/tui/common/store/` mirrors whatever state a handler sends, and components read it with `useSelector(init('main.left').store, (state) => state.cwd)`.
  - Events (`src/events.js`): `this.emit('changed', payload)` publishes `<handler path>.changed` (`main.left.changed`), and `this.on('main.left.changed', (payload, { source }) => …)` listens until the listening handler is disposed. Names always carry the emitter's path, so they can't collide and no handler can emit on another's behalf. Delivery is a microtask later — never inside the emitter's code, as it can't be for an out-of-process plugin; payloads are JSON data, deep-frozen, one copy shared by all listeners. A handler reaches the bus once its top-level handler is registered with `Vin`. Events are backend-only: the UI follows state, not events.
  - Plugins come in two tiers:
    - **Native plugins** — in-process `Handler` subclasses, `require`d directly; for performance-sensitive built-ins.
    - **Foreign plugins** — out-of-process, written in any technology, talking to `Vin` over JSON-RPC over stdio (the same [`vscode-jsonrpc`](https://www.npmjs.com/package/vscode-jsonrpc)-style channel already used to talk to the UI) — this also gives them a natural sandboxing boundary.
  - A foreign plugin's GUI is declarative: its Handler-equivalent state, sent over JSON-RPC, is built from a fixed vocabulary of components (list, table, form field, text, progress bar, menu entry, …) that `Vin`'s own Ink/React components render — the plugin describes *what* to show, never *how*, reusing the existing `this.update(state)`/`this.state.x = y` sync as-is (see [Yazi's Lua UI API](https://yazi-rs.github.io/docs/plugins/overview/) for prior art). Two escape hatches, if the vocabulary ever proves too limited: a full-screen terminal takeover (suspend Ink, hand the plugin raw tty, restore on exit — as vifm/vim do for `$PAGER`/`$EDITOR`), or, once Electron is revisited, a sandboxed webview using `postMessage` ([VS Code's model](https://code.visualstudio.com/api/extension-guides/webview)).
  - Either way, a plugin is a separate handler with its own GUI. Core functionality is just a collection of Handlers; plugins communicate with other Handlers — and with `Vin` — through the event system.
  - Plugins can only modify existing GUI or logic through predefined **extension points** — fixed areas that expose their own contribution interface — rather than editing arbitrary GUI/logic directly. The context menu (see Controls) is one such area: plugins add entries through its interface instead of rewriting the menu itself.
  - Contribution registry (`src/contributions.js`) — that mechanism. Named points (`commands`, `keybindings`, `contextMenu`; more can be defined) collect items, each checked by the point's normalizer, so a mistake fails with a message naming its source and field (unknown fields are errors, not ignored). A handler class declares its items as data in `static contributes` — the same shape a plugin manifest will use (4.2, 4.3) — registered while at least one instance of its kind is initialized.
    - Kind: every handler has one — its class's `static kind`, or else its name — and a kind belongs to one class. Commands are `<kind>.<method>` (`pane.down`), so both panes share one command; it runs on the instance of that kind nearest the focused handler (itself or an ancestor), or on the only instance there is.
    - A command declares its surfaces: `tui` (default `true`) and `cli` (default `false`).
    - The built-in `core` handler (`src/handlers/core/`, always registered first, so the name is reserved) mirrors the registry in its state (`contributions.commands`, …) and runs commands for the UI on the focus (`core.execute(command, args)`).
  - Keybindings — `{ key, command, args?, mode? }` contributions, in VS Code-style notation (`src/keys.js`; see [CONTROLS.md](CONTROLS.md)). Matching runs in the backend: the UI turns each key into a canonical chord and sends it (`core.press(chord)`, via `useKeybindings()` in `ui/tui/common/keys/`), and the backend applies it to its own focus, so a future GUI gets the same behavior.
    - Scope: a binding is active while a handler of its command's kind is on the focus chain — the focused handler, its ancestors up to its window's handler, then `core` (so `core.*` bindings are global, and covered windows get no keys) — and that handler is in the binding's `mode` (its `state.mode`, or `normal`). The deepest match wins, so a pane's `j` shadows the main window's; among equals, the last contributed.
    - Sequences (`g g`, `ctrl+w h`) wait up to 1 s for the next key, like vifm's `timeoutlen`; a binding that is also the prefix of a longer one fires when the wait runs out. `core`'s `pendingKeys` state shows a sequence in progress.
    - User remapping: user config contributes with `{ user: true }` — applied after every other source, and allowed to remove bindings (`{ key?, command: '-pane.down' }`); they come from the config file's `keybindings`.
  - Windows (`src/windows.js`) — the backend owns the stack and the focus, mirrored in `core`'s `windows` state (bottom to top: `id`, `path`, `kind`, `focus`). `await vin.openWindow('main')` opens a lasting window, there until its handler is disposed; `await this.openWindow(new Confirm(…))` adds a transient one to the opener as a sub-handler, on top with the focus, and resolves with its result — `this.close(result)` inside it, or `null` for Escape (`core.closeWindow`) or disposal. Closing disposes it and the windows it opened. `this.focus()` takes the focus within a handler's window; each window keeps its own for when it's uncovered.
    - The UI draws the bottom window full-size and the rest as centered overlays (`ui/tui/common/windows/`), each by the component for its kind (`ui/tui/windows.js`), and releases a closed window's stores (`release(path)` in `ui/tui/handler.js`).
  - Configuration (`src/config.js`) — `config.json5` in the project root (git-ignored; vin's files stay in the project — config next to `plugins/`, not in per-OS config directories), created on first start listing every declared option, commented out. Options are contributions (`configuration`: `{ key, type, default, description?, enum?, minimum?, maximum? }`) set in the file under their kind (`pane: { showHidden: true }`); any handler reads any option with `this.config.get('pane.showHidden')`. `start()` parses the file before `init()` (invalid values read as their defaults meanwhile) and checks it after; any mistake — syntax, unknown section/option/command, wrong type — stops vin before the UI with every problem as `file:line:col`.
    - Options are known once a handler of their kind is initialized, so a kind created later (a dialog) can't declare options yet — its section would be reported as unknown.
  - Main entry points: `index.js` (repo root) creates `Vin` (`src/vin.js`) and starts it; `src/handler.js` is the `Handler` base class; `src/handlers/<handler-name>/` holds each handler's sources, with sub-handlers nested the same way (`src/handlers/<handler-name>/<subhandler-name>/`).
- UI:
  - Talks to the backend over JSON-RPC, or directly where that's unnecessary (e.g. the TUI, which runs in the same process).
  - Entry points (TUI example):
    - `ui/tui/handler.js` — exposes `init(handlerName)`, creating an instance for calling methods on the named backend handler (via JSON-RPC or as a direct proxy). The handle chains names (`init('main').left.navigate('/tmp')` returns a promise of the result); `store`, `path`, and `then` are its own properties, so a sub-handler or method with one of those names is reached through `init('main.store')`. `connect(transport)` wires it to the backend first.
    - `ui/tui/index.jsx` — UI initialization entry point.
    - `ui/tui/<handler-name>/<handler-name>.jsx` — UI entry point for that handler.
    - `ui/tui/<handler-name>/index.js` — re-export, for a more convenient import path.
    - `ui/tui/common/<name>/` — shared UI elements, including ones wired to backend handlers.
- Frontend/backend communication:
  - The UI holds its own copy of a window's state (its store); the backend is authoritative. `this.state.x = y` updates the backend's copy and sends an update so the UI's copy converges — it doesn't reach into the UI's memory directly. This is what makes the same API work whether UI and backend share a process (the TUI today) or run as two separate processes (e.g. a future Electron main/renderer split): the wire message is the same either way, only the transport changes.
  - The backend only ever talks to the UI by changing properties on its state (model), or replacing the whole model; the UI calls backend functions over JSON-RPC, or — for the TUI — directly or through a proxy.
  - Both go through a `Transport` (`src/transport.js`) with two operations — `call(path, args)` and `subscribe(handler, listener)`. `Vin` hands the TUI an in-process one; it still copies arguments and results as JSON and reduces errors to their message and `code`, so nothing works in-process that would break over JSON-RPC. The UI never imports `Vin` or handlers directly.
  - Every handler has a name, and every UI window connects to its handler by that name — a sub-handler's name is the dotted chain down to it (`handler.subhandler`), so `handler.subhandler.method()` calls `method` on that sub-handler directly.
- Errors (`src/errors.js`, `src/messages.js`) — nothing that fails takes vin down. A failure is *expected* when its `code` says so (the file system's `ENOENT`, `EACCES`, …; the network's; vin's `EPATH`, `ECONFIG`, and `EFAIL` from `failure(message)`) — the code, since that's what survives JSON-RPC. It's shown in words (`Permission denied: ~/x`); anything else is a bug, shown as unexpected and logged with its stack. Messages live in `vin.messages`, mirrored in `core`'s `messages` state; `core.press` clears them, so each stays until the next key. What reports: commands run by keys, event listeners, window disposal, handlers (`this.report(error)`, `this.notify(text, level)`), and — while the UI runs — uncaught exceptions and unhandled rejections, after which vin carries on.
  - The TUI shows one message that fits on the bottom line, and more in a popup that a key only dismisses (`core.clearMessages(upTo)`); a window whose component throws shows the error in its place.
- Paths (`src/paths.js`) — kept in native absolute form; `paths.resolve(input, base)` reads any typed or pasted form (or throws an `EPATH` error with the reason), `paths.display(path)` shows it Unix-style. Its header lists the Windows edge cases.
- File access (`src/fs/`): a `FileSystemProvider` interface (`stat`, `readDirectory`, `createDirectory`, `readFile`, `writeFile`, `delete`, `rename`, optional `copy`, read/write streams, `watch`), implemented once per protocol and consumed uniformly everywhere else (modeled on VS Code's `FileSystemProvider`). Resources are URI strings (`file:///C:/Users/me`; `paths.toUri()`/`fromUri()`) whose scheme picks the provider; handlers use `this.fs`, which dispatches. Every provider fails with Node's `fs` error codes (`ENOENT`, `EEXIST`, …), and never replaces anything unless asked (`{ overwrite: true }`).
  - The local disk (`src/fs/local.js`) is the only provider so far; moving between providers waits for 5.5, the OS trash for 2.9.
  - Network protocols are in scope for later — SFTP via [`ssh2`](https://github.com/mscdex/ssh2)/[`ssh2-sftp-client`](https://www.npmjs.com/package/ssh2-sftp-client), FTP/FTPS via [`basic-ftp`](https://www.npmjs.com/package/basic-ftp). WebDAV excluded for now.
  - TBD: whether a protocol provider is its own concept alongside `Handler`, or just a specific kind of Handler.

## Use Cases and Interactions

Keybindings live in [CONTROLS.md](CONTROLS.md), kept separate since they're not a copy of vifm's and are expected to keep changing.

- A context menu for the selected file or folder. Needs to be designed so handlers can contribute their own entries, and so users can customize it.
- Handlers usable directly from the terminal — any handler (including plugins) can register its own `--help` instructions, e.g.:
  ```
  vin zip.zip <files>
  vin zip.unzip <files>
  ```
- A command line for typed commands. Its own design — including user-defined aliases/commands — is out of scope for now; revisit later.
- One contribution/registry pattern (the extension-point mechanism from Architecture) is reused for the context menu, the command line, and CLI subcommands, rather than three bespoke ones.
- CLI dispatch (`vin <handler>.<command> <args>`) uses a subcommand-dispatch library (e.g. [yargs](https://github.com/yargs/yargs)'s command modules): each Handler registers its own subcommand and help text at load time — the way `git`/`npm` delegate to subcommands — so `Vin` never needs a hardcoded list of every handler's CLI surface.
- Not every Handler method is reachable from every surface: a command declares which surfaces expose it (e.g. `tui: true, cli: true` in its manifest), so a command needing an open window/selection can stay TUI-only, and a one-shot batch operation can be CLI-only.
- Adapters exist only for the CLI surface. vin is a TUI application by default (like vifm), so a Handler method's native call shape already matches how the TUI invokes it — current window/selection context and all. The CLI dispatcher is what needs the adapter: it translates `vin <handler>.<command> <args>` into that same native call, synthesizing whatever context (e.g. a target file) the TUI would otherwise supply from the current selection.

## Git Workflow

- Local only — no `git push`.
- A separate branch per feature/fix.
- Run `npm run check` (typecheck + build + tests) before merging into `master`.
- A bug fix should add a test covering the regression it fixes, when that's reasonable and doesn't take too long — not a hard requirement.
- Never delete branches or squash commits.

## TODO

Feature roadmap; milestones are in rough dependency order. Item IDs (`2.3`) are stable — don't renumber when items are added, finished, or dropped; a new item takes the next free number in its milestone. Keys for any of these features go in [CONTROLS.md](CONTROLS.md).

### 0. Foundation

- [x] 0.1 Git repo on `master`, branch per feature/fix.
- [x] 0.2 Project skeleton — CommonJS backend, ESM UI, `Vin` entry point, `node --test`.
- [x] 0.3 JSX build with esbuild (`npm start`, `npm run dev`).
- [x] 0.4 JSDoc, `jsconfig.json`, and `@types/*` for VS Code autocompletion.
- [x] 0.5 `npm run typecheck` — TypeScript as a dev-only checker of the JSDoc types (`tsc --noEmit`; code stays plain JS); run it with the tests before merging.
- [x] 0.6 Tests for `.jsx` components — a module hook transpiles JSX on load; ink-testing-library 4 works with Ink 7.
- [x] 0.7 `prepare` script that builds `dist/` (it's git-ignored), so a fresh `npm install` + `npm link` gives a working global `vin`.
- [x] 0.8 Debug log file (`VIN_LOG=<file>`) — stdout/stderr belong to Ink while the TUI runs.

### 1. Core architecture

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
- [ ] 1.14 Standard dialogs — confirm, text input, and choice list as reusable windows (1.8), with their keys, for delete (2.9), rename and create (2.7), conflict prompts (2.10), and passphrases (5.2). Built-in handlers with their own Ink components; the declarative vocabulary foreign plugins build UI from stays in 4.6.

### 2. Local file manager (MVP)

- [ ] 2.1 Main window — two-pane split view (the panes as sub-handlers of its handler), switching the active pane, optional single-pane mode.
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
- [ ] 2.17 Session state — restore each pane's directory and view options on start; a `--choose-dir`-style option (vifm has one) so a shell function can `cd` to vin's last directory on exit.
- [ ] 2.18 Startup paths — `vin [left-path] [right-path]` opens the panes there, as vifm does.

### 3. Context menu and CLI

- [ ] 3.1 Context menu (`Space`) — the first extension point: built-in entries (open, open with, rename, copy, move, delete, properties) plus contributed ones, shown by condition (file or directory, single or multiple selection, extension, provider); users hide, reorder, and add entries in config.
- [ ] 3.2 CLI dispatcher — yargs command modules (yargs 18 loads fine with `require()` on Node 24): `vin` opens the TUI, `vin <handler>.<command> <args>` runs a `cli: true` command, per-handler `--help`, `--version`; plain output and meaningful exit codes for scripting.
- [ ] 3.3 CLI adapters — build the context the TUI would supply (e.g. target files from arguments), so the handler method runs unchanged.
- [ ] 3.4 Resolve the ambiguity between `vin <path>` (2.18) and `vin <handler>.<command>` — `zip.zip` could be either; e.g. registered commands win, and `vin ./zip.zip` forces a path.

### 4. Plugins

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

### 5. Network protocols

- [ ] 5.1 Decide the Architecture TBD — protocol provider as its own concept or a kind of Handler; if the latter, protocols could ship as native plugins. A foreign one can't hand over Node streams, so its reads and writes need chunks over JSON-RPC.
- [ ] 5.2 Connections — saved in config (host, port, user, auth method); SSH agent or key files, with passphrase/password prompts at connect time — secrets never stored in plain config; SFTP host keys checked against `known_hosts` (ssh2 only verifies through a caller-supplied `hostVerifier`).
- [ ] 5.3 SFTP provider (`ssh2-sftp-client`) — the full provider interface including streams; SFTP has no change notifications, so `watch` falls back to polling or manual refresh.
- [ ] 5.4 FTP/FTPS provider (`basic-ftp`) — prefer FTPS (plain FTP sends credentials in cleartext); one operation at a time per connection, so queue operations or pool connections.
- [ ] 5.5 Cross-provider copy/move — streamed between any two providers with progress and cancel; a move across providers is copy + delete; names invalid on the target OS (e.g. `:` or `?` from a Linux server to Windows) are reported or renamed.
- [ ] 5.6 Remote open/edit — download to a temp file, open it, upload on save/exit (as mc and WinSCP do); temp files cleaned up.
- [ ] 5.7 Resilience — timeouts, keep-alive, reconnect; slow listings show a loading state and can be cancelled, never blocking the UI.

### 6. Command line (`:`)

Design deferred (see Use Cases and Interactions).

- [ ] 6.1 Design — syntax, completion, history, user-defined aliases/commands (vifm's `:command`), running shell commands on the selected files.
- [ ] 6.2 Implement on the contribution registry (1.6).

### 7. Later / maybe

- [ ] 7.1 Undo for file operations (vifm has it).
- [ ] 7.2 Directory bookmarks.
- [ ] 7.3 Tabs.
- [ ] 7.4 Directory sizes computed on demand.
- [ ] 7.5 Permission/ownership editing (Unix) and attributes (Windows).
- [ ] 7.6 Recursive find and content search — a good plugin candidate.
- [ ] 7.7 Archives as a `FileSystemProvider` — browse a zip like a directory.
- [ ] 7.8 Themes and color schemes (possibly honoring `LS_COLORS`).
- [ ] 7.9 Image previews in terminals with a graphics protocol (Kitty, Sixel).
- [ ] 7.10 Distribution as a single executable — and then where `config.json5` and `plugins/` live, since they sit in the project root until then.
- [ ] 7.11 Electron + React GUI — out of scope (Tech Stack 3); the architecture keeps it possible.

