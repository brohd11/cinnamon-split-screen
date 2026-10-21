'use strict';
imports.searchPath.unshift(ARGV[0]);
const C = imports.core;
let count = 0;
function equal(actual, expected, message) {
    count++;
    if (JSON.stringify(actual) !== JSON.stringify(expected))
        throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
const bounds = {x: -100, y: -1080, width: 3840, height: 1080};
const area = {x: -100, y: -1050, width: 3840, height: 1050};
const dual = C.splitRegions(bounds, area, [1920, 1920]);
equal(dual[1].area, {x: 1820, y: -1050, width: 1920, height: 1050}, 'panel exclusion, negative origin');
equal(C.splitRegions(bounds, {...area, width: 1921}, [1920, 1920]).length, 1, 'regions without work area dropped');
equal(C.regionForWindow(dual, {x: 1800, y: -1000, width: 200, height: 100}).index, 1, 'center selects region');
equal(C.regionAt(dual, 1820, -1000).index, 1, 'boundary belongs to right region');
equal(C.regionAt(dual, 3740, -1000), null, 'right bound exclusive');
equal(C.targetRect(dual[1], 'left'), {x: 1820, y: -1050, width: 960, height: 1050}, 'left half of region');
equal(C.targetRect({area: {x: 0, y: 0, width: 641, height: 1080}}, 'right'),
    {x: 320, y: 0, width: 321, height: 1080}, 'half remainder');
equal(C.edgeCandidate(dual, 1819, -1075).kind, 'top-right', 'corner is a quarter');
equal(C.edgeCandidate(dual, 900, -1075).kind, 'full', 'top edge away from sides fills region');
equal(C.edgeCandidate(dual, -100, -800).kind, 'top-left', 'side edge top 25% is a quarter');
equal(C.edgeCandidate(dual, -100, -780).kind, 'left', 'side edge middle is a half');
equal(C.edgeCandidate(dual, -100, -262).kind, 'bottom-left', 'side edge bottom 25% is a quarter');
equal(C.edgeCandidate(dual, 1819, -1000).internal, true, 'internal corner needs dwell');
equal(C.edgeCandidate(dual, 1819, -1000, false), null, 'internal corner off with internal edges');
equal(C.edgeCandidate(dual, -100, -1000).rect, {x: -100, y: -1050, width: 960, height: 525}, 'edge quarter rect');
equal(C.edgeCandidate(dual, 1819, -500).kind, 'right', 'approach inner boundary from left');
equal(C.edgeCandidate(dual, 1820, -500).kind, 'left', 'approach inner boundary from right');
equal(C.edgeCandidate(dual, 1819, -500, false), null, 'internal edges disabled');
equal(C.edgeCandidate(dual, -100, -500, false).internal, false, 'outer edge remains');
equal(C.edgeCandidate(dual, 400, -500), null, 'interior does not snap');
const altKind = (x, y) => C.altZoneFor(dual, x, y).kind;
equal(altKind(860, -500), 'full', 'alt centre column fills region');
equal(C.altZoneFor(dual, 860, -500).rect, dual[0].area, 'alt full rect is region work area');
equal([altKind(667, -500), altKind(668, -500)], ['left', 'full'], 'alt centre starts at 40%');
equal([altKind(1051, -500), altKind(1052, -500)], ['full', 'right'], 'alt centre ends at 60%');
equal(altKind(0, -525), 'left', 'alt side is half');
equal(altKind(667, -1000), 'top-left', 'alt corner spans the whole side width');
equal(C.altZoneFor(dual, 0, -1040).rect, {x: -100, y: -1050, width: 960, height: 525}, 'alt top-left quarter');
equal(C.altZoneFor(dual, 1700, -10).rect, {x: 860, y: -525, width: 960, height: 525}, 'alt bottom-right quarter');
equal(C.altZoneFor(dual, 2000, -500).region, 1, 'alt zones are per region');
equal(C.altZoneFor(dual, 3740, -500), null, 'alt outside regions');
equal(C.targetRect({area: {x: 0, y: 0, width: 641, height: 1081}}, 'bottom-right'),
    {x: 320, y: 540, width: 321, height: 541}, 'quarter remainder');
const split = {x: 0.7, left: 0.5, right: 0.25};
equal(C.targetRect(dual[0], 'left', split).width, 1344, 'left uses vertical divider');
equal(C.targetRect(dual[0], 'right', split), {x: 1244, y: -1050, width: 576, height: 1050}, 'right fills the rest');
equal(C.targetRect(dual[0], 'top-right', split).height, 262, 'quarter uses its side height divider');
equal(C.targetRect(dual[0], 'full', split), dual[0].area, 'full ignores dividers');
equal(C.dividerFor('left', ['e']), {x: true, side: null}, 'left tile east edge is the divider');
equal(C.dividerFor('left', ['w']), null, 'outer edge is not a divider');
equal(C.dividerFor('top-right', ['s', 'w']), {x: true, side: 'right'}, 'quarter corner moves both dividers');
equal(C.dividerFor('top-right', ['n', 'w']), null, 'mixed outer edge releases');
equal(C.dividerFor('full', ['e']), null, 'full has no divider');
equal(C.dividerFor('right', []), null, 'unknown keyboard resize');
equal(C.resizeSplit(dual[0], 'left', {x: true, side: null}, {x: -100, y: -1050, width: 1536, height: 1050}).x,
    0.8, 'divider follows the resized edge');
equal(C.resizeSplit(dual[0], 'left', {x: true, side: null}, {x: -100, y: -1050, width: 10, height: 1050}).x,
    0.1, 'divider is clamped');
const push = (kind, dir, region = 0, regions = [0, 1]) => C.pushTile(kind, dir, region, regions);
equal([push(null, 'left'), push('full', 'left')], [{kind: 'left', region: 0}, {kind: 'left', region: 0}],
    'Super+Left snaps a normal or full window left');
equal(push('right', 'left'), {restore: true}, 'Super+Left from the right half restores');
equal([push('top-right', 'left'), push('bottom-right', 'left')],
    [{kind: 'top-left', region: 0}, {kind: 'bottom-left', region: 0}], 'right quarters cross to the left');
equal(push('left', 'left', 1), {kind: 'right', region: 0}, 'left half hops to previous region');
equal(push('top-left', 'left', 1), {kind: 'top-right', region: 0}, 'left quarter hops to previous region');
equal(push('left', 'left', 0), null, 'no hop past the first region');
equal(push('right', 'right', 0), {kind: 'left', region: 1}, 'right half hops to next region');
equal(push('right', 'right', 1), null, 'no hop past the last region');
equal(push('left', 'right'), {restore: true}, 'Super+Right from the left half restores');
equal(push('left', 'right', 0, [0]), {restore: true}, 'single region still restores');
equal([push('left', 'up'), push('right', 'up')], [{kind: 'top-left', region: 0}, {kind: 'top-right', region: 0}],
    'Super+Up turns a half into its top quarter');
equal(push('bottom-left', 'up'), {kind: 'left', region: 0}, 'Super+Up from bottom quarter is the half');
equal(push(null, 'up'), {kind: 'full', region: 0}, 'Super+Up fills the region');
equal([push('full', 'up'), push('top-left', 'up')], [null, null], 'Super+Up at top does nothing');
equal(push('full', 'down'), {restore: true}, 'Super+Down from full restores');
equal(push('right', 'down'), {kind: 'bottom-right', region: 0}, 'Super+Down turns a half into its bottom quarter');
equal(push('top-right', 'down'), {kind: 'right', region: 0}, 'Super+Down from top quarter is the half');
equal([push(null, 'down'), push('bottom-left', 'down')], [null, null], 'Super+Down at bottom does nothing');
const tracker = new C.EdgeTracker();
const edge = C.edgeCandidate(dual, 1819, -500);
equal(tracker.update(edge, 0, 250), null, 'start dwell');
equal(tracker.update(edge, 249, 250), null, 'no premature snap');
equal(tracker.update(edge, 250, 250).kind, 'right', 'dwell armed');
equal(tracker.update(null, 260, 250), null, 'leaving cancels');
equal(tracker.update(edge, 300, 250), null, 'return restarts dwell');
equal(tracker.update(C.edgeCandidate(dual, 1820, -500), 550, 250), null, 'crossing resets side');
equal(tracker.update(C.edgeCandidate(dual, -100, -500), 551, 250).kind, 'left', 'outer edge immediate');
const state = new C.WindowState();
const original = {x: 50, y: -900, width: 700, height: 500};
equal(state.maximize(original, 'DP-1', 0).type, 'apply', 'maximize fills');
state.assign({x: 0, y: 0, width: 1, height: 1}, 'DP-1', 1, 'right');
equal(state.placement.original, original, 'resnap preserves original');
equal(state.maximize(original, 'DP-1', 1).type, 'apply', 'maximize snapped half fills region');
state.suspend();
equal(state.placement.suspended, true, 'fullscreen suspends');
equal(state.resume().region, 1, 'fullscreen exit remembers region');
equal(state.resume(), null, 'duplicate fullscreen exit ignored');
equal(state.maximize(original, 'DP-1', 1), {type: 'restore', rect: original}, 'second maximize restores');
equal(state.placement, null, 'restored state cleared');
state.assign(original, 'DP-1', 0);
equal(state.release(), original, 'manual release');
equal(C.clampRect({x: -900, y: 900, width: 1600, height: 900}, {x: 0, y: 30, width: 1280, height: 690}),
    {x: 0, y: 30, width: 1280, height: 690}, 'restore on smaller remaining screen');
print(`Core: ${count} assertions passed`);
