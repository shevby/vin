/**
 * The `trash:` scheme — vin's trash (`src/trash.js`) as a file system of its own, shown as `/trash`: every
 * call goes to the local disk, with the URI mapped into the trash's directory (`trash:///a/b` is
 * `<directory>/a/b`). Moving and copying between it and `file:` work, as the file system (`FileSystem`)
 * maps both ends to `file:` through `realUri`. While the trash is off, every call fails, saying so.
 * @typedef {import('./file-system').FileSystemProvider} FileSystemProvider
 */

/**
 * @implements {FileSystemProvider}
 */
class TrashProvider {
  /** @type {InstanceType<typeof import('../trash').Trash>} */
  #trash;
  /** @type {FileSystemProvider} */
  #local;

  /**
   * @param {InstanceType<typeof import('../trash').Trash>} trash
   * @param {FileSystemProvider} local The `file:` provider.
   */
  constructor(trash, local) {
    this.#trash = trash;
    this.#local = local;
  }

  /**
   * The `file:` URI the trash keeps an entry at.
   * @param {string} uri A `trash:` URI.
   * @returns {string}
   */
  realUri(uri) {
    return this.#trash.real(uri);
  }

  /** @type {FileSystemProvider['stat']} */
  async stat(uri) {
    return this.#local.stat(this.realUri(uri));
  }

  /**
   * The root is created when first listed, so an empty trash shows as one.
   * @type {FileSystemProvider['readDirectory']}
   */
  async readDirectory(uri, options) {
    const real = this.realUri(uri);
    if (new URL(uri).pathname.replace(/\/+/g, '') === '') {
      await this.#local.createDirectory(real, { recursive: true });
    }
    return this.#local.readDirectory(real, options);
  }

  /** @type {NonNullable<FileSystemProvider['hiddenEntries']>} */
  async hiddenEntries(uri, options) {
    return (await this.#local.hiddenEntries?.(this.realUri(uri), options)) ?? [];
  }

  /** @type {FileSystemProvider['createDirectory']} */
  async createDirectory(uri, options) {
    return this.#local.createDirectory(this.realUri(uri), options);
  }

  /** @type {FileSystemProvider['readFile']} */
  async readFile(uri) {
    return this.#local.readFile(this.realUri(uri));
  }

  /** @type {FileSystemProvider['writeFile']} */
  async writeFile(uri, data, options) {
    return this.#local.writeFile(this.realUri(uri), data, options);
  }

  /** @type {FileSystemProvider['delete']} */
  async delete(uri, options) {
    return this.#local.delete(this.realUri(uri), options);
  }

  /** @type {FileSystemProvider['rename']} */
  async rename(from, to, options) {
    return this.#local.rename(this.realUri(from), this.realUri(to), options);
  }

  /** @type {NonNullable<FileSystemProvider['copy']>} */
  async copy(from, to, options) {
    return /** @type {NonNullable<FileSystemProvider['copy']>} */ (this.#local.copy)(this.realUri(from), this.realUri(to), options);
  }

  /** @type {NonNullable<FileSystemProvider['createSymlink']>} */
  async createSymlink(uri, target) {
    return /** @type {NonNullable<FileSystemProvider['createSymlink']>} */ (this.#local.createSymlink)(this.realUri(uri), this.realUri(target));
  }

  /** @type {FileSystemProvider['createReadStream']} */
  async createReadStream(uri, options) {
    return this.#local.createReadStream(this.realUri(uri), options);
  }

  /** @type {FileSystemProvider['createWriteStream']} */
  async createWriteStream(uri, options) {
    return this.#local.createWriteStream(this.realUri(uri), options);
  }

  /**
   * Reports changes by their `file:` URIs, for now (2.15).
   * @type {FileSystemProvider['watch']}
   */
  watch(uri, listener, options) {
    return this.#local.watch(this.realUri(uri), listener, options);
  }
}

module.exports = { TrashProvider };
