// A deterministic desktop and event loop for exercising a built extension's adapter.
// Callers put the build directory first on imports.searchPath.
'use strict';
const GLibReal = imports.gi.GLib;
const ByteArray = imports.byteArray;
let assertions = 0;
function count() { return assertions; }
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

const VARIANTS = {
    base: {uuid: 'split-screen@brohd11', name: 'Split Screen', className: 'SplitScreen'},
    ar: {uuid: 'split-screen-ar@brohd11', name: 'Split Screen for AR Glasses', className: 'ArSplitScreen'},
};

function desktop(variant = 'ar') {
    const Core = imports.core;
    const directory = imports.searchPath[0];
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
        constructor() { this.options = {}; }
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
    // Evaluate modules the way Cinnamon's require() does: one flat directory.
    const load = (file, name) => {
        const source = ByteArray.toString(GLibReal.file_get_contents(`${directory}/${file}`)[1]);
        return new Function('imports', 'global', 'require', `${source}\nreturn {${name}};`)(mocks, globalMock, require);
    };
    const require = path => ({'./core': () => Core, './layouts': () => imports.layouts,
        './base': () => load('base.js', 'SplitScreen')})[path]();
    // Another instance on this desktop, as if a second variant were enabled.
    const create = () => {
        const {uuid, name, className} = VARIANTS[variant];
        return new (load('extension.js', className)[className])({uuid, name});
    };
    const extension = create();
    function begin(window, op = Meta.GrabOp.MOVING) { display.emit('grab-op-begin', display, window, op); }
    function end(window) { display.emit('grab-op-end', display, window, Meta.GrabOp.MOVING); advance(); }
    return {extension, create, Window, global: globalMock, advance, begin, end, Meta, display, wm, stage, layoutManager,
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
