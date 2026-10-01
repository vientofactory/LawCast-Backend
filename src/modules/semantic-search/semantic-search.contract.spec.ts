/**
 * Cross-language contract pinning for the semantic sidecar wire contract.
 *
 * The `/search` contract is dual-owned: Pydantic models (`SearchHit`,
 * `SearchResponse`) in `semantic-search/service/app.py` and TypeScript
 * interfaces (`SemanticSidecarChunk`, `SemanticSidecarSearchResponse`) in
 * `semantic-search.types.ts`. Neither language sees the other at compile
 * time, so a rename, type change or cap change on either side drifts
 * silently and only surfaces at runtime inside the service. This spec parses
 * both declarations and compares them field-by-field in one place — the
 * monorepo checkout (root CI runs `submodules: recursive`) keeps both files
 * available whenever the backend suite runs.
 *
 * Type mapping is intentionally lossy in one spot: Python `int`/`float` both
 * canonicalize to `number` because TypeScript has a single number type.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

type FieldMap = Record<string, string>;

const WORKSPACE_ROOT = path.resolve(__dirname, '../../../..');
const TS_TYPES_PATH = path.join(__dirname, 'semantic-search.types.ts');
const TS_CONSTANTS_PATH = path.join(__dirname, 'semantic-search.constants.ts');
const PY_APP_PATH = path.join(
  WORKSPACE_ROOT,
  'semantic-search',
  'service',
  'app.py',
);

const readContractSource = (filePath: string): string => {
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `contract counterpart missing: ${filePath}. The wire contract is ` +
        'dual-owned (semantic-search/service/app.py vs ' +
        'semantic-search.types.ts); both submodules must be checked out ' +
        '(the root CI workflow does this recursively).',
    );
  }
  return fs.readFileSync(filePath, 'utf8');
};

const CONTRACT_TYPE_ALIASES: Record<string, string> = {
  // TypeScript atoms
  string: 'string',
  number: 'number',
  boolean: 'boolean',
  null: 'null',
  // Python atoms
  str: 'string',
  int: 'number',
  float: 'number',
  bool: 'boolean',
  None: 'null',
  // Model references (both sides)
  SemanticSidecarChunk: 'hit',
  SearchHit: 'hit',
  SemanticSidecarSearchResponse: 'response',
  SearchResponse: 'response',
};

const canonicalType = (typeText: string): string => {
  const text = typeText.trim();
  const listMatch = text.match(/^(?:list\[(.+)\]|(.+)\[\])$/);
  if (listMatch) {
    return `list<${canonicalType(listMatch[1] ?? listMatch[2])}>`;
  }
  const atoms = text.split('|').map((part) => {
    const atom = part.trim();
    const mapped = CONTRACT_TYPE_ALIASES[atom];
    if (!mapped) {
      throw new Error(`unmapped contract type atom: ${atom}`);
    }
    return mapped;
  });
  return [...atoms].sort().join('|');
};

const parseTsSource = (filePath: string): ts.SourceFile =>
  ts.createSourceFile(
    filePath,
    readContractSource(filePath),
    ts.ScriptTarget.Latest,
    true,
  );

/**
 * Parse one interface declaration from the TS contract file. Only the two
 * wire interfaces are pinned; backend-owned response types are out of scope
 * (they never cross the sidecar boundary).
 */
const tsInterface = (name: string): FieldMap => {
  const sourceFile = parseTsSource(TS_TYPES_PATH);
  for (const statement of sourceFile.statements) {
    if (!ts.isInterfaceDeclaration(statement) || statement.name.text !== name) {
      continue;
    }
    const fields: FieldMap = {};
    for (const member of statement.members) {
      if (ts.isPropertySignature(member) && member.type) {
        fields[(member.name as ts.Identifier).text] = canonicalType(
          member.type.getText(sourceFile),
        );
      }
    }
    return fields;
  }
  throw new Error(`interface ${name} not found in ${TS_TYPES_PATH}`);
};

const tsConstants = (): Record<string, number> => {
  const sourceFile = parseTsSource(TS_CONSTANTS_PATH);
  const constants: Record<string, number> = {};
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.initializer &&
        ts.isNumericLiteral(declaration.initializer)
      ) {
        constants[declaration.name.text] = Number(declaration.initializer.text);
      }
    }
  }
  return constants;
};

/**
 * Line-based parse of the Pydantic model declarations. The contract models
 * only contain annotated fields (`name: type` or `name: type = Field(...)`),
 * so this stays exact for the pinned shapes and throws on unknown atoms.
 */
const pyModels = (): Record<string, FieldMap> => {
  const models: Record<string, FieldMap> = {};
  let current: FieldMap | null = null;
  for (const line of readContractSource(PY_APP_PATH).split('\n')) {
    const classMatch = line.match(/^class (\w+)\(BaseModel\):/);
    if (classMatch) {
      current = {};
      models[classMatch[1]] = current;
      continue;
    }
    if (/^\S/.test(line)) {
      // Any module-level statement ends the current class body.
      current = null;
      continue;
    }
    if (!current) {
      continue;
    }
    const fieldMatch = line.match(/^ {4}(\w+)\*?: (.+)$/);
    if (fieldMatch) {
      current[fieldMatch[1]] = canonicalType(
        fieldMatch[2].split(' = ')[0].trim(),
      );
    }
  }
  return models;
};

const pyConstants = (): Record<string, number> => {
  const constants: Record<string, number> = {};
  for (const line of readContractSource(PY_APP_PATH).split('\n')) {
    const match = line.match(/^([A-Z_]+) = (\d+)$/);
    if (match) {
      constants[match[1]] = Number(match[2]);
    }
  }
  return constants;
};

describe('semantic sidecar cross-language contract', () => {
  it('pins SearchHit (Python) to SemanticSidecarChunk (TS) field-by-field', () => {
    expect(pyModels().SearchHit).toEqual(tsInterface('SemanticSidecarChunk'));
  });

  it('pins SearchResponse (Python) to SemanticSidecarSearchResponse (TS) field-by-field', () => {
    expect(pyModels().SearchResponse).toEqual(
      tsInterface('SemanticSidecarSearchResponse'),
    );
  });

  it('pins the sidecar chunk-window cap (MAX_K) to SIDE_CAR_MAX_CHUNK_K', () => {
    // DEFAULT_K is deliberately not pinned: the sidecar default counts
    // chunks while the API default counts notices — different semantics.
    expect(pyConstants().MAX_K).toBe(tsConstants().SIDE_CAR_MAX_CHUNK_K);
  });
});
