const Handler = require('./handler');
const { parseKeys } = require('./keys');
const { isName, isPath } = require('./names');
const { cloneData, deepFreeze } = require('./state');

/**
 * @typedef {import('./state').Data} Data
 * @typedef {InstanceType<typeof Handler>} AnyHandler
 */

/**
 * A command as declared in `static contributes.commands`: a handler method offered to the user.
 * @typedef {object} CommandContribution
 * @property {string} method The handler method it calls; its id becomes `<kind>.<method>`.
 * @property {string} title Shown in menus and help.
 * @property {string} [description]
 * @property {boolean} [tui] Reachable from the TUI (keys, menus). Default `true`.
 * @property {boolean} [cli] Reachable as `vin <kind>.<method>`. Default `false`.
 */

/**
 * @typedef {object} Command
 * @property {string} id `<kind>.<method>`, e.g. `pane.down`.
 * @property {string} kind The kind of handler it runs on.
 * @property {string} method
 * @property {string} title
 * @property {string | null} description
 * @property {boolean} tui
 * @property {boolean} cli
 * @property {string} source Who contributed it.
 */

/**
 * A keybinding. It's active while a handler of its command's kind is focused (or is an ancestor of the
 * focused one) and in `mode`; the nearest such handler wins over those around it, and runs the command.
 *
 * User config (`{ user: true }` contributions) may also remove bindings: `command: '-pane.down'` removes
 * every binding of `pane.down`, or only the one on `key` if given. User bindings apply after all others.
 * @typedef {object} KeybindingContribution
 * @property {string} key VS Code-style notation (`src/keys.js`): `j`, `shift+g`, `g g`, `ctrl+w h`.
 * @property {string} command A command id, e.g. `pane.down`.
 * @property {Data[]} [args] Passed to the command's method.
 * @property {string} [mode] The window mode it applies in — the target handler's `state.mode`, or `normal`
 *   if it has none. Default `normal`.
 */

/**
 * @typedef {object} Keybinding
 * @property {string} key Canonical notation.
 * @property {string[]} keys Its chords.
 * @property {string} command
 * @property {Data[]} args
 * @property {string} mode
 * @property {string} source
 * @property {boolean} user From user config.
 */

/**
 * @typedef {object} MenuContribution
 * @property {string} command A command id.
 * @property {string} [title] Overrides the command's title.
 * @property {string} [group] Entries of a group are shown together. Default: ungrouped.
 * @property {number} [order] Sorts entries within a group. Default `0`.
 * @property {Data[]} [args] Passed to the command's method.
 */

/**
 * @typedef {object} MenuEntry
 * @property {string} command
 * @property {string | null} title
 * @property {string | null} group
 * @property {number} order
 * @property {Data[]} args
 * @property {string} source
 */

/**
 * What a handler class declares in `static contributes` — and, later, what a plugin declares under
 * `contributes` in `plugin.json5`: items for each extension point, by the point's name.
 * @typedef {{ commands?: CommandContribution[], keybindings?: KeybindingContribution[], contextMenu?: MenuContribution[], [point: string]: unknown[] | undefined }} Contributes
 */

/**
 * @typedef {object} ContributionContext
 * @property {string} source Who contributes: a handler kind (later, also a plugin name).
 * @property {AnyHandler} [handler] An instance of that kind, when it's a handler, to check items against.
 * @property {boolean} [user] The user's own config: applied after everything else, and may remove items.
 */

/**
 * Checks one raw item and returns it normalized — JSON data, with every optional field filled in. An item
 * with an `id` must have one unique within its point.
 * @typedef {(item: unknown, context: ContributionContext, where: string) => { [key: string]: Data }} Normalize
 */

/**
 * Turns a point's normalized items, in order (user config last), into what `get()` returns — e.g. applying
 * user removals.
 * @typedef {(items: { [key: string]: Data }[]) => { [key: string]: Data }[]} Compose
 */

/**
 * The one extension-point mechanism: named points (`commands`, `keybindings`, `contextMenu`, and later ones
 * a plugin may define) that collect items from any number of contributors, each checked by the point's
 * normalizer, so a mistake in a declaration fails with a readable message naming its source.
 *
 * Handlers contribute through their class's `static contributes`, registered while at least one instance of
 * the class's kind is initialized. Commands are addressed by kind (`pane.down`) and run on an instance of
 * that kind — the focused one, when there are several.
 */
class Registry {
  /** @type {Map<string, { normalize: Normalize, compose: Compose | null }>} */
  #points = new Map();
  /** @type {Map<string, { source: string, user: boolean, items: { [key: string]: Data }[] }[]>} */
  #records = new Map();
  /** @type {Map<string, { type: Function, instances: Set<AnyHandler>, release: () => void }>} */
  #kinds = new Map();
  /** @type {Set<(point: string) => void>} */
  #listeners = new Set();

