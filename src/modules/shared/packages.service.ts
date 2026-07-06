import { Injectable, OnModuleInit } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { LoggerUtils } from '../../utils/logger.utils';

export interface PackageEntry {
  name: string;
  version: string;
  license: string;
}

@Injectable()
export class PackagesService implements OnModuleInit {
  private readonly logger = LoggerUtils.getContextLogger(PackagesService.name);
  private packages: PackageEntry[] = [];

  onModuleInit() {
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

      this.logger.log(`Loaded ${this.packages.length} backend packages`);
    } catch (err) {
      this.logger.error('Failed to load backend packages', err);
    }
  }

  getPackages(): PackageEntry[] {
    return this.packages;
  }
}
