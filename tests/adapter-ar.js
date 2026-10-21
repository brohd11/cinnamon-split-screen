// Exercise the AR glasses build: XREAL detection, layouts, and multi-region tiling.
'use strict';
imports.searchPath.unshift(ARGV[0]);
imports.searchPath.push(imports.gi.GLib.path_get_dirname(imports.system.programPath));
const {desktop, equal, check, count} = imports.desktop;

{
    const d = desktop(); d.start();
    equal(d.extension.monitors.filter(m => !m.plain).length, 1, 'XREAL auto-detected');
    check(Object.values(d.extension.settings.getOptions('monitor')).includes('connector:eDP-1'), 'manual display selector populated');
    const w = new d.Window(), original = w.get_frame_rect();
    w.maximize(); d.advance(200);
    equal(w.rect, {x: 0, y: 30, width: 1920, height: 1050}, 'native maximize intercepted once despite two notify signals');
    equal(w.get_maximized(), 0, 'native maximize constraints removed');
    equal(w.userOp, false, 'placement is not a user op, so resize increments keep position');
    w.maximize(); d.advance(200);
    equal(w.rect, original, 'second native maximize restores original');
    const laptop = new d.Window({x: 100, y: 1200, width: 600, height: 500});
    laptop.maximize(); d.advance(200);
    equal(laptop.get_maximized(), 3, 'laptop maximize unaffected');
    const fixed = new d.Window(); fixed.resizeable = false;
    fixed.maximize(); d.advance(200);
    equal(d.extension.windows.get(fixed).state.placement, null, 'non-resizable window excluded');
    w.maximize(); d.advance(200);
    w.fullscreenTo(true); d.advance(200);
    equal(w.rect.width, 3840, 'fullscreen spans display');
    w.fullscreenTo(false); d.advance(200);
    equal(w.rect.width, 1920, 'fullscreen exit restores region');
    d.finish();
    equal(w.rect, original, 'disable restores managed window');
    equal(laptop.get_maximized(), 3, 'disable does not alter unmanaged laptop window');
}
{
    const d = desktop(); d.start(); const w = new d.Window();
    d.pointer(1800, 300); d.begin(w); d.advance();
    d.pointer(1915, 500); d.advance(16);
    check(!d.preview() || !d.preview().visible, 'no preview before dwell');
    d.advance(256);
    check(d.preview().visible, 'preview after dwell');
    equal(d.preview().width, 960, 'preview half region');
    d.end(w); d.advance(200);
    equal(w.rect, {x: 960, y: 30, width: 960, height: 1050}, 'internal edge right half of left region');
    d.pointer(2000, 500); d.begin(w); d.advance();
    d.pointer(1921, 500); d.advance(272); d.end(w); d.advance(200);
    equal(w.rect, {x: 1920, y: 30, width: 960, height: 1050}, 'internal edge left half of right region');
    d.pointer(2000, 500); d.begin(w); d.advance();
    d.pointer(1921, 500); d.advance(32); d.pointer(2000, 500); d.advance(32); d.end(w); d.advance(200);
    equal(d.extension.windows.get(w).state.placement, null, 'crossing without dwell does not snap');
    d.pointer(100, 300); d.begin(w); d.advance(); d.pointer(10, 500); d.advance(16); d.end(w); d.advance(200);
    equal(w.rect.width, 960, 'outer edge fills half region');
    d.pointer(100, 300); d.begin(w); d.advance(); d.pointer(2800, 2); d.advance(16); d.end(w); d.advance(200);
    equal(w.rect, {x: 1920, y: 30, width: 1920, height: 1050}, 'top drag fills region');
    check(d.nativeHides() > 0, 'native preview hidden for managed drag');
    const previous = w.get_frame_rect();
    d.begin(w); d.advance();
    d.stage.emit('captured-event', {type: () => 1, get_key_symbol: () => 27});
    d.end(w); d.advance(200);
    equal(w.rect, previous, 'Escape restores pre-drag placement');
    d.finish(); check(d.preview().destroyed, 'preview destroyed on disable');
}
{
    const d = desktop(); d.start(); const w = new d.Window();
    w.maximize(); d.advance(200);
    const beforeClick = w.get_frame_rect();
    d.begin(w); d.advance(100); d.end(w);
    equal(w.rect, beforeClick, 'titlebar click preserves region size');
    check(d.extension.windows.get(w).state.placement, 'titlebar click preserves restore state');
    d.begin(w, d.Meta.GrabOp.FRAME_BUTTON);
    check(d.extension.windows.get(w).state.placement, 'titlebar button grab does not release placement');
    d.begin(w, d.Meta.GrabOp.RESIZING_E); d.advance();
    w.move_resize_frame(true, w.rect.x, w.rect.y, w.rect.width - 100, w.rect.height);
    d.end(w);
    equal(d.extension.windows.get(w).state.placement, null, 'manual resize releases placement');
    w.minimum = 2300; w.maximize(); d.advance(500);
    equal(d.extension.windows.get(w).state.placement, null, 'minimum-size refusal releases placement');
    const moves = w.moves; d.advance(3000); equal(w.moves, moves, 'no repeated forced resizing');
    w.destroy(); d.finish(); equal(w.handlers.size, 0, 'window signals disconnected at destruction');
}
{
    const d = desktop(); d.start(); const w = new d.Window();
    w.maximize(); d.advance(200);
    d.extension.layout32 = 'triple'; d.extension._scheduleRefresh(); d.advance(1500); d.advance(200);
    equal(w.rect.width, 960, 'layout change reflows assigned region');
    const shifted = d.screens().map(s => ({...s, bounds: {...s.bounds, x: s.bounds.x + 100}}));
    d.setScreens(shifted); d.advance(1500); d.advance(200);
    equal(w.rect.x, 100, 'position-only monitor change reflows');
    d.setScreens([{key: 'eDP-1', name: 'Laptop', bounds: {x: 0, y: 0, width: 1920, height: 1080}}]);
    d.advance(1500); d.advance(200);
    equal(d.extension.windows.get(w).state.placement, null, 'disconnect releases placement');
    check(w.rect.x >= 0 && w.rect.y >= 30, 'disconnect restores onto remaining monitor');
    d.finish();
}
{
    const d = desktop(); d.start(); const w = new d.Window();
    d.pointer(1915, 500); d.begin(w); d.advance(272);
    d.setScreens(d.screens()); d.end(w); d.advance(2000);
    equal(d.extension.windows.get(w).state.placement, null, 'topology change cancels stale drag target');
    w.maximize(); // Display change before queued maximize must cancel it.
    d.setScreens(d.screens()); d.advance(2000);
    equal(d.extension.windows.get(w).state.placement, null, 'stale queued maximize ignored');
    d.finish();
}
{
    const d = desktop(); d.dbusFail(); d.start();
    equal(d.extension.monitors.filter(m => !m.plain).length, 1, 'monitor name fallback when DisplayConfig unavailable');
    d.finish();
    d.start(); equal(d.extension.monitors.filter(m => !m.plain).length, 1, 'enable after disable'); d.finish();
}
{
    const d = desktop(); d.start(); const w = new d.Window();
    w.maximize(); d.advance(200);
    // Desktop move-to-monitor shortcuts do not necessarily start a drag grab.
    w.move_resize_frame(true, 100, 1200, 800, 600); w.emit('monitor-changed', 0);
    equal(d.extension.windows.get(w).state.placement, null, 'move-to-monitor shortcut releases placement');
    w.maximize(); d.advance(200);
    equal(w.get_maximized(), 3, 'next maximize uses current monitor, not stale restore coordinates');
    d.extension._scheduleRefresh(); d.advance(2000);
    check(w.rect.y >= 1080, 'refresh does not pull the window back to glasses');
    d.finish();
}
{
    const d = desktop(); d.start(); const w = new d.Window();
    w.maximize(); d.advance(200);
    d.pointer(100, 100); d.begin(w); d.pointer(2800, 1);
    d.end(w); d.advance(200); // Drop before the first polling interval.
    equal(w.rect, {x: 1920, y: 30, width: 1920, height: 1050}, 'fast drop survives the restore recursion guard');
    d.pointer(2000, 100); d.begin(w); d.pointer(3839, 500); d.advance(16);
    w.tile_mode = 2; w.maximized = 2; // Cinnamon commits its native side tile before grab-op-end.
    d.wm.emit('size-change', {meta_window: w}, d.Meta.SizeChange.TILE, w.get_frame_rect());
    d.end(w); d.advance(200);
    equal(w.tile_mode, 0, 'native tile constraint cleared after drop');
    equal(w.rect, {x: 2880, y: 30, width: 960, height: 1050}, 'native side tile replaced by half-region target');
    d.finish();
}
{
    const ALT = 8;
    const d = desktop(); d.start(); const w = new d.Window();
    d.pointer(500, 300); d.begin(w); d.advance();
    d.pointer(960, 500); d.advance(16);
    check(!d.preview() || !d.preview().visible, 'interior drag without Alt shows no preview');
    d.pointer(960, 500, ALT); d.advance(16);
    check(d.preview().visible, 'Alt shows preview without reaching an edge');
    check(d.preview().eased > 0 && d.preview().opacity === 255, 'preview animates in');
    equal(d.preview().width, 1920, 'Alt centre previews whole region');
    d.pointer(100, 100, ALT); d.advance(16);
    equal([d.preview().width, d.preview().height], [960, 525], 'Alt corner previews quarter');
    d.end(w); d.advance(200);
    equal(w.rect, {x: 0, y: 30, width: 960, height: 525}, 'Alt drop snaps quarter');
    check(!d.preview().visible && d.preview().opacity === 0, 'preview fades out on drop');
    equal(d.extension.windows.get(w).state.placement.kind, 'top-left', 'Alt quarter is a managed placement');
    d.pointer(100, 100); d.begin(w); d.advance();
    d.pointer(1800, 1700, ALT); d.advance(16); d.end(w); d.advance(200);
    equal(w.rect, {x: 960, y: 1110, width: 960, height: 1050}, 'Alt snaps on an ordinary monitor');
    equal(d.extension.windows.get(w).state.placement.kind, 'right', 'ordinary monitor Alt snap is a managed tile');
    d.pointer(1800, 1700); d.begin(w); d.advance();
    d.pointer(960, 1600, ALT); d.advance(16); d.end(w); d.advance(200);
    equal(w.get_maximized(), 3, 'Alt centre on ordinary monitor natively maximizes');
    d.finish();
}
{
    const ALT = 8;
    const d = desktop(); d.start();
    const snap = (w, x, y, mask = ALT) => {
        d.pointer(w.rect.x + 10, w.rect.y + 10); d.begin(w); d.advance();
        d.pointer(x, y, mask); d.advance(16); d.end(w); d.advance(200);
    };
    const a = new d.Window(), b = new d.Window({x: 1000, y: 150, width: 800, height: 600});
    snap(a, 100, 500); snap(b, 1800, 500);
    equal([a.rect.width, b.rect.x, b.rect.width], [960, 960, 960], 'side-by-side halves');
    d.begin(a, d.Meta.GrabOp.RESIZING_E); d.advance();
    a.move_resize_frame(true, 0, 30, 1344, 1050); d.advance(16);
    equal([b.rect.x, b.rect.width], [1344, 576], 'dragging the shared edge resizes the neighbour live');
    d.end(a); d.advance(200);
    equal(a.rect, {x: 0, y: 30, width: 1344, height: 1050}, 'resized tile settles on the divider');
    equal(d.extension.windows.get(a).state.placement.kind, 'left', 'divider resize keeps the placement');
    const c = new d.Window({x: 400, y: 150, width: 500, height: 400});
    snap(c, 1800, 900);
    equal(c.rect, {x: 1344, y: 555, width: 576, height: 525}, 'new quarter fills the off-size slot');
    d.begin(c, d.Meta.GrabOp.RESIZING_N); d.advance();
    c.move_resize_frame(true, 1344, 765, 576, 315); d.end(c); d.advance(200);
    equal(c.rect, {x: 1344, y: 765, width: 576, height: 315}, 'quarter height divider moves');
    equal(b.rect.height, 1050, 'half ignores the quarter height divider');
    d.begin(b, d.Meta.GrabOp.RESIZING_W); d.advance();
    b.move_resize_frame(true, 1500, 30, 420, 1050); d.advance(16);
    equal(c.rect.x, 1500, 'neighbour quarter follows before Escape');
    d.stage.emit('captured-event', {type: () => 1, get_key_symbol: () => 27});
    b.move_resize_frame(true, 1344, 30, 576, 1050); // Muffin reverts the cancelled resize.
    d.end(b); d.advance(200);
    equal([b.rect.x, c.rect.x], [1344, 1344], 'Escape restores the divider');
    d.begin(a, d.Meta.GrabOp.RESIZING_W); d.advance();
    a.move_resize_frame(true, 100, 30, 1244, 1050); d.end(a); d.advance(200);
    equal(d.extension.windows.get(a).state.placement, null, 'outer edge resize releases the tile');
    equal(b.rect.x, 1344, 'releasing one tile keeps the divider for the others');
    snap(b, 900, 500, 0); snap(c, 900, 500, 0);
    const e = new d.Window({x: 300, y: 300, width: 500, height: 400});
    snap(e, 100, 500);
    equal(e.rect.width, 960, 'divider resets once the region is empty');
    const l1 = new d.Window({x: 100, y: 1200, width: 600, height: 500});
    const l2 = new d.Window({x: 900, y: 1200, width: 600, height: 500});
    snap(l1, 100, 1600); snap(l2, 1800, 1600);
    d.begin(l1, d.Meta.GrabOp.RESIZING_E); d.advance();
    l1.move_resize_frame(true, 0, 1110, 1152, 1050); d.end(l1); d.advance(200);
    equal([l2.rect.x, l2.rect.width], [1152, 768], 'ordinary monitor tiles link too');
    d.finish();
}
{
    const d = desktop(); d.start();
    equal(d.edgeTiling(), false, 'enable turns off native edge tiling');
    equal(d.stored['restore-edge-tiling'], true, 'enable remembers to restore edge tiling');
    equal(d.handlers.size, 4, 'Super+arrow tile shortcuts taken over');
    const w = new d.Window(), original = w.get_frame_rect();
    const push = dir => { d.push(dir, w); d.advance(200); };
    push('up');
    equal(w.rect, {x: 0, y: 30, width: 1920, height: 1050}, 'Super+Up fills the region');
    equal(w.nativeMaximizes, 0, 'Super+Up skips native maximize, so no flash');
    push('down'); equal(w.rect, original, 'Super+Down from full restores');
    push('left'); equal(w.rect, {x: 0, y: 30, width: 960, height: 1050}, 'Super+Left snaps the left half');
    push('up'); equal(w.rect, {x: 0, y: 30, width: 960, height: 525}, 'Super+Up makes the top quarter');
    push('down'); equal(w.rect.height, 1050, 'Super+Down returns to the half');
    push('right'); equal(w.rect, original, 'Super+Right from the left half restores');
    push('right'); equal(w.rect.x, 960, 'Super+Right snaps the right half');
    push('right'); equal(w.rect, {x: 1920, y: 30, width: 960, height: 1050}, 'Super+Right hops into the next region');
    push('left'); equal(w.rect, {x: 960, y: 30, width: 960, height: 1050}, 'Super+Left hops back to the previous region');
    const r = new d.Window({x: 2400, y: 150, width: 800, height: 600});
    d.push('right', r); d.advance(200); d.push('right', r); d.advance(200);
    equal(r.rect, {x: 2880, y: 30, width: 960, height: 1050}, 'no hop past the last region');
    const l = new d.Window({x: 100, y: 1200, width: 600, height: 500});
    d.push('up', l); d.advance(200);
    equal(l.get_maximized(), 3, 'Super+Up natively maximizes on the laptop');
    d.push('left', l); d.advance(200);
    equal([l.rect, l.get_maximized()], [{x: 0, y: 1110, width: 960, height: 1050}, 0],
        'Super+Left from a native maximize tiles the laptop half');
    d.push('right', l); d.advance(200);
    equal(l.rect, {x: 100, y: 1200, width: 600, height: 500}, 'laptop tile restores its pre-maximize size');
    const m = new d.Window({x: 300, y: 1300, width: 600, height: 500});
    const drag = (x, y) => { d.pointer(m.rect.x + 10, m.rect.y + 10); d.begin(m); d.advance(); d.pointer(x, y); d.advance(16); d.end(m); d.advance(200); };
    drag(2, 1500); equal(m.rect, {x: 0, y: 1110, width: 960, height: 1050}, 'laptop edge drag is a managed half');
    equal(d.extension.windows.get(m).state.placement.kind, 'left', 'laptop edge tile is managed');
    drag(2, 1115); equal(m.rect, {x: 0, y: 1110, width: 960, height: 525}, 'laptop corner drag is a quarter');
    drag(900, 1081); equal(m.get_maximized(), 3, 'laptop top edge natively maximizes');
    d.finish();
    equal(d.edgeTiling(), true, 'disable restores native edge tiling');
    equal(d.stored['restore-edge-tiling'], false, 'restore flag cleared');
    equal(d.handlers.size, 0, 'disable releases the tile shortcuts');
}
{
    const d = desktop(); d.start();
    const term = rect => { const w = new d.Window(rect); w.increment = {width: 8, height: 17}; return w; };
    const top = term({x: 100, y: 100, width: 500, height: 400});
    const bottom = term({x: 100, y: 600, width: 500, height: 400});
    d.push('left', top); d.advance(200); d.push('up', top); d.advance(200);
    d.push('left', bottom); d.advance(200); d.push('down', bottom); d.advance(200);
    equal(top.rect, {x: 0, y: 37, width: 960, height: 510}, 'cell slack is centred in the top quarter');
    equal(bottom.rect, {x: 0, y: 562, width: 960, height: 510}, 'and in the bottom quarter');
    const moves = top.moves + bottom.moves; d.advance(3000);
    equal(top.moves + bottom.moves, moves, 'centring does not resize again');
    d.finish();
}
{
    const d = desktop(); d.setEdgeTiling(false); d.stored['restore-edge-tiling'] = true;
    d.start(); equal(d.edgeTiling(), false, 'setting held off by a crashed session stays off');
    d.finish(); equal(d.edgeTiling(), true, 'and is restored on disable');
}
{
    const d = desktop(); d.setEdgeTiling(false);
    d.start(); d.finish();
    equal(d.edgeTiling(), false, 'edge tiling the user turned off stays off');
}
{
    const d = desktop(); d.wayland();
    let refused = false;
    try { d.start(); } catch (error) { refused = error.message.includes('X11'); }
    check(refused, 'Wayland explicitly unsupported'); d.finish();
}
print(`AR adapter: ${count()} assertions passed`);
