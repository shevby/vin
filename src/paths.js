const os = require('node:os');
const nodePath = require('node:path');

/**
 * Local paths: reading what the user types or pastes, and showing paths back.
 *
 * vin keeps a path in the OS's own absolute form — `C:\Users\me\x`, `\\server\share\x`, `/home/me/x` —
 * which is what `fs` takes and what goes to the clipboard. It shows paths Unix-style on every OS: the home
 * directory as `~`, a Windows drive as `/c/…` (as Git Bash does), a UNC share as `//server/share/…`.
 *
 * `resolve()` accepts every form `display()` produces, so a shown path can be edited and read back, plus the
 * native ones (a path copied from Explorer, quotes included). On Windows:
 * - `/c/…` is drive `C:` when written with forward slashes; `\c\…` keeps its native meaning (a folder `c`
 *   at the root of the current drive), and so does any other absolute Unix path (`/tmp` is `\tmp` there) —
 *   Git Bash's other mounts aren't mapped.
 * - `\\?\C:\…` and `\\?\UNC\server\share\…` lose the prefix; device paths (`\\.\…`) are refused.
 * - `C:x` is relative to the base directory if that's on `C:`, else to `C:\` — vin doesn't track a current
 *   directory per drive, as `cmd` does.
 * - Names can't hold `< > : " | ? *` or control characters.
 *
 * `~` and `~/…` are the home directory; `~name` is an ordinary name — other users' homes aren't looked up.
 * `..` is resolved as text (the logical path, as a shell's `cd` does), never through symlinks.
 */

/** The `code` of every error about a path the user gave. */
const PATH_ERROR = 'EPATH';

/** A path the user gave that can't be read, with the reason. */
class PathError extends Error {
  /**
   * @param {string} input
   * @param {string} reason
   */
  constructor(input, reason) {
    super(`Invalid path "${input}": ${reason}`);
    this.name = 'PathError';
    this.code = PATH_ERROR;
    this.input = input;
  }
}

