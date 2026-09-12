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
    this.versionInfo = this.resolveVersion();
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
      const cwd = process.cwd();
      const pkg = JSON.parse(
        readFileSync(resolve(cwd, 'package.json'), 'utf-8'),
      ) as {
        dependencies?: Record<string, string>;
      };
      const lock = JSON.parse(
        readFileSync(resolve(cwd, 'package-lock.json'), 'utf-8'),
      ) as {
        packages?: Record<string, { version: string; license?: string }>;
      };
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

  private resolveVersion(): VersionInfo {
    // 1. Environment variable — works in Docker / CI / Cloud deployment
    const envVersion = process.env.APP_VERSION?.trim();
    if (envVersion) {
      return { version: envVersion, buildEnv: 'env' };
    }

    // 2. Read from package.json at runtime
    try {
      const cwd = process.cwd();
      const pkg = JSON.parse(
        readFileSync(resolve(cwd, 'package.json'), 'utf-8'),
      ) as { version?: string };

      if (pkg.version) {
        return { version: pkg.version, buildEnv: 'package.json' };
      }
    } catch {
      // fall through
    }

    // 3. Hardcoded fallback
    return { version: 'unknown', buildEnv: 'fallback' };
  }
}
