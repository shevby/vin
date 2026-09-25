const fs = require('node:fs');
const path = require('node:path');
const momoa = require('@humanwhocodes/momoa');
const { checkStyle } = require('./colors');
const { checkOptionValue } = require('./contributions');
const { deepFreeze } = require('./state');

/**
 * @typedef {import('./state').Data} Data
 * @typedef {import('./contributions').Option} Option
 * @typedef {import('./colors').ColorGroup} ColorGroup
 * @typedef {import('./colors').Style} Style
 * @typedef {InstanceType<typeof import('./contributions').Registry>} Registry
 * @typedef {import('@humanwhocodes/momoa').AnyNode} Node
 * @typedef {import('@humanwhocodes/momoa').MemberNode} MemberNode
 */

/**
 * What handlers read the configuration through: `this.config.get('pane.showHidden')`.
 * @typedef {object} ConfigReader
 * @property {(id: string) => Data} get An option's value — the user's, if set and valid, or else its default.
 *   Objects and arrays are frozen. Throws if no handler or plugin declares the option.
 * @property {(id: string) => Style} style A color group's style (`src/colors.js`): its default, with the
 *   fields the user set, if valid. Frozen. Throws if no handler or plugin declares the group.
 */

/** Where vin keeps the user's configuration: the project root, git-ignored. */
const CONFIG_FILE = path.join(__dirname, '..', 'config.json5');

/** The top-level key that holds keybindings rather than a section of options. */
const KEYBINDINGS = 'keybindings';
/** The top-level key that holds color groups, by kind, rather than a section of options. */
const COLORS = 'colors';

/**
 * A configuration file with mistakes; `problems` lists each one as `<file>:<line>:<column>: <what>`.
 */
class ConfigError extends Error {
  /** @param {string[]} problems */
  constructor(problems) {
    super(`Invalid configuration (${problems.length} ${problems.length === 1 ? 'problem' : 'problems'}):\n${problems.map((p) => `  ${p}`).join('\n')}`);
    this.name = 'ConfigError';
    this.code = 'ECONFIG';
    this.problems = problems;
  }
}

/**
 * The user's configuration, from `config.json5`: options grouped by the kind (or plugin) that declares
 * them, plus user keybindings.
 *
 * ```json5
 * {
 *   core: { keyTimeout: 500 },
 *   keybindings: [{ key: 'J', command: 'pane.down' }, { key: 'j', command: '-pane.down' }],
 * }
 * ```
 *
 * Color groups (`src/colors.js`) are declared in the `colors` extension point and set under `colors`, by kind.
 *
 * Options are declared in the `configuration` extension point (`static contributes.configuration`), so
 * the file is checked in two steps: `load()` parses it and registers its keybindings before handlers are
 * initialized; `check()`, once they are, checks every section and option against what's declared, and the
 * keybindings against the commands. Until then `get()` falls back to the default for any value that isn't
 * valid, so handlers can read options during `onInit()`.
 */
class Config {
  /** @type {Registry} */
  #registry;
  /** @type {string} */
  #file = CONFIG_FILE;
  /**
   * The file's sections by name (`pane`), each with its options' members by key.
   * @type {Map<string, { member: MemberNode, options: Map<string, MemberNode> }>}
   */
  #sections = new Map();
  /**
   * User keybindings with where each one is, for `check()`.
   * @type {{ command: string, member: Node }[]}
   */
  #keybindings = [];
  /**
   * The file's `colors` sections by kind, each with its groups' members by key.
   * @type {Map<string, { member: MemberNode, groups: Map<string, MemberNode> }>}
   */
  #colors = new Map();
  /** @type {Map<string, Style>} */
  #styles = new Map();
  /**
   * Problems found by `load()`, reported by `check()` with the rest.
   * @type {string[]}
   */
  #problems = [];
  /** @type {(() => void)[]} */
  #releases = [];
  /** @type {Map<string, Data>} */
  #values = new Map();

  /** @param {Registry} registry */
  constructor(registry) {
    this.#registry = registry;
    /**
     * The part handlers see, as `this.config`.
     * @type {ConfigReader}
     * @readonly
     */
    this.reader = Object.freeze({
      get: (/** @type {string} */ id) => this.get(id),
      style: (/** @type {string} */ id) => this.style(id),
    });
  }

