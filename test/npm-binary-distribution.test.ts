import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseNpmPackJson } from '../scripts/parse-npm-pack-json.mjs';

interface PackRow {
  name?: string;
  files: Array<{ path: string }>;
}

function parsePackReport(stdout: string, packageName: string): PackRow {
  const rows = parseNpmPackJson(stdout) as PackRow[];
  const report = rows.find(row => row.name === packageName) ?? rows[0];
  if (!report) throw new Error('npm pack produced no package report');
  return report;
}

describe('botwx package distribution', () => {
  const manifest = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as {
    name: string;
    bin?: Record<string, string>;
    files?: string[];
    scripts: Record<string, string>;
    dependencies: Record<string, string>;
    repository?: { type?: string; url?: string };
  };

  it('publishes one explicit Botwx entry with a pinned connector SDK', () => {
    expect(manifest.name).toBe('botwx');
    expect(manifest.bin).toEqual({ botwx: 'dist/index-botwx.js' });
    expect(manifest.dependencies['weixin-agent-sdk']).toBe('0.5.0');
    expect(manifest.repository).toEqual({
      type: 'git',
      url: 'git+https://github.com/0x8u/botwx.git',
    });
    expect(manifest.scripts.postinstall).toBeUndefined();
    expect(existsSync(resolve('src/index-botwx.ts'))).toBe(true);
  });

  it('keeps the public entry on the WeChat runtime path', () => {
    const entry = readFileSync(resolve('src/index-botwx.ts'), 'utf8');
    expect(entry.startsWith('#!/usr/bin/env node')).toBe(true);
    expect(entry).toContain("from 'weixin-agent-sdk'");
    expect(entry).toContain("import('./im/weixin/runtime.js')");
    expect(entry).not.toContain('index-daemon');
    expect(entry).not.toContain('@larksuiteoapi');
  });

  it('ships the built command declared by package.json', () => {
    const packed = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: resolve('.'),
      encoding: 'utf8',
      timeout: 120_000,
    });
    expect(packed.error, packed.error?.message).toBeUndefined();
    expect(packed.status, packed.stderr).toBe(0);
    const paths = parsePackReport(packed.stdout, manifest.name).files.map(file => file.path);
    expect(paths).toContain('package.json');
    expect(paths).toContain('README.md');
    expect(paths).toContain('README.en.md');
    expect(paths).toContain('dist/index-botwx.js');
    expect(paths).not.toContain('scripts/botmux-launcher.sh');
  });

  it('the declared bin is executable after build', () => {
    const bin = manifest.bin?.botwx;
    expect(bin).toBe('dist/index-botwx.js');
    const built = readFileSync(resolve(bin!), 'utf8');
    expect(built.startsWith('#!/usr/bin/env node')).toBe(true);
    expect(statSync(resolve(bin!)).mode & 0o111).not.toBe(0);
    expect(manifest.scripts.build).toMatch(/chmod \+x [^&]*dist\/index-botwx\.js/);
  });
});
