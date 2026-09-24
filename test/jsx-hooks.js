const { registerHooks } = require('node:module');
const { readFileSync } = require('node:fs');
const { fileURLToPath } = require('node:url');
const { transformSync } = require('esbuild');

// node --test can't parse JSX, so .jsx files are transpiled on load with the same settings as the build.
registerHooks({
  load(url, context, nextLoad) {
    if (!url.startsWith('file:') || !url.endsWith('.jsx')) {
      return nextLoad(url, context);
    }
    const filename = fileURLToPath(url);
    const { code } = transformSync(readFileSync(filename, 'utf8'), {
      loader: 'jsx',
      jsx: 'automatic',
      format: 'esm',
      sourcefile: filename,
      sourcemap: 'inline',
    });
    return { format: 'module', source: code, shortCircuit: true };
  },
});
