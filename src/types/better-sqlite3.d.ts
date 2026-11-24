declare module 'better-sqlite3' {
  // This native package has no bundled types. Declare the API used by the dump child.
  interface DatabaseOptions {
    readonly?: boolean;
    fileMustExist?: boolean;
    timeout?: number;
  }

  type SqliteValue = string | number | bigint | Buffer | null;

  interface Statement {
    all(...params: SqliteValue[]): unknown[];
    get(...params: SqliteValue[]): unknown;
    run(...params: SqliteValue[]): unknown;
    iterate(...params: SqliteValue[]): IterableIterator<unknown>;
    raw(toggle?: boolean): this;
    pluck(toggle?: boolean): this;
    safeIntegers(toggle?: boolean): this;
  }

  class Database {
    constructor(path: string, options?: DatabaseOptions);
    pragma(sql: string, options?: { simple?: boolean }): unknown;
    transaction<T>(work: () => T): () => T;
    prepare(sql: string): Statement;
    exec(sql: string): this;
    close(): this;
  }

  export = Database;
}
