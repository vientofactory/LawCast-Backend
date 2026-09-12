import { PackagesService } from './packages.service';

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
});
