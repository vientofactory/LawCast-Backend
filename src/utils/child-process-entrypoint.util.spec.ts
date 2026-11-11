import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import {
  isolatedChildOptions,
  resolveChildEntrypoint,
} from './child-process-entrypoint.util';

describe('isolated child entrypoints and common tooling', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'lawcast-child-entrypoint-'));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('uses TypeScript sources when compiled output is absent', async () => {
    const source = path.join(directory, 'worker.ts');
    await writeFile(source, 'export {};');
    expect(resolveChildEntrypoint(directory, 'worker')).toBe(source);
  });

  it('prefers emitted JavaScript when both source and output exist', async () => {
    await writeFile(path.join(directory, 'worker.ts'), 'export {};');
    const compiled = path.join(directory, 'worker.js');
    await writeFile(compiled, '');
    expect(resolveChildEntrypoint(directory, 'worker')).toBe(compiled);
  });

  it('rejects missing entrypoints rather than falling back to CJS assets', async () => {
    await writeFile(path.join(directory, 'worker.cjs'), '');
    expect(() => resolveChildEntrypoint(directory, 'worker')).toThrow(
      'Missing child process entrypoint',
    );
  });

  it('loads source children with the same build configuration', () => {
    const options = isolatedChildOptions('/fixture/worker.ts', 128);
    expect(options.execArgv).toEqual([
      '--max-old-space-size=128',
      '-r',
      require.resolve('ts-node/register/transpile-only'),
    ]);
    expect(options.env?.TS_NODE_PROJECT).toBe(
      path.resolve(__dirname, '../../tsconfig.build.json'),
    );
  });

  it('does not require a TypeScript runtime for production output or inherit parent secrets', () => {
    const options = isolatedChildOptions('/fixture/worker.js', 192);
    expect(options.execArgv).toEqual(['--max-old-space-size=192']);
    expect(options.env).not.toHaveProperty('TS_NODE_PROJECT');
    expect(options.env).not.toHaveProperty('NODE_OPTIONS');
    expect(Object.keys(options.env ?? {}).sort()).toEqual([
      'SQLITE_TMPDIR',
      'TEMP',
      'TMP',
      'TMPDIR',
      'TZ',
    ]);
  });

  it.each(['tsconfig.json', 'tsconfig.build.json'])(
    'includes both workers in %s without a special JS compiler project',
    (config) => {
      const root = path.resolve(__dirname, '../..');
      const file = ts.readConfigFile(path.join(root, config), ts.sys.readFile);
      expect(file.error).toBeUndefined();
      const parsed = ts.parseJsonConfigFileContent(file.config, ts.sys, root);
      expect(parsed.errors).toEqual([]);
      for (const worker of [
        'db-mirror/database-dump-child.ts',
        'change-tracking/chain-audit-child.ts',
      ]) {
        expect(parsed.fileNames).toContain(
          path.join(root, 'src/modules', worker),
        );
      }
    },
  );

  it('keeps both workers on the normal lint, format and API/native typecheck path', async () => {
    const root = path.resolve(__dirname, '../..');
    const { scripts } = JSON.parse(
      await readFile(path.join(root, 'package.json'), 'utf8'),
    );
    expect(scripts.format).toBe('prettier --write "src/**/*.ts"');
    expect(scripts.lint).toBe('eslint "{src,apps,libs}/**/*.ts" --fix');
    expect(scripts.check).toBe('tsc --noEmit && npm run check:native');
    expect(scripts.build).toBe('npm run check && nest build');
    expect(
      Object.keys(scripts).filter((name) => name.endsWith(':dump-child')),
    ).toEqual([]);
    const nest = JSON.parse(
      await readFile(path.join(root, 'nest-cli.json'), 'utf8'),
    );
    expect(nest.compilerOptions.assets).not.toContain(
      'modules/db-mirror/database-dump-child.cjs',
    );
  });
});
