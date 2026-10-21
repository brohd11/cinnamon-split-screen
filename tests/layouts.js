'use strict';
imports.searchPath.unshift(ARGV[0]);
const L = imports.layouts;
let count = 0;
function equal(actual, expected, message) {
    count++;
    if (JSON.stringify(actual) !== JSON.stringify(expected))
        throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
const bounds = {x: -100, y: -1080, width: 3840, height: 1080};
const area = {x: -100, y: -1050, width: 3840, height: 1050};
const dual = L.regionsFor(bounds, area);
equal(dual.map(r => r.bounds.width), [1920, 1920], 'dual widths');
equal(dual[1].area, {x: 1820, y: -1050, width: 1920, height: 1050}, 'panel exclusion, negative origin');
equal(L.regionsFor({...bounds, width: 3841}, {...area, width: 3841}).map(r => r.bounds.width),
    [1920, 1921], 'odd pixel goes right');
equal(L.regionsFor({...bounds, width: 3843}, {...area, width: 3843}, 'triple').map(r => r.bounds.width),
    [960, 1923, 960], 'triple remainder goes center');
equal(L.regionsFor({...bounds, width: 2560}, {...area, width: 2560}).map(r => r.bounds.width),
    [1920, 640], '21:9 strip');
equal(L.regionsFor({x: 0, y: 0, width: 2560, height: 720}, {x: 0, y: 20, width: 2560, height: 700})
    .map(r => r.area.width), [1280, 1280], 'logical scale');
equal(L.regionsFor({...bounds, width: 1920}, area), [], '16:9 inactive');
equal(L.regionsFor({...bounds, width: 2560, height: 1440}, area), [], 'ordinary 16:9 inactive');
equal(L.regionsFor({...bounds, height: 0}, area), [], 'transient empty geometry');
print(`Layouts: ${count} assertions passed`);
