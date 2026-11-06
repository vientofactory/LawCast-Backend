const vm = require('node:vm');

const config = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: 'src',
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    '^.+\\.(t|j)s$': 'ts-jest',
  },
  transformIgnorePatterns: [
    'node_modules/(?!(.*/)?(?:@file-kiwi/node|pal-crawl)/)',
  ],
  moduleNameMapper: {
    '^@file-kiwi/node$': '<rootDir>/test/mocks/file-kiwi-node.mock.ts',
  },
  collectCoverageFrom: ['**/*.(t|j)s'],
  coverageDirectory: '../coverage',
  testEnvironment: 'node',
};

// Jest needs synchronous VM evaluation for native require(esm), available on Node 24.9+.
// Older supported runtimes transform dependency modules only inside the test harness.
if (typeof vm.SourceTextModule?.prototype.hasAsyncGraph !== 'function') {
  config.transform = {
    '^.+\\.tsx?$': 'ts-jest',
    '^.+\\.[cm]?js$': '<rootDir>/../scripts/jest-esm-transform.cjs',
  };
  config.transformIgnorePatterns = [];
}

module.exports = config;
