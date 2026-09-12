import { Injectable, OnModuleInit } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { LoggerUtils } from '../../utils/logger.utils';

export interface PackageEntry {
  name: string;
  version: string;
  license: string;
}

export interface VersionInfo {
  /** Application version derived from environment or package.json. */
  version: string;
  /** How the version was resolved (env, package.json, fallback). */
  buildEnv: string;
}

@Injectable()
export class PackagesService implements OnModuleInit {
  private readonly logger = LoggerUtils.getContextLogger(PackagesService.name);
  private packages: PackageEntry[] = [];
  private versionInfo: VersionInfo = {
    version: 'unknown',
    buildEnv: 'unknown',
  };

  onModuleInit() {
    this.loadPackages();
    this.loadVersion();
    this.logger.log(
      `Loaded ${this.packages.length} backend packages, version: ${this.versionInfo.version} (${this.versionInfo.buildEnv})`,
    );
  }

  getPackages(): PackageEntry[] {
    return this.packages;
  }

  /**
   * Returns the application version resolved from environment or package.json.
   *
   * Resolution order (multi-fallback):
   *  1. `APP_VERSION` environment variable  (Docker, CI, deployment)
   *  2. `version` field in backend `package.json`  (local dev, production)
   *  3. Hardcoded `'unknown'` fallback
   */
  getVersion(): VersionInfo {
    return this.versionInfo;
  }

  /* ------------------------------------------------------------------ */
  /*  Private helpers                                                    */
  /* ------------------------------------------------------------------ */

  private loadPackages(): void {
    try {
      const pkg = this.readJson<{
        dependencies?: Record<string, string>;
      }>('package.json');
      const lock = this.readJson<{
        packages?: Record<string, { version: string; license?: string }>;
      }>('package-lock.json');
      const lockPkgs = lock.packages ?? {};

      this.packages = Object.keys(pkg.dependencies ?? {}).map((name) => {
        const entry = lockPkgs[`node_modules/${name}`];
        const rawLicense = entry?.license ?? 'Unknown';
        const license = rawLicense.replace(/^\(|\)$/g, '');
        return {
          name,
          version: entry?.version ?? pkg.dependencies?.[name] ?? '',
          license,
        };
      });
    } catch (err) {
      this.logger.error('Failed to load backend packages', err);
    }
  }

  /**
   * Resolve and cache the application version once at startup.
   *
   * Resolution order:
   *  1. `APP_VERSION` env var  (Docker / CI / Cloud deployment)
   *  2. `version` in package.json  (local dev / production)
   *  3. `'unknown'` fallback
   */
  private loadVersion(): void {
    // 1. Environment variable
    const envVersion = process.env.APP_VERSION?.trim();
    if (envVersion) {
      this.versionInfo = { version: envVersion, buildEnv: 'env' };
      return;
    }

    // 2. package.json
    const pkg = this.readJson<{ version?: string }>('package.json');
    if (pkg.version) {
      this.versionInfo = { version: pkg.version, buildEnv: 'package.json' };
      return;
    }

    // 3. Fallback
    this.versionInfo = { version: 'unknown', buildEnv: 'fallback' };
  }

  /**
   * Read and parse a JSON file relative to process.cwd().
   * Returns a partial object on parse failure so callers can safely
   * access optional fields without try/catch.
   */
  private readJson<T>(filename: string): Partial<T> {
    try {
      return JSON.parse(
        readFileSync(resolve(process.cwd(), filename), 'utf-8'),
      ) as Partial<T>;
    } catch {
      return {};
    }
  }
}
