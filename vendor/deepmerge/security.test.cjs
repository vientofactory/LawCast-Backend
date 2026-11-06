const { test } = require('node:test');
const assert = require('node:assert/strict');
const merge = require('./index.cjs');
for (const side of ['target', 'source']) {
  test(`does not poison returned prototypes from the ${side}`, () => {
    const malicious = JSON.parse('{"__proto__":{"poisoned":true},"nested":{"__proto__":{"poisoned":true}}}');
    const result = side === 'target' ? merge(malicious, {}) : merge({}, malicious);
    assert.equal(Object.getPrototypeOf(result), Object.prototype);
    assert.equal(Object.getPrototypeOf(result.nested), Object.prototype);
    assert.equal(result.poisoned, undefined);
    assert.equal(result.nested.poisoned, undefined);
    assert.equal({}.poisoned, undefined);
  });
}
test('preserves arrays, symbols, cloning and custom merge functions', () => {
  const key = Symbol('value');
  const original = { list: [1], nested: { a: 1 }, [key]: 3 };
  const result = merge(original, { list: [2], nested: { b: 2 } });
  assert.deepEqual(result.list, [1, 2]);
  assert.deepEqual(result.nested, { a: 1, b: 2 });
  assert.notEqual(result.nested, original.nested);
  assert.equal(result[key], 3);
  assert.deepEqual(merge.all([{ a: 1 }, { b: 2 }]), { a: 1, b: 2 });
  assert.deepEqual(merge({ list: [1] }, { list: [2] }, { customMerge: k => k === 'list' ? (_, b) => b : undefined }).list, [2]);
});
