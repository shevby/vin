const childProcess = require('node:child_process');
const { failure } = require('./errors');
const { paths } = require('./paths');

/**
 * Opening a local file with the OS's default app (2.5), as a double click in the OS's file manager would —
 * an executable runs. Associations of vin's own and programs that take over the terminal are 2.23.
 *
 * Each OS has its own launcher, given the path as one argument, never through a shell, so no name is
 * parsed as a command:
 * - Windows: PowerShell's `Invoke-Item -LiteralPath`, with the path in an environment variable — `cmd`'s
 *   `start` would parse `&`, `^` and `%` in names. It shows the "open with" picker for a file with no app.
 * - macOS: `open`.
 * - Elsewhere: `xdg-open`, which a desktop without it (a bare server) lacks.
 */

/**
 * @typedef {object} Launcher
 * @property {string} file
 * @property {string[]} args
 * @property {NodeJS.ProcessEnv} [env] Added to vin's own.
 */

/**
 * @param {string} path Native and absolute.
 * @param {NodeJS.Platform} platform
 * @returns {Launcher}
 */
function launcher(path, platform) {
  if (platform === 'win32') {
    return {
      file: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-Command', 'Invoke-Item -LiteralPath $env:VIN_OPEN'],
      env: { VIN_OPEN: path },
    };
  }
  return { file: platform === 'darwin' ? 'open' : 'xdg-open', args: [path] };
}

/**
 * Opens a local file with the OS's default app. The launcher runs apart from vin, which can quit before it
 * ends; it never gets the terminal.
 * @param {string} path Native and absolute.
 * @param {object} [options] For tests.
 * @param {NodeJS.Platform} [options.platform] Default: this one.
 * @returns {Promise<void>} Once the launcher has handed the file on — for some of `xdg-open`'s fallbacks,
 *   only when the app ends.
 * @throws {Error} A failure (`src/errors.js`) if the launcher is missing or fails, with its reason.
 */
function openWithDefaultApp(path, { platform = process.platform } = {}) {
  const { file, args, env } = launcher(path, platform);
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(file, args, {
      env: env && { ...process.env, ...env },
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
      // Its own process group elsewhere, so it outlives vin; Windows would give it a console of its own.
      detached: platform !== 'win32',
    });
    child.unref();
    let stderr = '';
    child.stderr?.setEncoding('utf8').on('data', (data) => {
      stderr += data;
    });
    /** @type {any} */ (child.stderr)?.unref?.();
    child.on('error', (error) => {
      const missing = /** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT';
      reject(failure(missing
        ? `Can't open files: ${file} isn't installed`
        : `Can't open ${paths.display(path)}: ${error.message}`));
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      // PowerShell's first line is the one that says why: `Invoke-Item : Cannot find path …`.
      const reason = stderr.trim().split(/\r?\n/)[0]?.replace(/^Invoke-Item : /, '').trim();
      reject(failure(`Can't open ${paths.display(path)}: ${reason || `${file} exited with code ${code}`}`));
    });
  });
}

/** Through an object, so tests can replace it (`t.mock.method(opener, 'openWithDefaultApp')`). */
const opener = { openWithDefaultApp };

module.exports = { opener, launcher };
