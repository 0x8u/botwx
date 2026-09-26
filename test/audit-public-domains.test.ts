import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('public-domain audit', () => {
  it('accepts a source archive that omits optional ignored directories', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'botwx-domain-audit-'));
    roots.push(fixture);
    mkdirSync(join(fixture, 'scripts'), { recursive: true });
    mkdirSync(join(fixture, 'src'), { recursive: true });
    copyFileSync(
      resolve('scripts/audit-public-domains.mjs'),
      join(fixture, 'scripts/audit-public-domains.mjs'),
    );
    writeFileSync(join(fixture, 'README.md'), '# fixture\n');
    writeFileSync(join(fixture, 'README.en.md'), '# fixture\n');
    writeFileSync(join(fixture, 'package.json'), '{"private":true}\n');
    writeFileSync(join(fixture, 'src/index.ts'), 'export const safe = true;\n');

    // In particular, docs-site/ is deliberately ignored by Botwx and therefore
    // absent from the GitHub-generated tarball consumed by install.sh.
    const audited = spawnSync(process.execPath, [join(fixture, 'scripts/audit-public-domains.mjs')], {
      encoding: 'utf8',
    });

    expect(audited.status, audited.stderr).toBe(0);
    expect(audited.stdout).toContain('no private deployment hostnames found');
  });
});
