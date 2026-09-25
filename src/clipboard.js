const childProcess = require('node:child_process');
const os = require('node:os');
const { failure } = require('./errors');
const { log } = require('./log');
const { paths } = require('./paths');

/**
 * vin's clipboard (2.7): entries copied or cut (yanked, in vim's words) to be pasted elsewhere — one for the
 * whole of vin, so a pane pastes what the other copied. The entries are URIs; their native paths also go on
 * the OS clipboard as text, one per line (Tech Stack 5), for other programs and for terminals whose `ctrl+v`
 * pastes the clipboard's text rather than sending the key (Windows Terminal): a pane recognizes its own
 * paths in a paste (`recognize()`) and pastes the entries, cut ones included.
 *
 * Writing to the OS clipboard goes through each OS's tool, given the text on stdin, never through a shell:
 * - Windows: PowerShell's `Set-Clipboard` — `clip.exe` would read the text in the console's code page, or
 *   keep a byte order mark as a character.
 * - macOS: `pbcopy`.
 * - Elsewhere: `wl-copy` under Wayland, else `xclip` or `xsel` — the first installed.
 */

/**
 * @typedef {'copy' | 'cut'} ClipboardMode
 */

/**
 * @typedef {object} ClipboardContent
 * @property {ClipboardMode} mode
 * @property {string[]} uris
 */

/**
 * @typedef {object} Writer
 * @property {string} file
 * @property {string[]} args
 * @property {BufferEncoding} encoding Of the text on stdin.
 */

/**
 * The tools that write text to the OS clipboard, in the order to try them.
 * @param {NodeJS.Platform} platform
 * @param {NodeJS.ProcessEnv} env
 * @returns {Writer[]}
 */
function writers(platform, env) {
  if (platform === 'win32') {
    return [{
      file: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-Command', '[Console]::InputEncoding = [Text.UTF8Encoding]::new($false); Set-Clipboard -Value ([Console]::In.ReadToEnd())'],
      encoding: 'utf8',
    }];
  }
  if (platform === 'darwin') {
    return [{ file: 'pbcopy', args: [], encoding: 'utf8' }];
  }
  return [
    ...env.WAYLAND_DISPLAY ? [{ file: 'wl-copy', args: [], encoding: /** @type {const} */ ('utf8') }] : [],
    { file: 'xclip', args: ['-selection', 'clipboard'], encoding: 'utf8' },
    { file: 'xsel', args: ['--clipboard', '--input'], encoding: 'utf8' },
  ];
}

/**
 * Runs one writer.
 * @param {Writer} writer
 * @param {string} text
 * @returns {Promise<void>}
 * @throws {Error} Node's `ENOENT` if it isn't installed; a failure if it fails.
 */
function run({ file, args, encoding }, text) {
  return new Promise((resolve, reject) => {
    // macOS's pbcopy reads the text in the locale's encoding.
    const child = childProcess.spawn(file, args, { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true, env: { ...process.env, LC_CTYPE: 'UTF-8' } });
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', (data) => {
      stderr += data;
    });
    child.on('error', reject);
    // A writer gone before reading everything fails below; the pipe's error says nothing more.
    child.stdin.on('error', () => {});
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(failure(`Can't put paths on the clipboard: ${stderr.trim().split(/\r?\n/)[0] || `${file} exited with code ${code}`}`));
      }
    });
    child.stdin.end(text, encoding);
  });
}

/**
 * Puts text on the OS clipboard.
 * @param {string} text
 * @param {object} [options] For tests.
 * @param {NodeJS.Platform} [options.platform] Default: this one.
 * @param {NodeJS.ProcessEnv} [options.env] Default: this process's.
 * @returns {Promise<void>}
 * @throws {Error} A failure (`src/errors.js`) if no tool is installed, or the one that is fails.
 */
async function writeText(text, { platform = process.platform, env = process.env } = {}) {
  const tools = writers(platform, env);
  for (const writer of tools) {
    try {
      await run(writer, text);
      return;
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') {
        throw error;
      }
    }
  }
  throw failure(`Can't put paths on the clipboard: install ${tools.map((writer) => writer.file).join(' or ')}`);
}

/** Through an object, so tests replace it (`test/setup.js` does, so tests never touch the user's clipboard). */
const system = { writeText };

