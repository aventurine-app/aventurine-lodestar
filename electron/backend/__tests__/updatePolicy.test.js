'use strict';

// Software-update policy (electron/updatePolicy.js). The rules pinned here are
// the ones that fail quietly if they drift: an install sorted into the wrong
// mode either never updates or tries an install it can't finish; a loose
// version compare offers a downgrade or skips a release; and a preference that
// reads back wrong turns network checks on for someone who turned them off.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const policy = require('../../updatePolicy');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lodestar-update-prefs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ── resolveUpdateMode ───────────────────────────────────────────────────────

test('update mode: a dev run only ever notifies, on every platform', () => {
  for (const platform of ['win32', 'linux', 'darwin']) {
    assert.equal(policy.resolveUpdateMode({
      platform, isPackaged: false, env: { APPIMAGE: '/x.AppImage' }, packageType: 'rpm',
    }), 'notify', platform);
  }
});

test('update mode: packaged Windows replaces itself', () => {
  assert.equal(policy.resolveUpdateMode({ platform: 'win32', isPackaged: true }), 'replace');
});

test('update mode: macOS notifies (ad-hoc signed builds cannot update in place)', () => {
  assert.equal(policy.resolveUpdateMode({ platform: 'darwin', isPackaged: true }), 'notify');
});

test('update mode: deb and rpm go through the package manager', () => {
  for (const packageType of ['deb', 'rpm']) {
    assert.equal(policy.resolveUpdateMode({
      platform: 'linux', isPackaged: true, env: {}, packageType,
    }), 'package', packageType);
  }
});

test('update mode: the package-type marker wins over APPIMAGE, as in electron-updater', () => {
  assert.equal(policy.resolveUpdateMode({
    platform: 'linux', isPackaged: true, env: { APPIMAGE: '/x.AppImage' }, packageType: 'rpm',
  }), 'package');
});

test('update mode: an AppImage replaces its own file', () => {
  assert.equal(policy.resolveUpdateMode({
    platform: 'linux', isPackaged: true, env: { APPIMAGE: '/home/u/lodestar.AppImage' },
  }), 'replace');
});

test('update mode: an unrecognised Linux install notifies', () => {
  // An unpacked directory or a distro repackage: no marker, no APPIMAGE.
  assert.equal(policy.resolveUpdateMode({ platform: 'linux', isPackaged: true, env: {} }), 'notify');
  // electron-builder can also write 'pacman', which this project doesn't build.
  assert.equal(policy.resolveUpdateMode({
    platform: 'linux', isPackaged: true, env: {}, packageType: 'pacman',
  }), 'notify');
});

// ── Versions ────────────────────────────────────────────────────────────────

test('versions: parse plain and v-prefixed release tags', () => {
  assert.deepStrictEqual(policy.parseVersion('0.9.8'), [0, 9, 8]);
  assert.deepStrictEqual(policy.parseVersion('v1.10.0'), [1, 10, 0]);
  assert.deepStrictEqual(policy.parseVersion(' v2.0.1 '), [2, 0, 1]);
});

test('versions: anything that is not MAJOR.MINOR.PATCH is not a version', () => {
  for (const bad of ['', '1.2', '1.2.3.4', '1.2.3-beta.1', 'latest', 'v', null, undefined, 3]) {
    assert.equal(policy.parseVersion(bad), null, String(bad));
  }
});

test('versions: compare numerically, field by field', () => {
  assert.equal(policy.isNewerVersion('0.9.9', '0.9.8'), true);
  assert.equal(policy.isNewerVersion('0.10.0', '0.9.8'), true, 'not a string compare');
  assert.equal(policy.isNewerVersion('1.0.0', '0.99.99'), true);
  assert.equal(policy.isNewerVersion('v0.9.8', '0.9.8'), false, 'equal is not newer');
  assert.equal(policy.isNewerVersion('0.9.7', '0.9.8'), false, 'never offer a downgrade');
});

test('versions: an unreadable version is never newer', () => {
  assert.equal(policy.isNewerVersion('1.0.0-rc.1', '0.9.8'), false);
  assert.equal(policy.isNewerVersion('1.0.0', 'garbage'), false);
});

