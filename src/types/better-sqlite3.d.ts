declare module 'better-sqlite3' {
  // This native package has no bundled types. Declare the API used by the dump child.
  interface DatabaseOptions {
    readonly?: boolean;
    fileMustExist?: boolean;
    timeout?: number;
  }

  interface Statement {
    all(): unknown[];
    run(...params: string[]): unknown;
  }

  class Database {
    constructor(path: string, options?: DatabaseOptions);
    pragma(sql: string): unknown;
    prepare(sql: string): Statement;
    exec(sql: string): this;
    close(): this;
  }

  export = Database;
}