  constructor() {
    this.definePoint('commands', normalizeCommand);
    this.definePoint('keybindings', normalizeKeybinding, composeKeybindings);
    this.definePoint('contextMenu', normalizeMenuEntry);
  }

  /**
   * Names of the defined extension points.
   * @returns {string[]}
   */
  get points() {
    return [...this.#points.keys()];
  }

  /**
   * Adds an extension point.
   * @param {string} name
   * @param {Normalize} normalize
   * @param {Compose} [compose]
   * @throws {Error} If `name` isn't a name or is taken.
   */
  definePoint(name, normalize, compose) {
    if (!isName(name)) {
      throw new TypeError(`Invalid extension point name "${name}"`);
    }
    if (this.#points.has(name)) {
      throw new Error(`Extension point "${name}" is already defined`);
    }
    this.#points.set(name, { normalize, compose: compose ?? null });
    this.#records.set(name, []);
    this.#notify(name);
  }

  /**
   * Adds items to an extension point. Handlers don't call this; their `static contributes` is registered
   * for them.
   * @param {string} point
   * @param {unknown} items An array of raw items.
   * @param {ContributionContext} context
   * @returns {() => void} Removes the items again.
   * @throws {Error} If the point doesn't exist, or an item is invalid or reuses an id — nothing is added then.
   */
  contribute(point, items, context) {
    const normalize = this.#points.get(point)?.normalize;
    const records = this.#records.get(point);
    if (!normalize || !records) {
      throw new Error(
        `"${context.source}" contributes to unknown extension point "${point}"; known: ${this.points.join(', ')}`,
      );
    }
    if (!Array.isArray(items)) {
      throw new TypeError(`"${point}" from "${context.source}" must be an array`);
    }
    const normalized = items.map((item, i) => deepFreeze(normalize(item, context, `${point}[${i}] from "${context.source}"`)));

    /** @type {Map<unknown, string>} */
    const ids = new Map();
    for (const record of records) {
      for (const item of record.items) {
        ids.set(item.id, record.source);
      }
    }
    for (const item of normalized) {
      if (item.id !== undefined && ids.has(item.id)) {
        throw new Error(`${point} "${item.id}" from "${context.source}" is already contributed by "${ids.get(item.id)}"`);
      }
      ids.set(item.id, context.source);
    }

    const record = { source: context.source, user: Boolean(context.user), items: normalized };
    records.push(record);
    this.#notify(point);
    let released = false;
    return () => {
      if (!released) {
        released = true;
        records.splice(records.indexOf(record), 1);
        this.#notify(point);
      }
    };
  }

  /**
   * Every item of a point, in the order they were contributed, user config last. Items are frozen.
   * @param {string} point
   * @returns {{ [key: string]: Data }[]}
   * @throws {Error} If the point doesn't exist.
   */
  get(point) {
    const records = this.#records.get(point);
    if (!records) {
      throw new Error(`Unknown extension point "${point}"`);
    }
    const items = [
      ...records.filter((record) => !record.user).flatMap((record) => record.items),
      ...records.filter((record) => record.user).flatMap((record) => record.items),
    ];
    return this.#points.get(point)?.compose?.(items) ?? items;
  }

  /**
   * @param {string} id
   * @returns {Command | undefined}
   */
  command(id) {
    return /** @type {Command[]} */ (/** @type {unknown} */ (this.get('commands'))).find((command) => command.id === id);
  }

  /**
   * Initialized handlers of a kind, in the order they were attached.
   * @param {string} kind
   * @returns {AnyHandler[]}
   */
  instances(kind) {
    return [...(this.#kinds.get(kind)?.instances ?? [])];
  }

  /**
   * Records an initialized handler under its kind. The first instance of a kind registers its class's
   * `static contributes`; detaching the last one removes them.
   * @param {AnyHandler} handler
   * @returns {() => void} Detaches it.
   * @throws {Error} If its kind is invalid, belongs to another class, or its contributions are invalid.
   */
  attach(handler) {
    const { kind } = handler;
    if (!isName(kind)) {
      throw new TypeError(`Handler "${handler.path}" has an invalid kind "${kind}": use a letter, then letters, digits, "-" or "_"`);
    }
    const type = handler.constructor;
    let entry = this.#kinds.get(kind);
    if (entry && entry.type !== type) {
      const [other] = entry.instances;
      throw new Error(
        `Handler "${handler.path}" (${type.name}) has kind "${kind}", which "${other.path}" (${entry.type.name}) already uses; ` +
          'give one of the classes its own static kind',
      );
    }
    if (!entry) {
      const contributes = /** @type {typeof Handler} */ (type).contributes ?? {};
      entry = { type, instances: new Set(), release: this.#contributeAll(contributes, { source: kind, handler }) };
      this.#kinds.set(kind, entry);
    }
    const attached = entry;
    attached.instances.add(handler);
    return () => {
      if (attached.instances.delete(handler) && !attached.instances.size) {
        this.#kinds.delete(kind);
        attached.release();
      }
    };
  }

  /**
   * Finds the command and the handler it runs on: the instance of its kind nearest to `focus` (the focused
   * handler itself, or its closest ancestor of that kind), or else the only instance there is.
   * @param {string} id
   * @param {string | null} [focus] Path of the focused handler, e.g. `main.left`.
   * @returns {{ command: Command, handler: AnyHandler }}
   * @throws {Error} If there's no such command, or no instance of its kind to run on.
   */
  resolve(id, focus = null) {
    const command = this.command(id);
    if (!command) {
      throw new Error(`Unknown command "${id}"`);
    }
    const instances = this.instances(command.kind);
    if (focus) {
      for (let path = focus; path; path = path.slice(0, Math.max(0, path.lastIndexOf('.')))) {
        const handler = instances.find((instance) => instance.path === path);
        if (handler) {
          return { command, handler };
        }
      }
    }
    if (instances.length === 1) {
      return { command, handler: instances[0] };
    }
    throw new Error(
      instances.length
        ? `Command "${id}" needs a focused "${command.kind}"; there are ${instances.length}: ${instances.map((h) => h.path).join(', ')}`
        : `Command "${id}" has no "${command.kind}" to run on`,
    );
  }

  /**
   * The keybindings active for `focus`, with the handler each would run on and how near the focus it is.
   * The focus chain is the focused handler, its ancestors, and last `core`, so `core.*` bindings are
   * global. A binding is active if a handler of its command's kind is on the chain and in the binding's
   * mode; bindings of commands that don't exist or aren't enabled for the TUI are skipped.
   * @param {string | null} focus Path of the focused handler.
   * @returns {{ binding: Keybinding, command: Command, handler: AnyHandler, depth: number }[]}
   */
  activeKeybindings(focus) {
    /** @type {string[]} */
    const chain = [];
    for (let path = focus ?? ''; path; path = path.slice(0, Math.max(0, path.lastIndexOf('.')))) {
      chain.push(path);
    }
    chain.push('core');

    const result = [];
    for (const binding of /** @type {Keybinding[]} */ (/** @type {unknown} */ (this.get('keybindings')))) {
      const command = this.command(binding.command);
      if (!command?.tui) {
        continue;
      }
      const instances = this.instances(command.kind);
      const index = chain.findIndex((path) => instances.some((instance) => instance.path === path));
      if (index < 0) {
        continue;
      }
      const handler = /** @type {AnyHandler} */ (instances.find((instance) => instance.path === chain[index]));
      const mode = /** @type {{ mode?: unknown }} */ (handler.state).mode;
      if ((typeof mode === 'string' ? mode : 'normal') === binding.mode) {
        result.push({ binding, command, handler, depth: chain.length - index });
      }
    }
    return result;
  }

  /**
   * Runs a command on the handler `resolve()` picks.
   * @param {string} id
   * @param {{ focus?: string | null, surface?: 'tui' | 'cli', args?: unknown[] }} [options] `surface` is
   *   where the request comes from; a command must be enabled for it. Default `tui`.
   * @returns {Promise<unknown>} The method's result.
   * @throws {Error} If the command can't be resolved or isn't available on `surface`, or the method fails.
   */
  async execute(id, { focus = null, surface = 'tui', args = [] } = {}) {
    const { command, handler } = this.resolve(id, focus);
    if (!command[surface]) {
      throw new Error(`Command "${id}" isn't available from the ${surface.toUpperCase()}`);
    }
    return handler.call(command.method, ...args);
  }

  /**
   * Calls `listener` with a point's name whenever its items change.
   * @param {(point: string) => void} listener
   * @returns {() => void} Unsubscribes.
   */
  subscribe(listener) {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** @param {string} point */
  #notify(point) {
    for (const listener of this.#listeners) {
      listener(point);
    }
  }

  /**
   * @param {unknown} contributes
   * @param {ContributionContext} context
   * @returns {() => void} Releases everything contributed.
   */
  #contributeAll(contributes, context) {
    if (typeof contributes !== 'object' || contributes === null || Array.isArray(contributes)) {
      throw new TypeError(`"contributes" of "${context.source}" must be an object`);
    }
    /** @type {(() => void)[]} */
    const releases = [];
    const releaseAll = () => {
      for (const release of releases.reverse()) {
        release();
      }
    };
    try {
      for (const [point, items] of Object.entries(contributes)) {
        releases.push(this.contribute(point, items, context));
      }
    } catch (error) {
      releaseAll();
      throw error;
    }
    return releaseAll;
  }
}

/**
 * Reads the fields of a raw item, checking their types; `done()` rejects any it didn't read, so a typo in a
 * declaration fails instead of being ignored.
 * @param {unknown} item
 * @param {string} where Names the item in errors, e.g. `commands[0] from "pane"`.
 */
function fields(item, where) {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) {
    throw new TypeError(`${where} must be an object`);
  }
  const record = /** @type {Record<string, unknown>} */ (item);
  /** @type {Set<string>} */
  const read = new Set();
  return {
    /**
     * @param {string} key
     * @param {'string' | 'number' | 'boolean' | 'array'} type
     * @param {unknown[]} fallback Omitted: the field is required.
     * @returns {any}
     */
    get(key, type, ...fallback) {
      read.add(key);
      const value = record[key];
      if (value === undefined) {
        if (fallback.length) {
          return fallback[0];
        }
        throw new TypeError(`${where} needs "${key}"`);
      }
      if (type === 'array' ? !Array.isArray(value) : typeof value !== type) {
        throw new TypeError(`${where}: "${key}" must be ${type === 'array' ? 'an array' : `a ${type}`}`);
      }
      return type === 'array' ? cloneData(value, [key], { what: where }) : value;
    },
    done() {
      const unknown = Object.keys(record).find((key) => !read.has(key));
      if (unknown !== undefined) {
        throw new TypeError(`${where}: unknown field "${unknown}"; expected ${[...read].map((key) => `"${key}"`).join(', ')}`);
      }
    },
  };
}

/**
 * @param {string} command
 * @param {string} where
 */
function checkCommandId(command, where) {
  if (!isPath(command, 2)) {
    throw new TypeError(`${where}: command "${command}" isn't a command id like "pane.down"`);
  }
}

/** @type {Normalize} */
function normalizeCommand(item, { source, handler }, where) {
  const read = fields(item, where);
  /** @type {string} */
  const method = read.get('method', 'string');
  const title = read.get('title', 'string');
  const description = read.get('description', 'string', null);
  const tui = read.get('tui', 'boolean', true);
  const cli = read.get('cli', 'boolean', false);
  read.done();
  if (handler ? !Handler.isCallable(handler, method) : !isName(method)) {
    throw new TypeError(`${where}: "${method}" isn't a callable method of "${source}"`);
  }
  if (!tui && !cli) {
    throw new TypeError(`${where}: command "${method}" is reachable from neither the TUI nor the CLI`);
  }
  return { id: `${source}.${method}`, kind: source, method, title, description, tui, cli, source };
}

/** @type {Normalize} */
function normalizeKeybinding(item, { source, user = false }, where) {
  const read = fields(item, where);
  /** @type {string} */
  const command = read.get('command', 'string');
  const removal = command.startsWith('-');
  /** @type {string | null} */
  const key = read.get('key', 'string', ...(removal ? [null] : []));
  const args = read.get('args', 'array', []);
  const mode = read.get('mode', 'string', 'normal');
  read.done();
  if (removal && !user) {
    throw new TypeError(`${where}: only user config can remove keybindings ("${command}")`);
  }
  checkCommandId(removal ? command.slice(1) : command, where);
  if (!isName(mode)) {
    throw new TypeError(`${where}: invalid mode "${mode}"`);
  }
  /** @type {string[]} */
  let keys = [];
  if (key !== null) {
    try {
      keys = parseKeys(key);
    } catch (error) {
      throw new TypeError(`${where}: ${/** @type {Error} */ (error).message}`);
    }
  }
  return { key: key === null ? null : keys.join(' '), keys, command, args, mode, source, user };
}

/**
 * Applies user removals (`-pane.down`) in order, dropping them from the result.
 * @type {Compose}
 */
function composeKeybindings(items) {
  /** @type {{ [key: string]: Data }[]} */
  let result = [];
  for (const item of items) {
    const { command, key } = /** @type {{ command: string, key: string | null }} */ (item);
    if (command.startsWith('-')) {
      result = result.filter((binding) => binding.command !== command.slice(1) || (key !== null && binding.key !== key));
    } else {
      result.push(item);
    }
  }
  return result;
}

/** @type {Normalize} */
function normalizeMenuEntry(item, { source }, where) {
  const read = fields(item, where);
  const command = read.get('command', 'string');
  const title = read.get('title', 'string', null);
  const group = read.get('group', 'string', null);
  const order = read.get('order', 'number', 0);
  const args = read.get('args', 'array', []);
  read.done();
  checkCommandId(command, where);
  if (!Number.isFinite(order)) {
    throw new TypeError(`${where}: "order" must be a finite number`);
  }
  return { command, title, group, order, args, source };
}

module.exports = { Registry };
