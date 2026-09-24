const path = require('node:path');
const { pathToFileURL } = require('node:url');

class Vin {
  constructor() {
    this.handlers = new Map();
  }

  register(handler) {
    if (this.handlers.has(handler.name)) {
      throw new Error(`Handler "${handler.name}" is already registered`);
    }
    this.handlers.set(handler.name, handler);
  }

  getHandler(name) {
    return this.handlers.get(name);
  }

  async start() {
    // The UI is ESM (Ink can't be require()d), so this is the one dynamic import across the boundary.
    const entry = pathToFileURL(path.join(__dirname, '..', 'ui', 'tui', 'index.js')).href;
    const ui = await import(entry);
    await ui.start(this);
  }
}

module.exports = Vin;
