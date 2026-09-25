# vin

> [!WARNING]
> **vin is still in development and hasn't been tested in real use.** It copies, moves, renames and deletes real files, and deleting is permanent unless you turn on the trash. Try it on files you can afford to lose, and keep backups. Keys and config options may change without notice.
>
> What exists so far is local file management: the MVP milestone on the [roadmap](ROADMAP.md) is nearly done. Network protocols, plugins, the context menu and the command line are planned but not built yet.

A terminal file manager inspired by [vifm](https://vifm.info/): two panes, vim-style keys, and everything configurable. It's written in JavaScript with [Ink](https://github.com/vadimdemedes/ink), and built to grow network protocols (SFTP, FTP) and plugins in any language.

## Features

- **Two panes**, side by side or one at a time, each with its own history (back/forward, like a browser) and cursor memory per directory.
- **Vim-style navigation**: `hjkl`, `g g`/`G`, page and half-page keys, key sequences with a timeout.
- **File operations** that run as background jobs, with progress and cancel: copy, cut and paste (also through the system clipboard as paths), copy or move to the other pane, symlinks, delete, create, and rename.
- **Bulk rename** with a pattern: `$n` and `$i` for counters, `$e` for the extension, previewed as you type.
- **Search** in the current directory or the whole tree below it, as you type. It takes wildcards (`*.md`) or JavaScript regular expressions (`/^re.+x$/`), and results jump to their location.
- **Sorting** by name (natural order), extension, size or modified time. **Hidden files** are shown faded by default, and can be hidden with one key.
- **Optional trash**, kept inside vin's folder and browsable at `/trash`, with restore.
- **Configuration in JSON5**: options, keybindings (remap or remove any key) and colors. Mistakes are reported with file, line and column before vin starts.
- **Cross-platform**: Windows, Linux and macOS. Paths are shown Unix-style everywhere (`~/…`, `/c/…`), but native ones pasted from Explorer work too. On Windows, the parent of `C:\` is a list of drives.
- **papercolor-dark** color scheme, ported from [vifm-colors](https://github.com/vifm/vifm-colors).

## Requirements

- [Node.js](https://nodejs.org/) 24 or newer
- A terminal with 256 colors. Terminals that support the [kitty keyboard protocol](https://sw.kovidgoyal.net/kitty/keyboard-protocol/) also get `cmd+` shortcuts on macOS.

## Install

vin isn't published to npm yet. Install it from source:

```sh
git clone https://github.com/shevby/vin.git
cd vin
npm install   # also builds the UI bundle
npm link      # puts `vin` on your PATH
```

Then run `vin` in any directory. Or, without linking, run `node index.js` from the repository.

## Keys

The essentials are below. The full list is in [CONTROLS.md](CONTROLS.md).

| Keys | Action |
| --- | --- |
| `j` `k` / arrows | Move the cursor |
| `l` / `Enter` / `→` | Enter a directory, or open a file with its default app |
| `h` / `Backspace` / `←` | Go to the parent directory |
| `alt+←` / `ctrl+o`, `alt+→` | Back and forward through history |
| `Tab` | Switch panes |
| `v`, `shift+v` | Select an entry, select a group |
| `y y`, `d d`, `p` | Copy, cut, paste (`ctrl+c`, `ctrl+x`, `ctrl+v` work too) |
| `y p`, `d p` | Copy or move to the other pane |
| `Delete` | Delete (asks first) |
| `c w` | Rename (on a selection: bulk rename) |
| `a` | Create a file, or a directory with a trailing `/` |
| `f` or `/`, `F` or `?` | Search here, or here and below; then `n`/`N` for next and previous |
| `o` | Sort menu |
| `z a` | Show or hide hidden files |
| `t` | Jobs window |
| `z z` | Quit |

## Configuration

On first start, vin creates `config.json5` in its own folder, listing every option commented out. Uncomment an option to change it:

```json5
{
  pane: {
    trash: true,          // Deleting moves entries to /trash instead of deleting for good.
    sortBy: 'modified',
  },
  main: {
    singlePane: true,
  },
  keybindings: [
    { key: 'l', command: 'pane.enter' },         // l only enters directories
    { key: 'o', command: '-pane.chooseSort' },   // A leading "-" removes a binding
  ],
  colors: {
    pane: { titleActive: { fg: 234, bg: 33 } },  // 256-color numbers, #hex, or names
  },
}
```

vin keeps everything it writes as it runs (its log, the trash) in a `.vin/` folder next to the config. Both the config and `.vin/` are git-ignored, so updating vin never touches them.

## Development

```sh
npm start          # build the UI bundle and run vin
npm run dev        # rebuild the bundle on every change
npm test           # run the tests (node --test)
npm run typecheck  # check the JSDoc types with TypeScript
npm run check      # typecheck, build, and test: run before merging
```

The code is plain JavaScript with JSDoc types. The backend in `src/` is CommonJS. The UI in `ui/tui/` is ESM and React, bundled with esbuild. The backend owns all state and logic in `Handler` classes, and the UI only mirrors that state and calls handler methods. That way, a future GUI or an out-of-process plugin could use the same messages. Debug output goes to `.vin/vin.log`; set `VIN_LOG=<file>` to log every level.

[ROADMAP.md](ROADMAP.md) lists what's done and what's next.

## License

[MIT](LICENSE) © Bohdan Shevchenko
