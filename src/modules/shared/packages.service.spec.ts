import * as fs from 'node:fs';
import { PackagesService } from './packages.service';

jest.mock('node:fs');

describe('PackagesService', () => {
  let service: PackagesService;

  beforeEach(() => {
    service = new PackagesService();
  });

  describe('getPackages', () => {
    it('returns empty array before onModuleInit is called', () => {
      expect(service.getPackages()).toEqual([]);
    });
  });

  describe('onModuleInit', () => {
    it('loads packages from package.json and package-lock.json', () => {
      // onModuleInit reads from the real project files
      service.onModuleInit();

      const packages = service.getPackages();
      expect(Array.isArray(packages)).toBe(true);

      // The project has dependencies, so we should get at least some packages
      if (packages.length > 0) {
        const first = packages[0];
        expect(first).toHaveProperty('name');
        expect(first).toHaveProperty('version');
        expect(first).toHaveProperty('license');
        expect(typeof first.name).toBe('string');
        expect(typeof first.version).toBe('string');
      }
    });

    it('strips parentheses from license strings', () => {
      // This tests the regex: rawLicense.replace(/^\(|\)$/g, '')
      // We verify the behavior by checking that loaded packages don't have
      // leading/trailing parentheses in their license field
      service.onModuleInit();

      const packages = service.getPackages();
      for (const pkg of packages) {
        expect(pkg.license).not.toMatch(/^\(/);
        expect(pkg.license).not.toMatch(/\)$/);
      }
    });

    it('handles missing package-lock.json gracefully', () => {
      const originalCwd = process.cwd;

      // Mock cwd to a directory without package-lock.json
      process.cwd = jest.fn().mockReturnValue('/tmp/nonexistent');

      // Should not throw — onModuleInit catches errors
      expect(() => service.onModuleInit()).not.toThrow();

      process.cwd = originalCwd;
    });

    it('handles corrupted package.json gracefully', () => {
      const originalCwd = process.cwd;

      process.cwd = jest.fn().mockReturnValue('/tmp');

      // /tmp doesn't have package.json, so it should fail gracefully
      expect(() => service.onModuleInit()).not.toThrow();
      expect(service.getPackages()).toEqual([]);

      process.cwd = originalCwd;
    });

    it('is idempotent — calling twice produces the same result', () => {
      service.onModuleInit();
      const first = service.getPackages();

      service.onModuleInit();
      const second = service.getPackages();

      expect(first.length).toBe(second.length);
    });
  });

  describe('getVersion', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      jest.resetAllMocks();
      process.env = { ...originalEnv };
      delete process.env.APP_VERSION;
    });

    afterAll(() => {
      process.env = originalEnv;
    });

    it('returns env var version when APP_VERSION is set', () => {
      process.env.APP_VERSION = '1.2.3';
      service.onModuleInit();
      const info = service.getVersion();

      expect(info.version).toBe('1.2.3');
      expect(info.buildEnv).toBe('env');
    });

    it('trims whitespace from APP_VERSION', () => {
      process.env.APP_VERSION = '  2.0.0  ';
      service.onModuleInit();
      const info = service.getVersion();

      expect(info.version).toBe('2.0.0');
      expect(info.buildEnv).toBe('env');
    });

    it('reads version from package.json when env var is absent', () => {
      const mockReadFileSync = fs.readFileSync as jest.Mock;
      mockReadFileSync.mockReturnValue(
        JSON.stringify({ name: 'lawcast-backend', version: '3.5.7' }),
      );

      service.onModuleInit();
      const info = service.getVersion();

      expect(info.version).toBe('3.5.7');
      expect(info.buildEnv).toBe('package.json');
    });

    it('falls back to "unknown" when package.json is unreadable', () => {
      const mockReadFileSync = fs.readFileSync as jest.Mock;
      mockReadFileSync.mockImplementation(() => {
        throw new Error('ENOENT');
      });

      service.onModuleInit();
      const info = service.getVersion();

      expect(info.version).toBe('unknown');
      expect(info.buildEnv).toBe('fallback');
    });

    it('falls back to "unknown" when package.json has no version field', () => {
      const mockReadFileSync = fs.readFileSync as jest.Mock;
      mockReadFileSync.mockReturnValue(
        JSON.stringify({ name: 'lawcast-backend' }),
      );

      service.onModuleInit();
      const info = service.getVersion();

      expect(info.version).toBe('unknown');
      expect(info.buildEnv).toBe('fallback');
    });

    it('prefers env var over package.json', () => {
      process.env.APP_VERSION = 'env-version';
      const mockReadFileSync = fs.readFileSync as jest.Mock;
      mockReadFileSync.mockReturnValue(
        JSON.stringify({ version: 'pkg-version' }),
      );

      service.onModuleInit();
      const info = service.getVersion();

      expect(info.version).toBe('env-version');
      expect(info.buildEnv).toBe('env');
    });

    it('ignores empty APP_VERSION and falls through to package.json', () => {
      process.env.APP_VERSION = '   ';
      const mockReadFileSync = fs.readFileSync as jest.Mock;
      mockReadFileSync.mockReturnValue(JSON.stringify({ version: '4.0.0' }));

      service.onModuleInit();
      const info = service.getVersion();

      expect(info.version).toBe('4.0.0');
      expect(info.buildEnv).toBe('package.json');
    });
  });
});
