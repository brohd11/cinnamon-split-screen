// Ultrawide layouts for AR glasses. Built next to core.js; also importable by cjs tests.
'use strict';

const Core = typeof require === 'function' ? require('./core') : imports.core;

function aspectMode(bounds) {
    if (bounds.height <= 0) return null;
    const ratio = bounds.width / bounds.height;
    // Accommodate rounding of logical coordinates with fractional scaling.
    if (Math.abs(ratio - 32 / 9) < 0.01) return '32';
    if (Math.abs(ratio - 64 / 27) < 0.01) return '21';
    return null;
}

function regionsFor(bounds, workArea, layout32 = 'dual') {
    const mode = aspectMode(bounds);
    if (!mode) return [];
    let widths;
    if (mode === '21') {
        const left = Math.round(bounds.height * 16 / 9);
        widths = [left, bounds.width - left];
    } else if (layout32 === 'triple') {
        const side = Math.floor(bounds.width / 4);
        widths = [side, bounds.width - 2 * side, side];
    } else {
        const left = Math.floor(bounds.width / 2);
        widths = [left, bounds.width - left];
    }
    return Core.splitRegions(bounds, workArea, widths);
}