test('latest release: reads the tag, and fails loudly on a tag it cannot use', () => {
  assert.deepStrictEqual(policy.parseLatestRelease({ tag_name: 'v1.2.3' }), { version: '1.2.3' });
  // A changed or broken answer must read as a failed check, not as "up to date".
  assert.throws(() => policy.parseLatestRelease({ tag_name: 'nightly' }));
  assert.throws(() => policy.parseLatestRelease({}));
  assert.throws(() => policy.parseLatestRelease(null));
});

test('download page: a fixed https URL on the release repository', () => {
  const u = new URL(policy.DOWNLOAD_PAGE_URL);
  assert.equal(u.protocol, 'https:');
  assert.equal(u.host, 'github.com');
  assert.ok(u.pathname.startsWith('/aventurine-app/aventurine-lodestar/releases'));
});

// ── electron-updater's install ID ───────────────────────────────────────────
// electron-updater sends a random per-install ID ('x-user-staging-id') with
// every update check. electron/updater.js strips it by wrapping
// computeFinalHeaders, the one function that builds those headers. This trips
// if an upgrade starts adding the ID anywhere that wrapper doesn't cover, so
// the ID can't quietly start reaching GitHub again.

test('electron-updater: the install ID is only ever added through computeFinalHeaders', () => {
  const outDir = path.join(path.dirname(require.resolve('electron-updater')));
  const sources = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) sources.push(full);
    }
  }(outDir));

  const uses = [];
  for (const file of sources) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (line.includes('x-user-staging-id')) uses.push({ file: path.relative(outDir, file), line: line.trim() });
    }
  }
  assert.ok(uses.length > 0, 'the header is gone upstream: remove stripInstallId and this test');
  for (const use of uses) {
    assert.match(use.line, /computeFinalHeaders\(\{\s*"x-user-staging-id"/, JSON.stringify(use));
  }
  assert.ok(sources.some((f) => /\bcomputeFinalHeaders\(headers\)/.test(fs.readFileSync(f, 'utf8'))),
    'computeFinalHeaders is no longer defined; updater.js would refuse to start the updater');
});

// ── Preferences ─────────────────────────────────────────────────────────────

test('preferences: a first run reads the defaults (automatic updates on)', (t) => {
  const dir = tempDir(t);
  const errors = [];
  assert.deepStrictEqual(policy.readUpdatePreferences(dir, { onError: (e) => errors.push(e) }),
    { autoUpdate: true });
  assert.deepStrictEqual(errors, [], 'a missing file is normal, not an error');
});

test('preferences: a saved choice reads back, both ways', (t) => {
  const dir = tempDir(t);
  policy.writeUpdatePreferences(dir, { autoUpdate: false });
  assert.deepStrictEqual(policy.readUpdatePreferences(dir), { autoUpdate: false });
  policy.writeUpdatePreferences(dir, { autoUpdate: true });
  assert.deepStrictEqual(policy.readUpdatePreferences(dir), { autoUpdate: true });
});

test('preferences: the write leaves no temp file behind', (t) => {
  const dir = tempDir(t);
  policy.writeUpdatePreferences(dir, { autoUpdate: false });
  assert.deepStrictEqual(fs.readdirSync(dir), [policy.PREFERENCES_FILE]);
});

test('preferences: a corrupt file falls back to the defaults and is reported', (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, policy.PREFERENCES_FILE), '{"autoUpdate": fal');
  const errors = [];
  assert.deepStrictEqual(policy.readUpdatePreferences(dir, { onError: (e) => errors.push(e) }),
    { autoUpdate: true });
  assert.equal(errors.length, 1);
});

test('preferences: a non-boolean value is not read as a choice', (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, policy.PREFERENCES_FILE), '{"autoUpdate": "false"}');
  assert.deepStrictEqual(policy.readUpdatePreferences(dir), { autoUpdate: true });
});

test('preferences: writing anything but a boolean throws and keeps the old file', (t) => {
  const dir = tempDir(t);
  policy.writeUpdatePreferences(dir, { autoUpdate: false });
  assert.throws(() => policy.writeUpdatePreferences(dir, { autoUpdate: 'on' }), TypeError);
  assert.deepStrictEqual(policy.readUpdatePreferences(dir), { autoUpdate: false });
});
