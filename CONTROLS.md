# vin — Controls

Living reference for keybindings. This is deliberately separate from `CLAUDE.md`: vin's controls are not a copy of vifm's — some of vifm's bindings aren't convenient and are expected to diverge — and this list will keep changing during development and testing.

## Key notation

Keybindings — built-in, from plugins, and in user config — use VS Code-style notation:

- A chord is modifiers and a key joined by `+`: `ctrl+w`, `alt+x`, `shift+tab`. Modifiers are `ctrl`, `alt`, and `shift`, in any order and case.
- A sequence is chords separated by spaces: `g g`, `d d`, `ctrl+w h`. A sequence waits up to a second for its next key.
- Named keys: `space`, `tab`, `enter`, `escape`, `backspace`, `delete`, `insert`, `up`, `down`, `left`, `right`, `home`, `end`, `pageup`, `pagedown`.
- Function keys (`f1`–`f12`) are left to the OS: vin never binds them, and a binding that uses one is rejected.
- Any other key is the character it types: `j`, `:`, `?`, `+`. An uppercase letter is `shift` plus the lowercase one — `G` and `shift+g` are the same key. `shift` doesn't combine with other characters: write `:`, not `shift+;`.
- User config can remove a binding with a `-` before the command: `{ key: 'j', command: '-pane.down' }`.

## Keys

- Arrow keys and `hjkl` for navigation.
- `Tab` to switch between split views.
- `Space` to open the context menu for the selected file or folder.
- `:` opens the command line.
- `Escape` closes the window on top (a dialog, a menu), never the main window.
- Everything else: TBD, added as it's built and tried out.
