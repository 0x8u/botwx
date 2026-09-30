import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];

const fakeBunBody = `#!/bin/sh
set -eu
if [ "\${1:-}" = "--version" ]; then echo 1.4.2; exit 0; fi
if [ "\${1:-}" = "install" ]; then exit 0; fi
if [ "\${1:-}" = "run" ] && [ "\${2:-}" = "build" ]; then
  mkdir -p dist
  printf '%s\\n' '#!/usr/bin/env node' 'console.log("fixture botwx")' > dist/index-botwx.js
  chmod +x dist/index-botwx.js
  exit 0
fi
exit 2
`;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('botwx install.sh', () => {
  const scriptPath = resolve('install.sh');
  const source = readFileSync(scriptPath, 'utf8');

  it('is executable POSIX shell with the Botwx GitHub defaults', () => {
    expect(source.startsWith('#!/bin/sh')).toBe(true);
    expect(statSync(scriptPath).mode & 0o111).not.toBe(0);
    expect(source).toContain('0x8u/botwx');
    expect(source).toContain('botwx setup');
    expect(source).toContain('https://bun.com/install');
    expect(source).toContain('bun-v1.4.2');
    expect(source).not.toContain('deepcoldy/botmux');
    const syntax = spawnSync('sh', ['-n', scriptPath], { encoding: 'utf8' });
    expect(syntax.status, syntax.stderr).toBe(0);
  });

  it('uses a staged build and does not replace connector state', () => {
    expect(source).toContain('bun install --frozen-lockfile');
    expect(source).toContain('bun run build');
    expect(source).toContain('mv "$stage" "$APP_DIR"');
    expect(source).not.toMatch(/rm -rf "\$BOTWX_ROOT"/);
  });

  it('installs an archive end to end while preserving WeChat state', () => {
    const root = mkdtempSync(join(tmpdir(), 'botwx-installer-e2e-'));
    roots.push(root);
    const home = join(root, 'home');
    const fixture = join(root, 'botwx-fixture');
    const fakeBin = join(home, 'path-bin');
    mkdirSync(home, { recursive: true });
    mkdirSync(fixture, { recursive: true });
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(join(fixture, 'package.json'), '{"name":"botwx-fixture"}\n');
    writeFileSync(join(fixture, 'bun.lock'), 'fixture\n');

    const fakeBun = join(fakeBin, 'bun');
    writeFileSync(fakeBun, fakeBunBody);
    chmodSync(fakeBun, 0o755);

    const archive = join(root, 'botwx.tar.gz');
    const packed = spawnSync('tar', ['-czf', archive, '-C', root, 'botwx-fixture'], { encoding: 'utf8' });
    expect(packed.status, packed.stderr).toBe(0);

    const credential = join(home, '.botwx', 'openclaw-weixin', 'accounts.json');
    mkdirSync(join(home, '.botwx', 'openclaw-weixin'), { recursive: true });
    writeFileSync(credential, 'keep-me\n');

    const installed = spawnSync('sh', [scriptPath], {
      encoding: 'utf8',
      env: {
        ...process.env,
        BOTWX_ARCHIVE_URL: `file://${archive}`,
        HOME: home,
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        SHELL: '/bin/zsh',
      },
      timeout: 30_000,
    });
    expect(installed.status, installed.stderr).toBe(0);
    expect(installed.stdout).toContain('installed botwx');
    expect(readFileSync(credential, 'utf8')).toBe('keep-me\n');
    expect(existsSync(join(home, '.botwx', 'app', 'dist', 'index-botwx.js'))).toBe(true);
    expect(lstatSync(join(home, '.botwx', 'bin', 'botwx')).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(fakeBin, 'botwx')).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(home, '.zshenv'), 'utf8')).toContain('added by botwx installer');
    expect(readFileSync(join(home, '.zshenv'), 'utf8')).toContain('BOTWX_HOME');

    const smoke = spawnSync('botwx', [], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ''}` },
    });
    expect(smoke.status, smoke.stderr).toBe(0);
    expect(smoke.stdout.trim()).toBe('fixture botwx');
  });

  it('installs pinned Bun automatically when Bun is not on PATH', () => {
    const root = mkdtempSync(join(tmpdir(), 'botwx-bun-bootstrap-e2e-'));
    roots.push(root);
    const home = join(root, 'home');
    const fixture = join(root, 'botwx-fixture');
    const bunHome = join(root, 'bun-home');
    mkdirSync(home, { recursive: true });
    mkdirSync(fixture, { recursive: true });
    writeFileSync(join(fixture, 'package.json'), '{"name":"botwx-fixture"}\n');
    writeFileSync(join(fixture, 'bun.lock'), 'fixture\n');

    const archive = join(root, 'botwx.tar.gz');
    const packed = spawnSync('tar', ['-czf', archive, '-C', root, 'botwx-fixture'], { encoding: 'utf8' });
    expect(packed.status, packed.stderr).toBe(0);

    const bunInstaller = join(root, 'install-bun.sh');
    writeFileSync(bunInstaller, `#!/bin/sh
set -eu
[ "\${1:-}" = "bun-v1.4.2" ]
mkdir -p "\${BUN_INSTALL}/bin"
cat > "\${BUN_INSTALL}/bin/bun" <<'BOTWX_FAKE_BUN'
${fakeBunBody}BOTWX_FAKE_BUN
chmod +x "\${BUN_INSTALL}/bin/bun"
`);

    const pathWithoutBun = (process.env.PATH ?? '')
      .split(delimiter)
      .filter((entry) => entry.length > 0 && !existsSync(join(entry, 'bun')))
      .join(delimiter);
    const installed = spawnSync('sh', [scriptPath], {
      encoding: 'utf8',
      env: {
        ...process.env,
        BOTWX_ARCHIVE_URL: `file://${archive}`,
        BOTWX_BUN_INSTALL_URL: `file://${bunInstaller}`,
        BUN_INSTALL: bunHome,
        HOME: home,
        PATH: pathWithoutBun,
        SHELL: '/bin/sh',
      },
      timeout: 30_000,
    });
    expect(installed.status, installed.stderr).toBe(0);
    expect(installed.stdout).toContain('Bun not found; installing Bun 1.4.2');
    expect(existsSync(join(bunHome, 'bin', 'bun'))).toBe(true);
    expect(existsSync(join(home, '.botwx', 'app', 'dist', 'index-botwx.js'))).toBe(true);
  });
});
