'use strict';

// ─── theme-init.js ──────────────────────────────────────────────────────────
// Applies the saved color theme before first paint. Loaded as a classic
// (blocking) script in <head> so it runs synchronously during parsing —
// CSP-compatible (script-src 'self' forbids inline scripts).
//
// Sets the data-theme attribute on <html> from localStorage so the saved
// theme is the FIRST paint, with no flash of the default theme on nav.
//
// Stored 'color-theme' values: 'colorful' (light, with an accent sidebar — see
// themes.css), '' (plain light), 'dark', 'warm-light', 'warm-dark', 'tint-<hue>'
// (red, orange, blue, green, purple, pink) or 'system' (follow the OS). With
// NOTHING stored the value is 'colorful': that is the shipped default, and it is
// read as an absent key rather than as a stored '' so that picking Light stays a
// distinct, remembered choice.
//
// The warm pair is Light and Dark with a warmer grey ramp, and each tint is
// Light with a hue-tinted ramp and accent. They paint as data-theme '' / 'dark'
// plus data-warm or data-tint, so every rule keyed to the base theme keeps
// applying and themes.css only swaps the ramps. 'system' is the only value that
// needs resolving at paint time; the live picker (settings.js) repaints it when
// the OS preference changes while the app is open.
//
// Stored 'graph-theme' values: '' (the accent-derived Aventurine ramp, the
// default), 'gemstone', 'opal', 'lapis' or 'labradorite'. The graph palette is
// a SECOND, independent axis from the surface (see the block at the foot of
// themes.css).
//
// Both axes land on <html> as data-* before first paint, to avoid a flash of the
// wrong theme on nav. window.appTheme exposes the same reads and the painter to
// the live picker, so the variant table lives in this one file. 'ui-density' =
// 'compact' tightens table row heights (else comfortable) and is applied the
// same way.

(function () {
    // Every surface that is a variant of Light or Dark: the base theme it is
    // painted on, plus the flag themes.css keys its ramp on.
    const VARIANTS = {
        'warm-light':  { theme: '',     warm: true },
        'warm-dark':   { theme: 'dark', warm: true },
        'tint-red':    { theme: '',     tint: 'red' },
        'tint-orange': { theme: '',     tint: 'orange' },
        'tint-blue':   { theme: '',     tint: 'blue' },
        'tint-green':  { theme: '',     tint: 'green' },
        'tint-purple': { theme: '',     tint: 'purple' },
        'tint-pink':   { theme: '',     tint: 'pink' },
    };

    // 'colorful' was the graph palette's name before it was retoned to jewel
    // colours. The stored value is rewritten rather than merely mapped, because
    // an unknown value is not an error anywhere — it just falls through to the
    // accent ramp with no picker button lit — so a stale one would silently look
    // like the user had never chosen a palette at all.
    if (localStorage.getItem('graph-theme') === 'colorful') {
        localStorage.setItem('graph-theme', 'gemstone');
    }

    /** The stored surface choice, with Colorful standing in for an absent key.
     *  '' is read straight through, so plain Light stays a remembered choice. */
    function surface() {
        return localStorage.getItem('color-theme') ?? 'colorful';
    }

    /** The stored graph palette; '' (the Aventurine ramp) when none is stored. */
    function graph() {
        return localStorage.getItem('graph-theme') ?? '';
    }

    /** Paint both axes onto <html>. Called here pre-paint and by the live
     *  picker after a choice. */
    function apply() {
        const root = document.documentElement;
        const s = surface();
        const variant = VARIANTS[s] ?? null;
        const effective = s === 'system'
            ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : '')
            : variant ? variant.theme : s;
        if (effective) root.dataset.theme = effective;
        else delete root.dataset.theme;

        if (variant?.warm) root.dataset.warm = '';
        else delete root.dataset.warm;

        if (variant?.tint) root.dataset.tint = variant.tint;
        else delete root.dataset.tint;

        const g = graph();
        if (g) root.dataset.graphTheme = g;
        else delete root.dataset.graphTheme;
    }

    window.appTheme = { surface, graph, apply };

    apply();

    if (localStorage.getItem('ui-density') === 'compact') {
        document.documentElement.dataset.density = 'compact';
    }

    // Tag the host OS so the custom title bar (titlebar.css) can match the
    // platform's native window controls: macOS traffic lights on the left,
    // square Windows-style controls on the right elsewhere. Set pre-paint so
    // the bar never flashes the wrong layout. electronWindow comes from the
    // preload bridge; absent in a plain browser (no chrome there to style).
    const plat = window.electronWindow && window.electronWindow.platform;
    document.documentElement.dataset.platform =
        plat === 'darwin' ? 'mac' : plat === 'win32' ? 'win' : 'linux';
}());