  /**
   * Reads and parses a config file, replacing what was loaded before, and registers its keybindings.
   * @param {string} [file] Default: `config.json5` in the project root.
   * @returns {boolean} Whether the file exists; if not, nothing is set and every option has its default.
   * @throws {ConfigError} If it can't be read or parsed at all. Other problems wait for `check()`.
   */
  load(file = CONFIG_FILE) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') {
        this.parse('{}', file);
        return false;
      }
      throw new ConfigError([`${file}: can't be read: ${/** @type {Error} */ (error).message}`]);
    }
    this.parse(text, file);
    return true;
  }

  /**
   * Parses config text, as `load()` does with a file's.
   * @param {string} text JSON5.
   * @param {string} [file] Names the file in problems.
   * @throws {ConfigError} On a syntax error.
   */
  parse(text, file = CONFIG_FILE) {
    for (const release of this.#releases.splice(0)) {
      release();
    }
    this.#file = file;
    this.#sections.clear();
    this.#keybindings = [];
    this.#colors.clear();
    this.#styles.clear();
    this.#problems = [];
    this.#values.clear();

    let document;
    try {
      document = momoa.parse(text, { mode: 'json5' });
    } catch (error) {
      const { line, column, message } = /** @type {Error & { line?: number, column?: number }} */ (error);
      const at = line === undefined ? file : `${file}:${line}:${column}`;
      throw new ConfigError([`${at}: ${message.replace(/ \(\d+:\d+\)$/, '')}`]);
    }
    const root = document.body;
    if (root.type !== 'Object') {
      this.#problem(root, 'the configuration must be an object: { … }');
      return;
    }
    for (const member of this.#members(root)) {
      const name = keyOf(member);
      if (name === KEYBINDINGS) {
        this.#loadKeybindings(member);
      } else if (name === COLORS) {
        this.#loadColors(member);
      } else if (member.value.type !== 'Object') {
        this.#problem(member.value, `"${name}" must be an object of options: ${name}: { … }`);
      } else {
        const options = new Map(this.#members(member.value).map((option) => [keyOf(option), option]));
        this.#sections.set(name, { member, options });
      }
    }
  }

  /**
   * Checks the loaded file against the options and commands declared now: unknown sections and options,
   * invalid values, and keybindings to commands that don't exist. Call it once every handler that
   * declares options has been initialized.
   * @throws {ConfigError} With every problem, including those `load()` found.
   */
  check() {
    const problems = [...this.#problems];
    const report = (/** @type {Node} */ node, /** @type {string} */ message) => problems.push(`${this.#at(node)}: ${message}`);
    const options = /** @type {Option[]} */ (/** @type {unknown} */ (this.#registry.get('configuration')));
    const kinds = [...new Set(options.map((option) => option.kind))];

    for (const [name, { member, options: members }] of this.#sections) {
      if (!kinds.includes(name)) {
        report(member.name, `unknown section "${name}": nothing declares options under it${suggest(name, kinds)}`);
        continue;
      }
      const keys = options.filter((option) => option.kind === name).map((option) => option.key);
      for (const [key, node] of members) {
        const option = this.#registry.option(`${name}.${key}`);
        if (!option) {
          report(node.name, `unknown option "${name}.${key}"${suggest(key, keys)}`);
          continue;
        }
        const problem = this.#read(option, node).problem;
        if (problem) {
          report(node.value, problem);
        }
      }
    }

    const groups = /** @type {ColorGroup[]} */ (/** @type {unknown} */ (this.#registry.get('colors')));
    const colorKinds = [...new Set(groups.map((group) => group.kind))];
    for (const [name, { member, groups: members }] of this.#colors) {
      if (!colorKinds.includes(name)) {
        report(member.name, `unknown section "${COLORS}.${name}": nothing declares colors under it${suggest(name, colorKinds)}`);
        continue;
      }
      const keys = groups.filter((group) => group.kind === name).map((group) => group.key);
      for (const [key, node] of members) {
        const group = this.#registry.color(`${name}.${key}`);
        if (!group) {
          report(node.name, `unknown color group "${name}.${key}"${suggest(key, keys)}`);
          continue;
        }
        const problem = this.#readStyle(group, node).problem;
        if (problem) {
          report(node.value, problem);
        }
      }
    }

    const commands = this.#registry.get('commands').map((command) => /** @type {string} */ (command.id));
    for (const { command, member } of this.#keybindings) {
      const id = command.replace(/^-/, '');
      if (!commands.includes(id)) {
        report(member, `unknown command "${id}"${suggest(id, commands)}`);
      }
    }

    if (problems.length) {
      // In file order, whichever step found them.
      const position = (/** @type {string} */ problem) =>
        (problem.slice(this.#file.length).match(/^:(\d+):(\d+):/) ?? []).slice(1).map(Number);
      const order = problems.map((problem) => ({ problem, at: position(problem) }));
      order.sort((a, b) => (a.at[0] ?? 0) - (b.at[0] ?? 0) || (a.at[1] ?? 0) - (b.at[1] ?? 0));
      throw new ConfigError(order.map(({ problem }) => problem));
    }
  }

  /**
   * An option's value: the user's, if set and valid, or else its default.
   * @param {string} id `<kind>.<key>`, e.g. `core.keyTimeout`.
   * @returns {Data} Frozen, for objects and arrays.
   * @throws {Error} If no handler or plugin declares the option.
   */
  get(id) {
    const option = this.#registry.option(id);
    if (!option) {
      throw new Error(`Unknown option "${id}": no initialized handler or plugin declares it`);
    }
    let value = this.#values.get(id);
    if (value === undefined) {
      const node = this.#sections.get(option.kind)?.options.get(option.key);
      const read = node ? this.#read(option, node) : { value: option.default, problem: null };
      value = deepFreeze(read.problem ? option.default : /** @type {Data} */ (read.value));
      this.#values.set(id, value);
    }
    return value;
  }

  /**
   * A color group's style: its default, with the fields the user set — unless they aren't valid, which
   * `check()` reports.
   * @param {string} id `<kind>.<key>`, e.g. `pane.titleActive`.
   * @returns {Style} Frozen.
   * @throws {Error} If no handler or plugin declares the group.
   */
  style(id) {
    const group = this.#registry.color(id);
    if (!group) {
      throw new Error(`Unknown color group "${id}": no initialized handler or plugin declares it`);
    }
    let style = this.#styles.get(id);
    if (style === undefined) {
      const node = this.#colors.get(group.kind)?.groups.get(group.key);
      const read = node ? this.#readStyle(group, node) : { value: undefined, problem: null };
      style = /** @type {Style} */ (deepFreeze({ ...group.default, ...read.value }));
      this.#styles.set(id, style);
    }
    return style;
  }

  /**
   * Writes a starting config file that lists every option declared now, commented out with its default and
   * description, and examples of keybindings. It never overwrites an existing file.
   * @param {string} [file]
   * @returns {boolean} Whether it was written.
   */
  create(file = CONFIG_FILE) {
    const options = /** @type {Option[]} */ (/** @type {unknown} */ (this.#registry.get('configuration')));
    const lines = [
      '// vin configuration, in JSON5: comments, trailing commas, and unquoted keys are fine.',
      '// Options are grouped by the handler or plugin that declares them; uncomment one to change it. Anything',
      "// left out keeps its default. vin checks this file on startup and won't start if something's wrong.",
      "// It's git-ignored, so updating vin never touches it.",
      '{',
    ];
    for (const kind of new Set(options.map((option) => option.kind))) {
      lines.push(`  // ${kind}: {`);
      for (const option of options.filter((o) => o.kind === kind)) {
        const note = [option.description, option.enum && `One of: ${option.enum.map((v) => JSON.stringify(v)).join(', ')}.`]
          .filter(Boolean)
          .join(' ');
        lines.push(`  //   ${option.key}: ${JSON.stringify(option.default)},${note ? ` // ${note}` : ''}`);
      }
      lines.push('  // },', '');
    }
    const groups = /** @type {ColorGroup[]} */ (/** @type {unknown} */ (this.#registry.get('colors')));
    if (groups.length) {
      lines.push(
        '  // Colors, by the handler or plugin that draws them. fg and bg are 0 to 255, "#rrggbb", a name ("blue",',
        '  // "redBright"), or "default" (the terminal\'s own); bold, italic, underline, inverse, and dim are true or false.',
        '  // An entry changes only what it names: { fg: 33 } keeps the rest of the default.',
        `  // ${COLORS}: {`,
      );
      for (const kind of new Set(groups.map((group) => group.kind))) {
        lines.push(`  //   ${kind}: {`);
        for (const group of groups.filter((g) => g.kind === kind)) {
          lines.push(`  //     ${group.key}: ${showStyle(group.default)},${group.description ? ` // ${group.description}` : ''}`);
        }
        lines.push('  //   },');
      }
      lines.push('  // },', '');
    }
    lines.push(
      '  // Keybindings, applied after the built-in ones; see CONTROLS.md for the key notation.',
      '  // keybindings: [',
      "  //   { key: 'ctrl+w w', command: 'core.closeWindow' },",
      "  //   { key: 'escape', command: '-core.closeWindow' }, // A leading \"-\" removes built-in bindings.",
      '  // ],',
      '}',
      '',
    );
    try {
      fs.writeFileSync(file, lines.join('\n'), { flag: 'wx' });
      return true;
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === 'EEXIST') {
        return false;
      }
      throw error;
    }
  }

  /**
   * @param {MemberNode} member
   */
  #loadKeybindings(member) {
    if (member.value.type !== 'Array') {
      this.#problem(member.value, `"${KEYBINDINGS}" must be an array: ${KEYBINDINGS}: [{ key: 'j', command: 'pane.down' }, …]`);
      return;
    }
    member.value.elements.forEach((element, index) => {
      const value = this.#evaluate(element.value);
      if (value === undefined) {
        return;
      }
      try {
        this.#releases.push(
          this.#registry.contribute(KEYBINDINGS, [value], {
            source: 'config',
            user: true,
            where: () => `${this.#at(element.value)}: ${KEYBINDINGS}[${index}]`,
          }),
        );
      } catch (error) {
        this.#problems.push(/** @type {Error} */ (error).message);
        return;
      }
      const { command } = /** @type {{ command: string }} */ (value);
      const node = element.value.type === 'Object' ? element.value.members.find((m) => keyOf(m) === 'command')?.value : undefined;
      this.#keybindings.push({ command, member: node ?? element.value });
    });
  }

  /**
   * @param {MemberNode} member
   */
  #loadColors(member) {
    if (member.value.type !== 'Object') {
      this.#problem(member.value, `"${COLORS}" must be an object of color groups by kind: ${COLORS}: { pane: { title: { fg: 71 } } }`);
      return;
    }
    for (const section of this.#members(member.value)) {
      const name = keyOf(section);
      if (section.value.type !== 'Object') {
        this.#problem(section.value, `"${COLORS}.${name}" must be an object of color groups: ${name}: { title: { fg: 71 } }`);
        continue;
      }
      const groups = new Map(this.#members(section.value).map((group) => [keyOf(group), group]));
      this.#colors.set(name, { member: section, groups });
    }
  }

  /**
   * The user's style for a color group, and what's wrong with it, if anything.
   * @param {ColorGroup} group
   * @param {MemberNode} member
   * @returns {{ value: Style | undefined, problem: string | null }}
   */
  #readStyle(group, member) {
    const nonFinite = find(member.value, (node) => node.type === 'NaN' || node.type === 'Infinity');
    const value = nonFinite ? undefined : /** @type {Data} */ (momoa.evaluate(member.value));
    const problem = nonFinite ? "can't hold NaN or Infinity" : checkStyle(value);
    if (problem) {
      return { value: undefined, problem: `color "${group.id}" ${problem}` };
    }
    return { value: /** @type {Style} */ (value), problem: null };
  }

  /**
   * An object's members, reporting keys that repeat (JSON5 would silently keep the last).
   * @param {import('@humanwhocodes/momoa').ObjectNode} object
   * @returns {MemberNode[]}
   */
  #members(object) {
    /** @type {Map<string, MemberNode>} */
    const seen = new Map();
    for (const member of object.members) {
      const key = keyOf(member);
      const first = seen.get(key);
      if (first) {
        this.#problem(member.name, `"${key}" is set again; the first is at line ${first.loc.start.line}`);
      }
      seen.set(key, member);
    }
    return [...seen.values()];
  }

  /**
   * The user's value for an option, and what's wrong with it, if anything.
   * @param {Option} option
   * @param {MemberNode} member
   * @returns {{ value: Data | undefined, problem: string | null }}
   */
  #read(option, member) {
    const nonFinite = find(member.value, (node) => node.type === 'NaN' || node.type === 'Infinity');
    if (nonFinite) {
      return { value: undefined, problem: `"${option.id}" can't hold NaN or Infinity` };
    }
    const value = /** @type {Data} */ (momoa.evaluate(member.value));
    const problem = checkOptionValue(option, value);
    return { value, problem: problem && `"${option.id}" ${problem}` };
  }

  /**
   * A node's value as JSON data, or `undefined` (with a problem reported) if it holds NaN or Infinity.
   * @param {Node} node
   * @returns {Data | undefined}
   */
  #evaluate(node) {
    const nonFinite = find(node, (n) => n.type === 'NaN' || n.type === 'Infinity');
    if (nonFinite) {
      this.#problem(nonFinite, 'NaN and Infinity aren\'t allowed');
      return undefined;
    }
    return /** @type {Data} */ (momoa.evaluate(/** @type {any} */ (node)));
  }

  /**
   * @param {Node} node
   * @param {string} message
   */
  #problem(node, message) {
    this.#problems.push(`${this.#at(node)}: ${message}`);
  }

  /**
   * `<file>:<line>:<column>` of a node.
   * @param {Node} node
   */
  #at(node) {
    return `${this.#file}:${node.loc.start.line}:${node.loc.start.column}`;
  }
}

/**
 * A style as JSON5 on one line: `{ fg: 71, bold: true }`.
 * @param {Style} style
 */
function showStyle(style) {
  const fields = Object.entries(style).map(([field, value]) => `${field}: ${typeof value === 'string' ? `'${value}'` : value}`);
  return fields.length ? `{ ${fields.join(', ')} }` : '{}';
}

/**
 * @param {MemberNode} member
 * @returns {string}
 */
function keyOf(member) {
  return member.name.type === 'Identifier' ? member.name.name : member.name.value;
}

/**
 * The first node, depth-first, that matches.
 * @param {Node} node
 * @param {(node: Node) => boolean} predicate
 * @returns {Node | undefined}
 */
function find(node, predicate) {
  if (predicate(node)) {
    return node;
  }
  if (node.type === 'Object') {
    for (const member of node.members) {
      const found = find(member.value, predicate);
      if (found) {
        return found;
      }
    }
  } else if (node.type === 'Array') {
    for (const element of node.elements) {
      const found = find(element.value, predicate);
      if (found) {
        return found;
      }
    }
  }
  return undefined;
}

/**
 * `; did you mean "x"?` for the candidate nearest to a mistyped name, or `''` if none is close.
 * @param {string} name
 * @param {readonly string[]} candidates
 */
function suggest(name, candidates) {
  let best = '';
  let bestDistance = Math.max(1, Math.floor(name.length / 3)) + 1;
  for (const candidate of candidates) {
    const d = candidate.toLowerCase() === name.toLowerCase() ? 0 : distance(name, candidate);
    if (d < bestDistance) {
      best = candidate;
      bestDistance = d;
    }
  }
  return best ? `; did you mean "${best}"?` : '';
}

/**
 * Edit distance: the fewest single-character insertions, deletions, substitutions, and swaps of neighbors
 * (the usual typos) from `a` to `b` — Damerau–Levenshtein, in its optimal string alignment form.
 * @param {string} a
 * @param {string} b
 */
function distance(a, b) {
  /** @type {number[][]} */
  const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i ? (j ? 0 : i) : j)));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[a.length][b.length];
}

module.exports = { Config, ConfigError, CONFIG_FILE };
