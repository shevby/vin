import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const bundle = fileURLToPath(new URL('../../dist/tui.mjs', import.meta.url));

test('the built TUI bundle loads as plain ESM', { skip: !existsSync(bundle) && 'dist/tui.mjs not built; run npm run build' }, () => {
  // In a child process with ESM input: a CommonJS context (like `node -e`) has a global `require`, which
  // would hide a bundle whose require() calls only work there.
  const script = `const ui = await import(${JSON.stringify(pathToFileURL(bundle).href)}); console.log(Object.keys(ui).join());`;
  const { status, stdout, stderr } = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(status, 0, stderr);
  assert.equal(stdout.trim(), 'start');
});
