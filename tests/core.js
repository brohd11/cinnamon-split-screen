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
const dual = C.regionsFor(bounds, area);
equal(dual.map(r => r.bounds.width), [1920, 1920], 'dual widths');
equal(dual[1].area, {x: 1820, y: -1050, width: 1920, height: 1050}, 'panel exclusion, negative origin');
equal(C.regionsFor({...bounds, width: 3841}, {...area, width: 3841}).map(r => r.bounds.width),
    [1920, 1921], 'odd pixel goes right');
equal(C.regionsFor({...bounds, width: 3843}, {...area, width: 3843}, 'triple').map(r => r.bounds.width),
    [960, 1923, 960], 'triple remainder goes center');
equal(C.regionsFor({...bounds, width: 2560}, {...area, width: 2560}).map(r => r.bounds.width),
    [1920, 640], '21:9 strip');
equal(C.regionsFor({x: 0, y: 0, width: 2560, height: 720}, {x: 0, y: 20, width: 2560, height: 700})
    .map(r => r.area.width), [1280, 1280], 'logical scale');
equal(C.regionsFor({...bounds, width: 1920}, area), [], '16:9 inactive');
equal(C.regionsFor({...bounds, width: 2560, height: 1440}, area), [], 'ordinary 16:9 inactive');
equal(C.regionsFor({...bounds, height: 0}, area), [], 'transient empty geometry');
equal(C.regionForWindow(dual, {x: 1800, y: -1000, width: 200, height: 100}).index, 1, 'center selects region');
equal(C.regionAt(dual, 1820, -1000).index, 1, 'boundary belongs to right region');
equal(C.regionAt(dual, 3740, -1000), null, 'right bound exclusive');
equal(C.targetRect(dual[1], 'left'), {x: 1820, y: -1050, width: 960, height: 1050}, 'left half of region');
equal(C.targetRect({area: {x: 0, y: 0, width: 641, height: 1080}}, 'right'),
    {x: 320, y: 0, width: 321, height: 1080}, 'half remainder');
equal(C.edgeCandidate(dual, 1819, -1075).kind, 'full', 'top wins over inner side');
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
