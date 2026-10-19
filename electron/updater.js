'use strict';

// ─── Software updates ───────────────────────────────────────────────────────
//
// Keeps Aventurine Manage current. The renderer drives it over IPC (preload.js →
// window.electronUpdater, UI in static/js/shell/updates.js): it reads the
// current state, toggles automatic updates, asks for a check, and is pushed
// every state change on 'update:status'.
//
// How an update is applied depends on the install (updatePolicy.js →
// resolveUpdateMode):
//   replace  electron-updater checks, downloads and installs in place. A
//            finished download also installs itself when the app quits.
//   package  electron-updater checks and downloads the .deb/.rpm; installing
//            needs an administrator password, so it waits for the user to
//            click Restart & Install.
//   notify   One request to GitHub's latest-release API. A newer version is
//            reported with a link to the download page.
//
// Automatic updates (on by default, see updatePolicy.js) check 10 seconds after
// launch and every 6 hours after that, and in the two install modes download
// what they find. Turned off, the app makes no network request unless the user
// clicks Check for Updates.
//
// NETWORK CONTRACT: this file is the only part of the app that touches the
// network. Each request goes to GitHub and carries nothing about the user or
// their data: no identifiers, no cookies, no database contents. GitHub sees
// what any download would show it, an IP address and a user agent that names
// the app version.
//
// TRUST: an update is checked against the SHA-512 listed in the release's
// latest*.yml, which comes from the same GitHub release over HTTPS. Windows and
// macOS builds are not code-signed yet (see electron-builder.yml), so that is
// the whole check: an update is as trustworthy as the GitHub account that
// publishes it. Releases start as drafts (release.yml), and neither feed shows
// a draft until someone publishes it by hand.

const fs = require('fs');
const path = require('path');
const { app, ipcMain, net, shell } = require('electron');
const policy = require('./updatePolicy');

const FIRST_CHECK_DELAY_MS = 10 * 1000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 20 * 1000;

// What the user sees when a step fails. The full error goes to the log; the UI
// gets a sentence that says what to do next.
const FAILURE_MESSAGES = {
    check:    'Couldn’t check for updates. Check your internet connection and try again.',
    download: 'The update couldn’t be downloaded. Try again later.',
    install:  'The update couldn’t be installed. Try again, or download it from the website.',
};

// electron-updater tags each update-metadata request with a random ID it keeps
// per install ('x-user-staging-id', for staged rollouts, which this project
// doesn't use). A stable ID sent to GitHub on every check is exactly what this
// app promises not to send, so it's removed here. computeFinalHeaders is
// internal to electron-updater, so this fails closed: if an upgrade drops the
// hook, the updater refuses to start rather than quietly sending the ID again.
// backend/__tests__/updatePolicy.test.js fails if the header is ever built
// anywhere else.
function stripInstallId(u) {
    const compute = u.computeFinalHeaders;
    if (typeof compute !== 'function') {
        throw new Error('electron-updater no longer exposes computeFinalHeaders; cannot strip x-user-staging-id');
    }
    u.computeFinalHeaders = function (headers) {
        const result = compute.call(this, headers);
        delete result['x-user-staging-id'];
        return result;
    };
}

// electron-builder's deb/rpm targets leave this marker in resources/; an
// AppImage, a Windows install and a dev run have none.
function readPackageType() {
    try {
        return fs.readFileSync(path.join(process.resourcesPath, 'package-type'), 'utf8').trim();
    } catch {
        return null;
    }
}

