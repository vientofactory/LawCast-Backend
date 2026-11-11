import { type ForkOptions } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

export function resolveChildEntrypoint(
  directory: string,
  name: string,
): string {
  const compiled = path.join(directory, `${name}.js`);
  if (existsSync(compiled)) return compiled;
  const source = path.join(directory, `${name}.ts`);
  if (existsSync(source)) return source;
  throw new Error(`Missing child process entrypoint: ${name}`);
}

export function isolatedChildOptions(
  entrypoint: string,
  heapMb: number,
): Pick<ForkOptions, 'execArgv' | 'env'> {
  const execArgv = [`--max-old-space-size=${heapMb}`];
  const env: NodeJS.ProcessEnv = {
    TZ: process.env.TZ,
    TMPDIR: process.env.TMPDIR,
    TMP: process.env.TMP,
    TEMP: process.env.TEMP,
    SQLITE_TMPDIR: process.env.SQLITE_TMPDIR,
  };
  // Source-only tests use the same compiler settings; production only needs emitted JS.
  if (entrypoint.endsWith('.ts')) {
    execArgv.push('-r', require.resolve('ts-node/register/transpile-only'));
    env.TS_NODE_PROJECT = path.resolve(__dirname, '../../tsconfig.build.json');
  }
  return { execArgv, env };
}
