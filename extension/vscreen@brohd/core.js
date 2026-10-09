// Desktop-independent geometry and placement state. Also importable by cjs tests.
'use strict';

function copyRect(r) {
    return {x: r.x, y: r.y, width: r.width, height: r.height};
}

function contains(r, x, y) {
    return x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height;
}

function intersection(a, b) {
    const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
    const width = Math.min(a.x + a.width, b.x + b.width) - x;
    const height = Math.min(a.y + a.height, b.y + b.height) - y;
    return width > 0 && height > 0 ? {x, y, width, height} : null;
}

function sameRect(a, b, tolerance = 0) {
    return a && b && ['x', 'y', 'width', 'height'].every(k => Math.abs(a[k] - b[k]) <= tolerance);
}

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
    let x = bounds.x;
    return widths.map((width, index) => {
        const rect = {x, y: bounds.y, width, height: bounds.height};
        x += width;
        return {index, bounds: rect, area: intersection(rect, workArea)};
    }).filter(r => r.area && r.area.width > 1);
}

function regionAt(regions, x, y) {
    return regions.find(r => contains(r.bounds, x, y)) || null;
}

function regionForWindow(regions, frame) {
    const x = frame.x + frame.width / 2, y = frame.y + frame.height / 2;
    return regionAt(regions, x, y) || regions.reduce((best, r) => {
        const overlap = intersection(r.bounds, frame);
        const area = overlap ? overlap.width * overlap.height : 0;
        return area > best.area ? {area, region: r} : best;
    }, {area: 0, region: null}).region;
}

// A region's dividers: x splits left from right, and each side has its own
// height split for quarters. Fractions of the region's work area.
var DEFAULT_SPLIT = {x: 0.5, left: 0.5, right: 0.5};

function sideOf(kind) { return kind.endsWith('left') ? 'left' : 'right'; }

function targetRect(region, kind, split = DEFAULT_SPLIT) {
    const r = copyRect(region.area);
    if (kind === 'full') return r;
    const side = sideOf(kind), left = Math.floor(r.width * split.x);
    if (side === 'left') r.width = left;
    else { r.x += left; r.width -= left; }
    const top = Math.floor(r.height * split[side]);
    if (kind.startsWith('top-')) r.height = top;
    else if (kind.startsWith('bottom-')) { r.y += top; r.height -= top; }
    return r;
}

// Which dividers a resize grab on these edges ('n', 's', 'e', 'w') moves, or
// null when the grab includes an outer edge of the window's slot.
function dividerFor(kind, edges) {
    if (kind === 'full' || !edges.length) return null;
    const side = sideOf(kind), vertical = side === 'left' ? 'e' : 'w';
    const horizontal = kind.startsWith('top-') ? 's' : kind.startsWith('bottom-') ? 'n' : null;
    if (!edges.every(e => e === vertical || e === horizontal)) return null;
    return {x: edges.includes(vertical), side: edges.includes(horizontal) ? side : null};
}

function resizeSplit(region, kind, divider, frame, split = DEFAULT_SPLIT) {
    const a = region.area, clamp = f => Math.max(0.1, Math.min(0.9, f));
    const next = {...split}, side = sideOf(kind);
    if (divider.x)
        next.x = clamp(((side === 'left' ? frame.x + frame.width : frame.x) - a.x) / a.width);
    if (divider.side)
        next[side] = clamp(((kind.startsWith('top-') ? frame.y + frame.height : frame.y) - a.y) / a.height);
    return next;
}

// Alt-drag zones cover the whole region: the centre 20% column fills it, each
// side takes the matching half, and the top/bottom 30% of a side is a quarter.
function altZoneFor(regions, x, y, splitFor = () => undefined) {
    const region = regionAt(regions, x, y);
    if (!region) return null;
    const r = region.area;
    const xFrac = (x - r.x) / r.width, yFrac = (y - r.y) / r.height;
    let kind;
    if (xFrac >= 0.40 && xFrac < 0.60) kind = 'full';
    else {
        const side = xFrac < 0.40 ? 'left' : 'right';
        if (yFrac < 0.30) kind = `top-${side}`;
        else if (yFrac >= 0.70) kind = `bottom-${side}`;
        else kind = side;
    }
    return {key: `${region.index}:${kind}`, region: region.index, kind,
        rect: targetRect(region, kind, splitFor(region.index))};
}

function edgeCandidate(regions, x, y, internalEdges = true, splitFor = () => undefined, band = 12) {
    const region = regionAt(regions, x, y);
    if (!region) return null;
    let kind, internal = false;
    if (y <= region.area.y + band) {
        kind = 'full'; // Top wins at corners, including the panel strip.
    } else if (x < region.bounds.x + band) {
        kind = 'left';
        internal = region.index > 0;
    } else if (x >= region.bounds.x + region.bounds.width - band) {
        kind = 'right';
        internal = region.index < regions[regions.length - 1].index;
    } else return null;
    if (internal && !internalEdges) return null;
    return {key: `${region.index}:${kind}`, region: region.index, kind, internal,
        rect: targetRect(region, kind, splitFor(region.index))};
}

var EdgeTracker = class EdgeTracker {
    constructor() { this.reset(); }
    reset() { this.key = null; this.since = 0; }
    update(candidate, now, dwell) {
        if (!candidate) { this.reset(); return null; }
        if (candidate.key !== this.key) { this.key = candidate.key; this.since = now; }
        return !candidate.internal || now - this.since >= dwell ? candidate : null;
    }
};

function clampRect(rect, workArea) {
    const width = Math.min(rect.width, workArea.width), height = Math.min(rect.height, workArea.height);
    return {x: Math.max(workArea.x, Math.min(rect.x, workArea.x + workArea.width - width)),
        y: Math.max(workArea.y, Math.min(rect.y, workArea.y + workArea.height - height)), width, height};
}

// The native maximized bit cannot describe an arbitrary region. Keep restore
// geometry ourselves and treat another native maximize request as a toggle.
var WindowState = class WindowState {
    constructor() { this.placement = null; }
    assign(original, monitor, region, kind = 'full') {
        const restore = this.placement ? this.placement.original : copyRect(original);
        this.placement = {original: restore, monitor, region, kind, suspended: false};
        return this.placement;
    }
    maximize(original, monitor, region) {
        if (this.placement && !this.placement.suspended && this.placement.kind === 'full')
            return {type: 'restore', rect: this.release()};
        this.assign(original, monitor, region);
        return {type: 'apply', placement: this.placement};
    }
    suspend() { if (this.placement) this.placement.suspended = true; }
    resume() {
        if (!this.placement || !this.placement.suspended) return null;
        this.placement.suspended = false;
        return this.placement;
    }
    release() {
        const rect = this.placement ? copyRect(this.placement.original) : null;
        this.placement = null;
        return rect;
    }
};