function initUpdater({ getWindow }) {
    const prefsDir = app.getPath('userData');
    const mode = policy.resolveUpdateMode({
        platform:    process.platform,
        isPackaged:  app.isPackaged,
        env:         process.env,
        packageType: app.isPackaged && process.platform === 'linux' ? readPackageType() : null,
    });

    let prefs = policy.readUpdatePreferences(prefsDir, {
        onError: (err) => console.error('[updater] update preferences unreadable, using defaults:', err.message),
    });

    // The current state. Held here, not only pushed, so a page that loads after
    // an event (every navigation is a fresh document) still shows it.
    //   state: idle | checking | up-to-date | available | downloading
    //          | downloaded | installing | error
    //   newVersion, percent, error: present when the state calls for them
    let status = { state: 'idle' };

    function snapshot() {
        return { mode, currentVersion: app.getVersion(), autoUpdate: prefs.autoUpdate, ...status };
    }

    function setStatus(next) {
        status = next;
        const win = getWindow();
        if (win && !win.isDestroyed()) win.webContents.send('update:status', snapshot());
    }

    function fail(step, err) {
        console.error(`[updater] ${step} failed:`, err);
        const error = FAILURE_MESSAGES[step];
        // A failed install leaves the download in place, so keep offering it
        // (a cancelled password prompt is the common case) instead of making
        // the user check and download all over again.
        if (step === 'install') setStatus({ state: 'downloaded', newVersion: status.newVersion, error });
        else setStatus({ state: 'error', error });
    }

    // ── notify mode: the latest-release API ─────────────────────────────────

    async function checkReleaseFeed() {
        setStatus({ state: 'checking' });
        try {
            const res = await net.fetch(policy.LATEST_RELEASE_API, {
                headers:     { Accept: 'application/vnd.github+json' },
                credentials: 'omit',
                signal:      AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            });
            if (!res.ok) throw new Error(`release feed answered HTTP ${res.status}`);
            const { version } = policy.parseLatestRelease(await res.json());
            setStatus(policy.isNewerVersion(version, app.getVersion())
                ? { state: 'available', newVersion: version }
                : { state: 'up-to-date' });
        } catch (err) {
            fail('check', err);
        }
    }

    // ── replace / package modes: electron-updater ───────────────────────────
    // Loaded on first use, so a notify-mode install never loads it at all.

    let updater = null;

    function getUpdater() {
        if (updater) return updater;
        const { autoUpdater } = require('electron-updater');
        stripInstallId(autoUpdater);
        updater = autoUpdater;
        updater.autoInstallOnAppQuit = mode === 'replace';

        updater.on('checking-for-update', () => setStatus({ state: 'checking' }));
        updater.on('update-not-available', () => setStatus({ state: 'up-to-date' }));
        // With autoDownload on, the download starts straight after this event,
        // so report it as downloading rather than flashing a Download button.
        updater.on('update-available', (info) => setStatus(updater.autoDownload
            ? { state: 'downloading', newVersion: info.version, percent: 0 }
            : { state: 'available', newVersion: info.version }));
        updater.on('download-progress', (p) => setStatus({
            state: 'downloading', newVersion: status.newVersion, percent: p.percent,
        }));
        updater.on('update-downloaded', (info) => setStatus({ state: 'downloaded', newVersion: info.version }));
        // Every failure, whichever call started it, arrives here. The step is
        // read off the state it interrupted.
        updater.on('error', (err) => {
            const step = status.state === 'installing' ? 'install'
                : status.state === 'downloading' ? 'download'
                : 'check';
            fail(step, err);
        });
        return updater;
    }

    async function checkWithUpdater() {
        let u;
        try {
            u = getUpdater();
        } catch (err) {
            // Includes stripInstallId refusing to run. No request was made.
            fail('check', err);
            return;
        }
        u.autoDownload = prefs.autoUpdate;
        try {
            const result = await u.checkForUpdates();
            // null means electron-updater decided it can't run here, without
            // raising an event. resolveUpdateMode should rule that out, so if it
            // happens, say so rather than leaving the UI on "Checking…".
            if (!result) {
                fail('check', new Error('electron-updater is inactive for this install'));
                return;
            }
            // An automatic download keeps running after the check resolves. Its
            // failure is reported through the 'error' event; this stops the
            // same failure also surfacing as an unhandled rejection.
            result.downloadPromise?.catch(() => {});
        } catch {
            // Reported through the 'error' event.
        }
    }

    // ── Actions ─────────────────────────────────────────────────────────────

    let checking = null;

    // Never rejects: every failure becomes an 'error' state. A second request
    // while one is running joins it, and once an update is being fetched or is
    // waiting to install there is nothing new to learn.
    function check() {
        if (checking) return checking;
        if (['downloading', 'downloaded', 'installing'].includes(status.state)) return Promise.resolve();
        checking = (mode === 'notify' ? checkReleaseFeed() : checkWithUpdater())
            .finally(() => { checking = null; });
        return checking;
    }

    async function download() {
        if (mode === 'notify' || status.state !== 'available') return;
        setStatus({ state: 'downloading', newVersion: status.newVersion, percent: 0 });
        try {
            await getUpdater().downloadUpdate();
        } catch {
            // Reported through the 'error' event.
        }
    }

    function install() {
        if (mode === 'notify' || status.state !== 'downloaded') return;
        setStatus({ state: 'installing', newVersion: status.newVersion });
        // Give the renderer a moment to paint "Installing…": a deb/rpm install
        // blocks this process while the password prompt is up. The database is
        // closed by main.js's will-quit handler on the way out.
        //   isSilent=false: the Windows installer shows its progress window.
        //   isForceRunAfter=true: reopen Aventurine Manage when it's done.
        setTimeout(() => getUpdater().quitAndInstall(false, true), 150);
    }

    // ── Automatic checks ────────────────────────────────────────────────────

    let firstCheckTimer = null;
    let intervalTimer = null;

    function stopAutomaticChecks() {
        clearTimeout(firstCheckTimer);
        clearInterval(intervalTimer);
        firstCheckTimer = null;
        intervalTimer = null;
    }

    function startAutomaticChecks(delayMs) {
        stopAutomaticChecks();
        firstCheckTimer = setTimeout(() => {
            check();
            intervalTimer = setInterval(check, CHECK_INTERVAL_MS);
        }, delayMs);
    }

    function setAutoUpdate(enabled) {
        if (typeof enabled !== 'boolean') throw new TypeError('autoUpdate must be a boolean');
        // Throws if the file can't be written; the renderer then puts the switch
        // back, so it never shows a setting that wasn't saved.
        policy.writeUpdatePreferences(prefsDir, { autoUpdate: enabled });
        prefs = { autoUpdate: enabled };
        if (updater) updater.autoDownload = enabled;
        // Switching it on checks straight away: the user has just asked for it.
        if (enabled) startAutomaticChecks(0);
        else stopAutomaticChecks();
    }

    // ── IPC ─────────────────────────────────────────────────────────────────
    // Registered before the window loads, so the page's first get-state never
    // races a missing handler. Nothing here takes a URL or a path from the
    // renderer: the download page is a constant.

    ipcMain.handle('update:get-state', () => snapshot());
    ipcMain.handle('update:set-auto', (_e, enabled) => {
        try {
            setAutoUpdate(enabled);
        } catch (err) {
            console.error('[updater] saving the automatic-updates preference failed:', err);
            throw err;
        }
        return snapshot();
    });
    ipcMain.handle('update:check', async () => { await check(); return snapshot(); });
    ipcMain.handle('update:download', async () => { await download(); return snapshot(); });
    ipcMain.handle('update:install', () => { install(); return snapshot(); });
    ipcMain.handle('update:open-download-page', () => shell.openExternal(policy.DOWNLOAD_PAGE_URL));

    if (prefs.autoUpdate) startAutomaticChecks(FIRST_CHECK_DELAY_MS);
}

module.exports = { initUpdater };
