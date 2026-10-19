'use strict';

// ─── Update policy ──────────────────────────────────────────────────────────
//
// The decisions behind software updates, kept free of Electron so the test
// suite can run them under plain Node (backend/__tests__/updatePolicy.test.js).
// electron/updater.js does the I/O and the IPC; this file answers:
//
//   • How can this install take an update?            resolveUpdateMode
//   • Is a published version newer than this one?     isNewerVersion
//   • What did the latest-release API answer?         parseLatestRelease
//   • Does the user want automatic updates?           read/writeUpdatePreferences
//
// The preference lives in its own small JSON file in the profile, not in the
// database's app_settings table: it belongs to the install rather than to any
// one database, and the first automatic check runs before a database is
// unlocked.

const fs = require('fs');
const path = require('path');

// The feed. electron-builder.yml's `publish:` block names the same repository;
// change both together or the in-place updater and the notify-only check will
// read different release lists.
const RELEASE_OWNER = 'aventurine-app';
const RELEASE_REPO = 'aventurine-lodestar';

const LATEST_RELEASE_API =
    `https://api.github.com/repos/${RELEASE_OWNER}/${RELEASE_REPO}/releases/latest`;
// Fixed, not taken from the API response: this URL is opened in the user's
// browser, so nothing a server sends can change where that goes.
const DOWNLOAD_PAGE_URL =
    `https://github.com/${RELEASE_OWNER}/${RELEASE_REPO}/releases/latest`;

// How this install can apply an update:
//   'replace'  Swap the app in place with no prompt: the per-user Windows
//              installer, or an AppImage replacing its own file.
//   'package'  Hand a .deb/.rpm to the system package manager. That needs an
//              administrator password, so it only ever runs when the user
//              clicks Restart & Install, never silently on quit.
//   'notify'   Can't update itself, so say a new version exists and link to
//              the download page. macOS lands here because the builds are
//              ad-hoc signed and the macOS updater refuses anything without a
//              Developer ID signature; so do dev runs and unrecognised Linux
//              installs (an unpacked directory, a distro repackage).
//
// The Linux checks mirror how electron-updater picks its own updater (its
// main.js): a `package-type` file written by electron-builder's deb/rpm
// targets wins, otherwise the APPIMAGE variable the AppImage runtime sets.
function resolveUpdateMode({ platform, isPackaged, env = {}, packageType = null }) {
    if (!isPackaged) return 'notify';
    if (platform === 'win32') return 'replace';
    if (platform === 'linux') {
        if (packageType === 'deb' || packageType === 'rpm') return 'package';
        if (env.APPIMAGE) return 'replace';
    }
    return 'notify';
}

// Release tags are plain MAJOR.MINOR.PATCH with an optional leading "v"
// (release.yml cuts them from `v*` tags). Anything else, including
// pre-release suffixes, is not something this app offers as an update, so it
// parses to null rather than being guessed at.
const VERSION_RE = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/;

function parseVersion(text) {
    if (typeof text !== 'string') return null;
    const m = VERSION_RE.exec(text.trim());
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function isNewerVersion(candidate, current) {
    const a = parseVersion(candidate);
    const b = parseVersion(current);
    if (!a || !b) return false;
    for (let i = 0; i < 3; i++) {
        if (a[i] !== b[i]) return a[i] > b[i];
    }
    return false;
}

// The one field read from GitHub's /releases/latest answer. That endpoint
// already skips drafts and pre-releases, which is what keeps an unpublished
// draft from reaching anyone. Throws on a body that doesn't carry a version
// we understand, so a changed or broken API shows up as a failed check
// rather than as "up to date".
function parseLatestRelease(body) {
    const version = parseVersion(body && body.tag_name);
    if (!version) throw new Error('latest release has no usable version tag');
    return { version: version.join('.') };
}

// ── Preferences ─────────────────────────────────────────────────────────────

const PREFERENCES_FILE = 'update-preferences.json';

// On by default: the point of the feature is that people stay current
// without having to remember to look.
const DEFAULT_PREFERENCES = Object.freeze({ autoUpdate: true });

// A missing file is the normal first-run case. An unreadable or malformed one
// falls back to the defaults too, but is reported, because it means a
// preference the user set has been lost.
function readUpdatePreferences(dir, { onError = () => {} } = {}) {
    const file = path.join(dir, PREFERENCES_FILE);
    let raw;
    try {
        raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
        if (err.code !== 'ENOENT') onError(err);
        return { ...DEFAULT_PREFERENCES };
    }
    try {
        const parsed = JSON.parse(raw);
        return {
            autoUpdate: typeof parsed.autoUpdate === 'boolean'
                ? parsed.autoUpdate
                : DEFAULT_PREFERENCES.autoUpdate,
        };
    } catch (err) {
        onError(err);
        return { ...DEFAULT_PREFERENCES };
    }
}

// Write-then-rename, so a crash mid-write leaves the previous file intact
// instead of a truncated one that would read back as the defaults. Throws, so
// the caller can tell the user the change wasn't saved.
function writeUpdatePreferences(dir, prefs) {
    if (typeof prefs.autoUpdate !== 'boolean') {
        throw new TypeError('autoUpdate must be a boolean');
    }
    const file = path.join(dir, PREFERENCES_FILE);
    const tmp = `${file}.tmp`;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ autoUpdate: prefs.autoUpdate }));
    fs.renameSync(tmp, file);
}

module.exports = {
    LATEST_RELEASE_API,
    DOWNLOAD_PAGE_URL,
    DEFAULT_PREFERENCES,
    PREFERENCES_FILE,
    resolveUpdateMode,
    parseVersion,
    isNewerVersion,
    parseLatestRelease,
    readUpdatePreferences,
    writeUpdatePreferences,
};
