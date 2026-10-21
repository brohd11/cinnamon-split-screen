// Exercise the base build: tiling only, with no display ever split into regions.
'use strict';
imports.searchPath.unshift(ARGV[0]);
imports.searchPath.push(imports.gi.GLib.path_get_dirname(imports.system.programPath));
const {desktop, equal, check, count} = imports.desktop;
const ALT = 8;

{
    const d = desktop('base'); d.start();
    equal(d.extension.monitors.filter(m => !m.plain).length, 0, 'XREAL display is not split');
    equal(d.extension.settings.getOptions('monitor'), undefined, 'no display selector');
    equal(d.extension.monitorChoice, undefined, 'glasses settings are not bound');
    check(d.global.__splitScreenVariant === 'split-screen@brohd11', 'enable claims tiling ownership');
    const w = new d.Window(), original = w.get_frame_rect();
    w.maximize(); d.advance(200);
    equal(w.get_maximized(), 3, 'maximize on an ultrawide stays native');
    w.unmaximize(); d.advance(200);
    equal(w.rect, original, 'native unmaximize restores');
    d.pointer(w.rect.x + 10, w.rect.y + 10); d.begin(w); d.advance();
    d.pointer(3000, 500, ALT); d.advance(16); d.end(w); d.advance(200);
    equal(w.rect, {x: 1920, y: 30, width: 1920, height: 1050}, 'Alt-drag halves the whole ultrawide');
    d.push('up', w); d.advance(200);
    equal(w.rect, {x: 1920, y: 30, width: 1920, height: 525}, 'Super+Up makes the top quarter');
    d.push('right', w); d.advance(200);
    equal(w.rect, {x: 1920, y: 30, width: 1920, height: 525}, 'no region to hop into');
    d.finish();
    equal(d.global.__splitScreenVariant, undefined, 'disable releases tiling ownership');
}
{
    const d = desktop('base'); d.start();
    const other = d.create();
    let refused = false;
    try { other.enable(); } catch (error) { refused = error.message.includes('split-screen@brohd11'); }
    check(refused, 'a second variant refuses to enable');
    other.disable();
    equal(d.global.__splitScreenVariant, 'split-screen@brohd11', 'refused variant leaves ownership alone');
    equal(d.handlers.size, 4, 'running variant keeps its tile shortcuts');
    d.finish();
}
print(`Base adapter: ${count()} assertions passed`);