/**
 * How a URI goes on the OS clipboard: its native path, or else the URI itself.
 * @param {string} uri A real one — `file:` for an entry in the trash.
 * @returns {string}
 */
function asText(uri) {
  try {
    return paths.fromUri(uri);
  } catch {
    return uri;
  }
}

/**
 * The entries pasted text names, if every line of it is an absolute path or a URI — as vin puts them on the
 * clipboard, or as Explorer's "Copy as path" does (quoted).
 * @param {string} text
 * @returns {string[] | null} URIs, or `null` if the text isn't a list of paths.
 */
function parsePaths(text) {
  const lines = text.split(/\r\n|\r|\n/).map((line) => line.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean);
  if (!lines.length) {
    return null;
  }
  /** @type {string[]} */
  const uris = [];
  for (const line of lines) {
    // A scheme of two letters at least: `C:` starts a Windows path.
    if (/^[a-z][a-z\d+.-]+:\/\//i.test(line)) {
      uris.push(line);
      continue;
    }
    try {
      uris.push(paths.toUri(paths.resolve(line)));
    } catch {
      // Relative, or not a path at all.
      return null;
    }
  }
  return uris;
}

/**
 * vin's clipboard, one per `Vin`; handlers reach it as `this.clipboard`.
 */
class Clipboard {
  /** @type {ClipboardContent | null} */
  #content = null;
  /** @type {(error: unknown) => void} */
  #report;
  /** @type {(uri: string) => string} */
  #realUri;
  /** Whether writing to the OS clipboard has failed before — reported once, logged after that. */
  #failed = false;

  /**
   * @param {object} options
   * @param {(error: unknown) => void} options.report Shows the first failure to write to the OS clipboard.
   * @param {(uri: string) => string} [options.realUri] The URI an entry really has — `file:` for one in
   *   the trash — whose path goes on the OS clipboard. Default: the URI itself.
   */
  constructor({ report, realUri = (uri) => uri }) {
    this.#report = report;
    this.#realUri = realUri;
  }

  /**
   * @param {string} uri
   * @returns {string} Its path, or else itself, as the OS clipboard gets it.
   */
  #text(uri) {
    try {
      return asText(this.#realUri(uri));
    } catch {
      return uri;
    }
  }

  /**
   * What's on it, if anything.
   * @returns {ClipboardContent | null} A copy.
   */
  get content() {
    return this.#content && { mode: this.#content.mode, uris: [...this.#content.uris] };
  }

  /**
   * Puts entries on the clipboard, and their paths on the OS's, in the background.
   * @param {ClipboardMode} mode
   * @param {string[]} uris
   * @throws {TypeError} If `mode` or `uris` is malformed.
   */
  set(mode, uris) {
    if (mode !== 'copy' && mode !== 'cut') {
      throw new TypeError(`Expected "copy" or "cut", got ${JSON.stringify(mode)}`);
    }
    if (!Array.isArray(uris) || !uris.every((uri) => typeof uri === 'string')) {
      throw new TypeError('Expected an array of URIs');
    }
    this.#content = { mode, uris: [...uris] };
    system.writeText(uris.map((uri) => this.#text(uri)).join(os.EOL)).catch((error) => {
      if (this.#failed) {
        log.debug('Writing the OS clipboard failed again:', error);
        return;
      }
      this.#failed = true;
      this.#report(error);
    });
  }

  /** Empties it — after cut entries are pasted, as they aren't where they were any more. */
  clear() {
    this.#content = null;
  }

  /**
   * What pasted text stands for: vin's clipboard if the text is its own paths — cut ones stay cut — or else
   * a copy of the entries the text names, if every line is a path.
   * @param {string} text
   * @returns {ClipboardContent | null} `null` if the text isn't a list of paths.
   */
  recognize(text) {
    const uris = parsePaths(text);
    if (!uris) {
      return null;
    }
    const own = this.#content;
    const key = (/** @type {string} */ uri) => this.#text(uri);
    if (own && own.uris.length === uris.length && own.uris.every((uri, i) => key(uri) === key(uris[i]))) {
      return this.content;
    }
    return { mode: 'copy', uris };
  }
}

module.exports = { Clipboard, system, writers, parsePaths };
