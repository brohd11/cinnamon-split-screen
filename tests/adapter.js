// Exercise the actual Cinnamon adapter with a deterministic desktop and event loop.
'use strict';
const GLibReal = imports.gi.GLib;
const ByteArray = imports.byteArray;
imports.searchPath.unshift(ARGV[0]);
const Core = imports.core;
const source = ByteArray.toString(GLibReal.file_get_contents(`${ARGV[0]}/extension.js`)[1]);
let assertions = 0;
function equal(actual, expected, description) {
    assertions++;
    if (JSON.stringify(actual) !== JSON.stringify(expected))
        throw new Error(`${description}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function check(value, description) { equal(Boolean(value), true, description); }

class Signals {
    constructor() { this.handlers = new Map(); this.sequence = 0; }
    connect(name, callback) { const id = ++this.sequence; this.handlers.set(id, {name, callback}); return id; }
    disconnect(id) { this.handlers.delete(id); }
    emit(name, ...args) {
        for (const h of Array.from(this.handlers.values())) if (h.name === name) h.callback(this, ...args);
    }
}

function desktop() {
    let now = 0, sequence = 0;
    const tasks = new Map();
    const schedule = (fn, delay = 0) => { const id = ++sequence; tasks.set(id, {fn, due: now + delay}); return id; };
    function advance(ms = 0) {
        const until = now + ms;
        for (let i = 0; ; i++) {
            if (i > 2000) throw new Error('Event loop did not settle');
            const next = Array.from(tasks).filter(([, t]) => t.due <= until).sort((a, b) => a[1].due - b[1].due || a[0] - b[0])[0];
            if (!next) break;
            const [id, task] = next;
            tasks.delete(id); now = task.due; task.fn();
        }
        now = until;
    }
    const display = new Signals(), wm = new Signals(), workspaceManager = new Signals(), stage = new Signals();
    const layoutManager = new Signals();
    let screens = [
        {key: 'eDP-1', name: 'Laptop', bounds: {x: 0, y: 1080, width: 1920, height: 1080}},
        {key: 'DP-1', name: 'XREAL Air', bounds: {x: 0, y: 0, width: 3840, height: 1080}},
    ];
    const work = index => { const r = Core.copyRect(screens[index].bounds); r.y += 30; r.height -= 30; return r; };
    const windows = [], errors = [];
    let pointer = [500, 500, 0], preview = null, nativeHides = 0;
    let wayland = false;
    // Persisted across enable/disable within one desktop, like real settings.
    const stored = {'restore-edge-tiling': false}, handlers = new Map();
    let edgeTiling = true;
    const Meta = {WindowType: {NORMAL: 0, DIALOG: 1}, MaximizeFlags: {BOTH: 3},
        SizeChange: {MAXIMIZE: 0, UNMAXIMIZE: 1, FULLSCREEN: 2, UNFULLSCREEN: 3, TILE: 4},
        GrabOp: {MOVING: 1, KEYBOARD_MOVING: 257, RESIZING_E: 8193, RESIZING_W: 4097, RESIZING_S: 16385,
            RESIZING_N: 32769, RESIZING_NE: 40961, KEYBOARD_RESIZING_UNKNOWN: 769, FRAME_BUTTON: 4},
        is_wayland_compositor: () => wayland,
        MonitorManager: {get: () => ({get_monitor_for_connector: key => screens.findIndex(m => m.key === key)})},
        keybindings_set_custom_handler: (name, fn) => { if (fn) handlers.set(name, fn); else handlers.delete(name); }};
    display.get_n_monitors = () => screens.length;
    display.get_monitor_name = i => screens[i].name;
    display.get_monitor_geometry = i => screens[i].bounds;
    workspaceManager.get_active_workspace = () => ({get_work_area_for_monitor: work});
    const globalMock = {display, window_manager: wm, workspace_manager: workspaceManager, stage,
        get_pointer: () => pointer, get_window_actors: () => windows.map(meta_window => ({meta_window})),
        log: () => {}, logError: error => errors.push(error.message)};
    class Window extends Signals {
        constructor(rect = {x: 200, y: 150, width: 800, height: 600}) {
            super(); this.rect = Core.copyRect(rect); this.nativeRestore = Core.copyRect(rect);
            this.maximized = 0; this.tile_mode = 0; this.fullscreen = false; this.minimum = 0; this.nativeMaximizes = 0;
            this.moves = 0; this.type = 0; this.resizeable = true;
            windows.push(this); display.emit('window-created', this);
        }
        get_window_type() { return this.type; }
        is_override_redirect() { return false; }
        allows_move() { return true; }
        allows_resize() { return this.resizeable && this.maximized !== 3 && !this.fullscreen; }
        get_frame_rect() { return Core.copyRect(this.rect); }
        get_maximized() { return this.maximized; }
        is_fullscreen() { return this.fullscreen; }
        get_work_area_current_monitor() {
            const i = screens.findIndex(m => Core.contains(m.bounds, this.rect.x + this.rect.width / 2, this.rect.y + this.rect.height / 2));
            return work(i < 0 ? 0 : i);
        }
        move_resize_frame(user, x, y, width, height) {
            this.moves++; this.userOp = user;
            // Like terminal size hints: round down to whole cells, keep the position.
            const inc = this.increment || {width: 1, height: 1};
            this.rect = {x, y, width: Math.max(width - width % inc.width, this.minimum),
                height: height - height % inc.height};
            this.emit('position-changed'); this.emit('size-changed');
        }
        move_frame(user, x, y) {
            this.userOp = user; this.rect = {...this.rect, x, y};
            this.emit('position-changed');
        }
        maximize() {
            const old = this.get_frame_rect(); this.nativeRestore = old; this.nativeMaximizes++;
            // Muffin sets flags and emits notify before its size-change signal,
            // then updates the geometry. Match this ordering, not a DOM resize.
            this.maximized = 3;
            this.emit('notify::maximized-horizontally'); this.emit('notify::maximized-vertically');
            wm.emit('size-change', {meta_window: this}, Meta.SizeChange.MAXIMIZE, old, old);
            this.rect = this.get_work_area_current_monitor();
            this.emit('size-changed');
        }
        unmaximize() {
            if (this.maximized) {
                wm.emit('size-change', {meta_window: this}, Meta.SizeChange.UNMAXIMIZE, this.get_frame_rect());
                this.maximized = 0; this.tile_mode = 0;
                this.rect = Core.copyRect(this.nativeRestore);
                this.emit('size-changed');
            }
            this.emit('notify::maximized-horizontally'); this.emit('notify::maximized-vertically');
        }
        fullscreenTo(value) {
            this.fullscreen = value;
            this.emit('notify::fullscreen');
            if (value) { this.beforeFullscreen = this.get_frame_rect(); this.rect = Core.copyRect(screens[1].bounds); }
            else this.rect = this.beforeFullscreen;
        }
        destroy() { this.emit('unmanaged'); windows.splice(windows.indexOf(this), 1); }
    }
    class FakeSettings {
        constructor() { this.options = {monitor: {'Automatically detect XREAL': 'auto'}}; }
        bind(key, prop, callback) {
            extension[prop] = {'monitor': 'auto', 'layout-32': 'dual', 'internal-edges': true, 'dwell-ms': 250}[key];
            this.callback = callback;
        }
        getOptions(key) { return this.options[key]; }
        getValue(key) { return stored[key]; }
        setValue(key, value) { stored[key] = value; }
        setOptions(key, value) { this.options[key] = value; }
        finalize() { this.finalized = true; }
    }
    const systemBus = {signal_subscribe: () => 1, signal_unsubscribe: () => {}};
    let dbusError = false;
    const sessionBus = {
        call: (...args) => schedule(() => args[9](sessionBus, {})),
        call_finish: () => {
            if (dbusError) throw new Error('Unavailable');
            return {deep_unpack: () => [1, screens.map(m => [[m.key, 'X', m.name, '123'], [], {'display-name': m.name}])]};
        },
    };
    const Main = {layoutManager, animations_enabled: true,
        wm: {_hideTilePreview: () => { nativeHides++; }, TILE_PREVIEW_ANIMATION_TIME: 150, window_effect_multiplier: 1},
        uiGroup: {add_child: actor => { preview = actor; }}};
    const mocks = {gi: {Meta, GLib: {SOURCE_REMOVE: false, get_monotonic_time: () => now * 1000},
        Gio: {DBus: {session: sessionBus, system: systemBus}, DBusCallFlags: {NONE: 0}, DBusSignalFlags: {NONE: 0},
            Cancellable: class { cancel() {} },
            SettingsSchemaSource: {get_default: () => ({lookup: id => id === 'org.cinnamon.muffin' ? {} : null})},
            Settings: class { get_boolean() { return edgeTiling; } set_boolean(_key, value) { edgeTiling = value; } }},
        Clutter: {EventType: {KEY_PRESS: 1}, KEY_Escape: 27, EVENT_PROPAGATE: false, ModifierType: {MOD1_MASK: 8},
            AnimationMode: {EASE_OUT_QUAD: 3}},
        St: {Widget: class { constructor() { this.visible = false; } set_position(x, y) { this.x = x; this.y = y; }
            set_size(width, height) { this.width = width; this.height = height; }
            show() { this.visible = true; } hide() { this.visible = false; } destroy() { this.destroyed = true; }
            remove_all_transitions() {}
            ease({duration, mode, onComplete, ...props}) { this.eased = (this.eased || 0) + 1; Object.assign(this, props); if (onComplete) onComplete(); }}}},
        ui: {main: Main, settings: {ExtensionSettings: FakeSettings}},
        mainloop: {idle_add: fn => schedule(fn), timeout_add: (ms, fn) => schedule(fn, ms), source_remove: id => tasks.delete(id)}};
    const Constructor = new Function('imports', 'global', 'require', `${source}\nreturn SplitScreen;`)(mocks, globalMock, () => Core);
    const extension = new Constructor({uuid: 'split-screen@brohd11'});
    function begin(window, op = Meta.GrabOp.MOVING) { display.emit('grab-op-begin', display, window, op); }
    function end(window) { display.emit('grab-op-end', display, window, Meta.GrabOp.MOVING); advance(); }
    return {extension, Window, advance, begin, end, Meta, display, wm, stage, layoutManager,
        pointer: (x, y, mask = 0) => { pointer = [x, y, mask]; }, screens: () => screens,
        setScreens: s => { screens = s; layoutManager.emit('monitors-changed'); },
        dbusFail: () => { dbusError = true; }, wayland: () => { wayland = true; },
        preview: () => preview, nativeHides: () => nativeHides,
        edgeTiling: () => edgeTiling, setEdgeTiling: value => { edgeTiling = value; }, stored, handlers,
        push: (dir, window) => handlers.get(`push-tile-${dir}`)(display, window, null),
        start: () => { extension.enable(); advance(); },
        finish: () => {
            extension.disable(); advance(3000);
            equal(errors, [], 'adapter logged no errors');
            equal(tasks.size, 0, 'no remaining timer or polling');
            for (const object of [display, wm, stage, layoutManager]) equal(object.handlers.size, 0, 'signals disconnected');
        }};
}

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
print(`Adapter: ${assertions} assertions passed`);