/** Characters Windows doesn't allow in names (besides control characters). */
const WINDOWS_INVALID = /[<>:"|?*\x00-\x1f]/;

/** The path rules of one OS, with the home directory to show as `~`. */
class Paths {
  /** @type {boolean} */
  #windows;
  /** @type {typeof nodePath.win32} */
  #path;

  /**
   * @param {object} [options]
   * @param {NodeJS.Platform} [options.platform] Whose rules: `win32`, or Unix for anything else.
   *   Default: this OS's.
   * @param {string} [options.home] An absolute path. Default: this user's home directory.
   */
  constructor({ platform = process.platform, home = os.homedir() } = {}) {
    this.#windows = platform === 'win32';
    this.#path = this.#windows ? nodePath.win32 : nodePath.posix;
    /** The home directory, in native form. */
    this.home = this.resolve(home);
  }

  /**
   * Reads a path the user typed or pasted into the native absolute form: separators unified, `.` and `..`
   * resolved, no trailing separator except at a root, a Windows drive letter uppercased.
   * @param {string} input
   * @param {string} [base] The directory a relative path is relative to, as `resolve()` returns it.
   * @returns {string}
   * @throws {PathError} If `input` can't be a path, or is relative and there's no `base`.
   */
  resolve(input, base) {
    if (typeof input !== 'string') {
      throw new TypeError(`A path must be a string; got ${typeof input}`);
    }
    /** @param {string} reason */
    const fail = (reason) => new PathError(input, reason);

    let text = input;
    if (this.#windows && text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
      // Explorer's "Copy as path" quotes it; `"` can't be part of a Windows name anyway.
      text = text.slice(1, -1);
    }
    if (!text) {
      throw fail('it is empty');
    }
    if (text.includes('\0')) {
      throw fail("it can't contain a NUL character");
    }
    if (/^~(?=$|\/)/.test(text) || (this.#windows && /^~(?=\\)/.test(text))) {
      text = this.home + this.#path.sep + text.slice(1);
    }
    if (this.#windows) {
      // `< > " | *` never appear in a Windows path, so a stray one is reported as itself, not as some other
      // mistake; `:` and `?` can (`C:`, `\\?\`), so they're checked in the names once resolved.
      this.#checkNames(text.replace(/[:?]/g, ''), fail);
      text = this.#fromWindows(text, base, fail);
    } else if (!text.startsWith('/') && base === undefined) {
      throw fail("it is relative, and there's no directory to resolve it against");
    }

    const resolved = base === undefined ? this.#path.resolve(text) : this.#path.resolve(base, text);
    if (!this.#windows) {
      return resolved;
    }
    this.#checkNames(resolved.slice(this.#path.parse(resolved).root.length), fail);
    return resolved.replace(/^[a-z]:/, (drive) => drive.toUpperCase());
  }

  /**
   * @param {string} names Windows names and separators.
   * @param {(reason: string) => PathError} fail
   * @throws {PathError} If `names` holds a character Windows doesn't allow in names.
   */
  #checkNames(names, fail) {
    const invalid = WINDOWS_INVALID.exec(names);
    if (invalid) {
      const char = invalid[0] < ' ' ? `control character ${invalid[0].charCodeAt(0)}` : `"${invalid[0]}"`;
      throw fail(`Windows names can't contain ${char}`);
    }
  }

  /**
   * The Windows forms `path.win32` doesn't handle, or handles with the process's current directory: the
   * `\\?\` prefix, Git Bash drives, drive-relative paths, a UNC path without a share.
   * @param {string} text
   * @param {string | undefined} base
   * @param {(reason: string) => PathError} fail
   * @returns {string} A path `path.win32.resolve` handles on its own, given `base` for a relative one.
   */
  #fromWindows(text, base, fail) {
    const namespaced = /^[\\/]{2}([?.])[\\/](.*)$/s.exec(text);
    if (namespaced) {
      const [, kind, rest] = namespaced;
      if (kind === '.') {
        throw fail('device paths (\\\\.\\…) aren\'t supported');
      }
      if (/^UNC[\\/]/i.test(rest)) {
        text = `\\\\${rest.slice(4)}`;
      } else if (/^[a-z]:(?:[\\/]|$)/i.test(rest)) {
        text = rest;
      } else {
        throw fail('after \\\\?\\ only a drive (C:\\…) or UNC\\server\\share is supported');
      }
    }

    const bash = /^\/([a-z])(?=\/|$)/i.exec(text);
    if (bash) {
      return `${bash[1]}:\\${text.slice(2)}`;
    }
    if (/^[\\/]{2}/.test(text)) {
      if (!/^[\\/]{2}[^\\/]+[\\/]+[^\\/]/.test(text)) {
        throw fail('a UNC path needs a server and a share: \\\\server\\share');
      }
      return text;
    }
    const driveRelative = /^([a-z]):(?![\\/])/i.exec(text);
    if (driveRelative) {
      const drive = driveRelative[1].toUpperCase();
      const rest = text.slice(2);
      return base?.toUpperCase().startsWith(`${drive}:`) ? this.#path.join(base, rest) : `${drive}:\\${rest}`;
    }
    if (/^[a-z]:/i.test(text)) {
      return text;
    }
    if (base === undefined) {
      throw fail(/^[\\/]/.test(text)
        ? 'it has no drive, and there\'s no directory to take one from'
        : "it is relative, and there's no directory to resolve it against");
    }
    return text;
  }

  /**
   * Shows a path Unix-style: `~/…` under the home directory, else `/c/…` for a Windows drive,
   * `//server/share/…` for a UNC share, or the path itself on Unix. `resolve()` reads it back.
   * @param {string} path As `resolve()` returns it.
   * @returns {string}
   */
  display(path) {
    if (this.parent(this.home) !== null && this.#within(this.home, path)) {
      return `~${this.#slashes(path.slice(this.home.length))}`;
    }
    if (!this.#windows) {
      return path;
    }
    const drive = /^([a-z]):\\?(.*)$/is.exec(path);
    if (drive) {
      const [, letter, rest] = drive;
      return `/${letter.toLowerCase()}${rest ? `/${this.#slashes(rest)}` : ''}`;
    }
    return this.#slashes(path).replace(/(.)\/$/, '$1');
  }

  /**
   * @param {string} path As `resolve()` returns it.
   * @returns {string | null} The directory containing `path`, or `null` for a root (`/`, `C:\`,
   *   `\\server\share\`).
   */
  parent(path) {
    const parent = this.#path.dirname(path);
    return parent === path ? null : parent;
  }

  /**
   * @param {string} path As `resolve()` returns it.
   * @returns {string} Its last name, or `''` for a root.
   */
  basename(path) {
    return this.parent(path) === null ? '' : this.#path.basename(path);
  }

  /**
   * A directory's entry, e.g. a name `readDirectory` listed.
   * @param {string} directory As `resolve()` returns it.
   * @param {string} name One name: not empty, `.` or `..`, and without separators.
   * @returns {string}
   * @throws {PathError} If `name` isn't one name.
   */
  join(directory, name) {
    const separator = this.#windows ? /[\\/]/ : /\//;
    if (typeof name !== 'string' || !name || name === '.' || name === '..' || separator.test(name) || name.includes('\0')
      || (this.#windows && WINDOWS_INVALID.test(name))) {
      throw new PathError(String(name), 'it must be one name, not a path');
    }
    return this.#path.join(directory, name);
  }

  /**
   * Whether two paths name the same location — ignoring case on Windows. Unix paths compare exactly, even
   * on macOS, whose file system usually ignores case: that takes asking the file system.
   * @param {string} a As `resolve()` returns it.
   * @param {string} b
   * @returns {boolean}
   */
  equals(a, b) {
    return this.#windows ? a.toLowerCase() === b.toLowerCase() : a === b;
  }

  /**
   * @param {string} ancestor
   * @param {string} path
   * @returns {boolean} Whether `path` is `ancestor` or inside it.
   */
  #within(ancestor, path) {
    const prefix = ancestor.endsWith(this.#path.sep) ? ancestor : ancestor + this.#path.sep;
    return this.equals(ancestor, path) || this.equals(prefix, path.slice(0, prefix.length));
  }

  /**
   * @param {string} text
   * @returns {string} `text` with Windows separators as `/`.
   */
  #slashes(text) {
    return this.#windows ? text.replaceAll('\\', '/') : text;
  }
}

/** The rules of the OS vin runs on, with the current user's home directory. */
const paths = new Paths();

module.exports = { Paths, PathError, PATH_ERROR, paths };
