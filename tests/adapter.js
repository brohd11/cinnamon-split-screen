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
    const Meta = {WindowType: {NORMAL: 0, DIALOG: 1}, MaximizeFlags: {BOTH: 3},
        SizeChange: {MAXIMIZE: 0, UNMAXIMIZE: 1, FULLSCREEN: 2, UNFULLSCREEN: 3, TILE: 4},
        GrabOp: {MOVING: 1, KEYBOARD_MOVING: 257, RESIZING_E: 8193, FRAME_BUTTON: 4},
        is_wayland_compositor: () => wayland,
        MonitorManager: {get: () => ({get_monitor_for_connector: key => screens.findIndex(m => m.key === key)})}};
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
            this.maximized = 0; this.tile_mode = 0; this.fullscreen = false; this.minimum = 0;
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
        move_resize_frame(_user, x, y, width, height) {
            this.moves++;
            this.rect = {x, y, width: Math.max(width, this.minimum), height};
            this.emit('position-changed'); this.emit('size-changed');
        }
        maximize() {
            const old = this.get_frame_rect(); this.nativeRestore = old;
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
    const Main = {layoutManager, wm: {_hideTilePreview: () => { nativeHides++; }},
        uiGroup: {add_child: actor => { preview = actor; }}};
    const mocks = {gi: {Meta, GLib: {SOURCE_REMOVE: false, get_monotonic_time: () => now * 1000},
        Gio: {DBus: {session: sessionBus, system: systemBus}, DBusCallFlags: {NONE: 0}, DBusSignalFlags: {NONE: 0},
            Cancellable: class { cancel() {} }},
        Clutter: {EventType: {KEY_PRESS: 1}, KEY_Escape: 27, EVENT_PROPAGATE: false},
        St: {Widget: class { constructor() { this.visible = false; } set_position(x, y) { this.x = x; this.y = y; }
            set_size(width, height) { this.width = width; this.height = height; }
            show() { this.visible = true; } hide() { this.visible = false; } destroy() { this.destroyed = true; }}}},
        ui: {main: Main, settings: {ExtensionSettings: FakeSettings}},
        mainloop: {idle_add: fn => schedule(fn), timeout_add: (ms, fn) => schedule(fn, ms), source_remove: id => tasks.delete(id)}};
    const Constructor = new Function('imports', 'global', 'require', `${source}\nreturn VScreen;`)(mocks, globalMock, () => Core);
    const extension = new Constructor({uuid: 'vscreen@brohd'});
    function begin(window, op = Meta.GrabOp.MOVING) { display.emit('grab-op-begin', display, window, op); }
    function end(window) { display.emit('grab-op-end', display, window, Meta.GrabOp.MOVING); advance(); }
    return {extension, Window, advance, begin, end, Meta, display, wm, stage, layoutManager,
        pointer: (x, y) => { pointer = [x, y, 0]; }, screens: () => screens,
        setScreens: s => { screens = s; layoutManager.emit('monitors-changed'); },
        dbusFail: () => { dbusError = true; }, wayland: () => { wayland = true; },
        preview: () => preview, nativeHides: () => nativeHides,
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
    equal(d.extension.monitors.length, 1, 'XREAL auto-detected');
    check(Object.values(d.extension.settings.getOptions('monitor')).includes('connector:eDP-1'), 'manual display selector populated');
    const w = new d.Window(), original = w.get_frame_rect();
    w.maximize(); d.advance(200);
    equal(w.rect, {x: 0, y: 30, width: 1920, height: 1050}, 'native maximize intercepted once despite two notify signals');
    equal(w.get_maximized(), 0, 'native maximize constraints removed');
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
    d.pointer(100, 300); d.begin(w); d.advance(); d.pointer(1921, 2); d.advance(16); d.end(w); d.advance(200);
    equal(w.rect, {x: 1920, y: 30, width: 1920, height: 1050}, 'top drag fills region with priority over side');
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
    equal(d.extension.monitors.length, 1, 'monitor name fallback when DisplayConfig unavailable');
    d.finish();
    d.start(); equal(d.extension.monitors.length, 1, 'enable after disable'); d.finish();
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
    d.pointer(100, 100); d.begin(w); d.pointer(1930, 1);
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
    const d = desktop(); d.wayland();
    let refused = false;
    try { d.start(); } catch (error) { refused = error.message.includes('X11'); }
    check(refused, 'Wayland explicitly unsupported'); d.finish();
}
print(`Adapter: ${assertions} assertions passed`);
