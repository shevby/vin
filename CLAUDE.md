# vin

A vifm-inspired terminal file manager with support for network protocols and user extensions.

## Tech Stack

1. **Node.js 24 LTS** — plain JavaScript, no TypeScript.
   - Backend (`src/`, native plugins, root `index.js`): CommonJS — `require()`, not `import`.
   - Frontend (`ui/`): ESM — `import`. Ink 7 and its `yoga-layout` dependency use top-level `await`, so they can't be `require()`d; `ui/package.json` sets `"type": "module"`. The backend crosses into the UI with a single dynamic `import()`, and the UI can `import` backend CommonJS modules directly.
   - Tests use the built-in runner (`node --test`); test files sit next to the code they test as `*.test.js`.
2. **[Ink](https://github.com/vadimdemedes/ink)** for the TUI — React for interactive command-line apps. A directory with thousands of entries is windowed (only visible rows mounted), never rendered as one giant list — Ink itself renders at a throttled ~32 FPS and runs 50MB+ of RAM, so pagination matters more than the FPS cap.
3. **Electron + React** — out of scope for now. Kept in mind as a possible future GUI, reusing the same component patterns as the Ink TUI.
4. **[JSON5](https://json5.dev/)** for configuration — human-editable (comments, trailing commas, unquoted keys), unlike vifm's proprietary config language.
5. **Cross-platform** — Windows, Linux, and macOS. On Windows, accept both native paths (`C:\folder\file`) and Git Bash-style paths (`/c/folder/file`); no concrete use case yet, but keep the path parser aware of both formats.

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
  - Every `Handler` exposes two APIs for updating its window's state:
    - `this.update(state)` — fully replaces the window's state (model) and re-registers every property (triggers a full re-render).
    - `this.state.<propName>.<subPropName> = …` — edits a single property (triggers a re-render of just its subscribers, via `useSelector` on the React side).
  - Plugins come in two tiers:
    - **Native plugins** — in-process `Handler` subclasses, `require`d directly; for performance-sensitive built-ins.
    - **Foreign plugins** — out-of-process, written in any technology, talking to `Vin` over JSON-RPC over stdio (the same [`vscode-jsonrpc`](https://www.npmjs.com/package/vscode-jsonrpc)-style channel already used to talk to the UI) — this also gives them a natural sandboxing boundary.
  - A foreign plugin's GUI is declarative: its Handler-equivalent state, sent over JSON-RPC, is built from a fixed vocabulary of components (list, table, form field, text, progress bar, menu entry, …) that `Vin`'s own Ink/React components render — the plugin describes *what* to show, never *how*, reusing the existing `this.update(state)`/`this.state.x = y` sync as-is (see [Yazi's Lua UI API](https://yazi-rs.github.io/docs/plugins/overview/) for prior art). Two escape hatches, if the vocabulary ever proves too limited: a full-screen terminal takeover (suspend Ink, hand the plugin raw tty, restore on exit — as vifm/vim do for `$PAGER`/`$EDITOR`), or, once Electron is revisited, a sandboxed webview using `postMessage` ([VS Code's model](https://code.visualstudio.com/api/extension-guides/webview)).
  - Either way, a plugin is a separate handler with its own GUI. Core functionality is just a collection of Handlers; plugins communicate with other Handlers — and with `Vin` — through the event system.
  - Plugins can only modify existing GUI or logic through predefined **extension points** — fixed areas that expose their own contribution interface — rather than editing arbitrary GUI/logic directly. The context menu (see Controls) is one such area: plugins add entries through its interface instead of rewriting the menu itself.
  - Main entry points:
    - `src/vin.js` — the `Vin` class: standalone, manages handlers and the event system, and starts the UI, connecting it to them.
    - `src/handlers/<handler-name>/` — sources for each Handler; sub-handlers nest the same way, e.g. `src/handlers/<handler-name>/<subhandler-name>/`.
    - `index.js` (repo root) — application entry point; creates `Vin` and starts the app.
- UI:
  - Talks to the backend over JSON-RPC, or directly where that's unnecessary (e.g. the TUI, which runs in the same process).
  - Entry points (TUI example):
    - `ui/tui/handler.js` — exposes `init(handlerName)`, creating an instance for calling methods on the named backend handler (via JSON-RPC or as a direct proxy).
    - `ui/tui/index.js` — UI initialization entry point.
    - `ui/tui/<handler-name>/<handler-name>.js` — UI entry point for that handler.
    - `ui/tui/<handler-name>/index.js` — re-export, for a more convenient import path.
    - `ui/tui/common/<name>/` — shared UI elements, including ones wired to backend handlers.
- Frontend/backend communication:
  - The UI holds its own copy of a window's state (its store); the backend is authoritative. `this.state.x = y` updates the backend's copy and sends an update so the UI's copy converges — it doesn't reach into the UI's memory directly. This is what makes the same API work whether UI and backend share a process (the TUI today) or run as two separate processes (e.g. a future Electron main/renderer split): the wire message is the same either way, only the transport changes.
  - The backend only ever talks to the UI by changing properties on its state (model), or replacing the whole model.
  - The UI calls backend functions over JSON-RPC, or — for the TUI — directly or through a proxy.
  - Every handler has a name, and every UI window connects to its handler by that name — a sub-handler's name is the dotted chain down to it (`handler.subhandler`), so `handler.subhandler.method()` calls `method` on that sub-handler directly.
- File access: a `FileSystemProvider`-style interface (`stat`, `readDirectory`, `readFile`, `writeFile`, `rename`, `delete`, `watch`, …), implemented once per protocol and consumed uniformly everywhere else (modeled on VS Code's `FileSystemProvider`).
  - First iteration: local disk only.
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
- Run tests before merging into `master`.
- A bug fix should add a test covering the regression it fixes, when that's reasonable and doesn't take too long — not a hard requirement.
- Never delete branches or squash commits.

