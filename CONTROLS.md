# vin — Controls

Living reference for keybindings. This is deliberately separate from `CLAUDE.md`: vin's controls are not a copy of vifm's — some of vifm's bindings aren't convenient and are expected to diverge — and this list will keep changing during development and testing.

## Key notation

Keybindings — built-in, from plugins, and in user config — use VS Code-style notation:

- A chord is modifiers and a key joined by `+`: `ctrl+w`, `alt+x`, `shift+tab`, `cmd+c`. Modifiers are `ctrl`, `alt`, `shift`, and `cmd`, in any order and case.
- `cmd` is Cmd on macOS (the Windows/Super key elsewhere). A terminal reports it only through the [kitty keyboard protocol](https://sw.kovidgoyal.net/kitty/keyboard-protocol/) (kitty, WezTerm, Ghostty, iTerm2, …), which vin turns on where it's supported — and only for shortcuts the terminal doesn't keep for itself (most take `cmd+c`/`cmd+v` for their own copy and paste unless you unbind them). So a `cmd+` binding always comes with a `ctrl+` one.
- A sequence is chords separated by spaces: `g g`, `d d`, `ctrl+w h`. A sequence waits up to a second for its next key.
- Named keys: `space`, `tab`, `enter`, `escape`, `backspace`, `delete`, `insert`, `up`, `down`, `left`, `right`, `home`, `end`, `pageup`, `pagedown`.
- Function keys (`f1`–`f12`) are left to the OS: vin never binds them, and a binding that uses one is rejected.
- Any other key is the character it types: `j`, `:`, `?`, `+`. An uppercase letter is `shift` plus the lowercase one — `G` and `shift+g` are the same key. `shift` doesn't combine with other characters: write `:`, not `shift+;`.
- User config can remove a binding with a `-` before the command: `{ key: 'j', command: '-pane.down' }`.

## Keys

- Arrow keys and `hjkl` for navigation (see Panes).
- `Space` to open the context menu for the selected file or folder.
- `:` opens the command line.
- `Escape` closes the window on top (a dialog, a menu), never the main window; in a pane it unselects (see Panes).
- `z z` quits — for now: it goes once the command line brings `:q` (6.2).
- `ctrl+c`, `ctrl+x`, `ctrl+v` are copy, cut, and paste, as in Windows and Linux file managers — and on macOS `cmd+c`, `cmd+x`, `cmd+v` as well (2.7). `ctrl+c` doesn't quit.
- A message on the bottom line stays until the next key, which clears it and still does its job. While the message popup is up (several messages, or one too long for the line), any key only dismisses it.
- Everything else: TBD, added as it's built and tried out.

## Panes

Moving around a pane, mostly as in vifm:

- `j`/`k` or `Down`/`Up` — the next or previous entry.
- `g g`/`shift+g` or `Home`/`End` — the first or last entry.
- `ctrl+f`/`ctrl+b` or `PageDown`/`PageUp` — a page down or up: first to the bottom (top) row shown, then a page at a time, keeping one row of the last page in view. `ctrl+d`/`ctrl+u` — half a page.
- `l`, `Right`, or `Enter` — into the directory under the cursor, or open the file with the OS default app (as a double click does: a program runs). To have `l` and `Right` only enter directories, bind them to `pane.enter` in the config: `{ key: 'l', command: 'pane.enter' }`.
- `h`, `Left`, `Backspace`, or `alt+Up` — up to the parent directory, with the cursor on the one you came from. There's no `..` entry. On Windows, above a drive (`/c`) is the list of drives (`/`), each with its free space.
- `~` — the home directory.
- `alt+Left` (`ctrl+o`, as in vifm) / `alt+Right` — back and forward through the directories this pane has shown, as in a browser. vifm's forward key is `ctrl+i`, which terminals send as `Tab`, taken by switching panes.
- A directory you come back to — by any of these — has the cursor where you left it.

Selecting:

- `v` — select or unselect the entry under the cursor, and move down. Selected entries have a `✓` in a gutter before their names (there while anything is selected) and papercolor-dark's Selected color; the pane's bottom border counts them.
- `shift+v` — select a group: from the cursor to wherever it moves, on top of what's selected already. `shift+v` or `v` ends it, adding the group to the selection; the border says `GROUP` meanwhile.
- `Escape` — drop the group being selected, keeping the rest; else unselect everything.
- `ctrl+a` — select all; `*` — invert the selection.
- Going to another directory unselects everything.

Switching panes, as in vifm:

- `Tab`, `ctrl+w w`, `ctrl+w ctrl+w` — switch to the other pane.
- `ctrl+w h`, `ctrl+w l` — switch to the left or the right pane.
- `ctrl+w o` (`ctrl+w ctrl+o`) — show only the active pane; `Tab` then swaps which one is shown. `ctrl+w v` shows both again. `main.singlePane` in the config starts vin with one.

## Dialogs

Escape dismisses any dialog.

- **Confirm** — `y` / `n` answer at once; `Left`/`Right`, `h`/`l`, and `Tab` move between the buttons; `Enter` presses the highlighted one (a destructive question starts on No).
- **Choice list** — `j`/`k` or the arrows (`ctrl+n`/`ctrl+p`) move; `g g`/`shift+g` or `Home`/`End` jump to the ends; `Enter` picks; an option's own key (shown before it) picks it at once.
- **Text input** — typed characters and pastes go into the text, even keys bound elsewhere (`j`). `Enter` submits. Editing, readline-style:
  - `Left`/`ctrl+b`, `Right`/`ctrl+f` — a character; `ctrl+Left`/`alt+b`, `ctrl+Right`/`alt+f` — a word (letters and digits, so `.` and `/` end one).
  - `Home`/`ctrl+a`, `End`/`ctrl+e` — to the start or end.
  - `Backspace`, `Delete`/`ctrl+d` — a character; `ctrl+w`/`alt+Backspace`, `alt+d` — a word; `ctrl+u`, `ctrl+k` — to the start or end.
