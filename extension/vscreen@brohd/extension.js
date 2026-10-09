'use strict';

const {Clutter, Gio, GLib, Meta, St} = imports.gi;
const Main = imports.ui.main;
const Mainloop = imports.mainloop;
const Settings = imports.ui.settings;
const Core = require('./core');

let metadata;
let instance = null;

class VScreen {
    constructor(meta) {
        this.meta = meta;
        this.alive = false;
        this.signals = [];
        this.sources = new Set();
        this.windows = new Map();
        this.monitors = [];
        this.drag = null;
        this.refreshSource = 0;
        this.refreshGeneration = 0;
        this.topologyPending = true;
        this.cancellable = null;
        this.preview = null;
        this.settings = null;
    }

    enable() {
        if (Meta.is_wayland_compositor())
            throw new Error('VScreen 0.1 supports Cinnamon X11 sessions. Wayland has not been validated.');
        this.alive = true;
        this.settings = new Settings.ExtensionSettings(this, this.meta.uuid);
        for (const [key, property] of [['monitor', 'monitorChoice'], ['layout-32', 'layout32'],
            ['internal-edges', 'internalEdges'], ['dwell-ms', 'dwellMs']])
            this.settings.bind(key, property, () => this._scheduleRefresh());

        this._connect(Main.layoutManager, 'monitors-changed', () => this._scheduleRefresh());
        this._connect(global.display, 'workareas-changed', () => this._scheduleRefresh());
        this._connect(global.workspace_manager, 'active-workspace-changed', () => this._scheduleRefresh());
        this._connect(global.display, 'window-created', (_display, window) => this._watch(window));
        // These signals include a Display argument in addition to the emitter.
        this._connect(global.display, 'grab-op-begin', (_emitter, _display, window, op) => this._grabBegin(window, op));
        this._connect(global.display, 'grab-op-end', (_emitter, _display, window) => this._grabEnd(window));
        this._connect(global.window_manager, 'size-change', (_wm, actor, kind, oldRect) =>
            this._sizeChange(actor.meta_window, kind, oldRect));
        this._connect(global.window_manager, 'show-tile-preview', () => {
            if (this.drag && (this.drag.target || this._monitorAt(...global.get_pointer()))) Main.wm._hideTilePreview();
        });
        this._connect(global.stage, 'captured-event', (_stage, event) => {
            if (this.drag && event.type() === Clutter.EventType.KEY_PRESS &&
                event.get_key_symbol() === Clutter.KEY_Escape) this.drag.cancelled = true;
            return Clutter.EVENT_PROPAGATE;
        });
        // Cinnamon also emits monitor changes on resume. Reconcile explicitly
        // after logind wakes in case the display geometry itself did not change.
        this.sleepSubscription = Gio.DBus.system.signal_subscribe('org.freedesktop.login1',
            'org.freedesktop.login1.Manager', 'PrepareForSleep', '/org/freedesktop/login1',
            null, Gio.DBusSignalFlags.NONE, (_c, _s, _p, _i, _n, args) => {
                if (!args.deep_unpack()[0]) this._scheduleRefresh();
            });
        for (const actor of global.get_window_actors()) this._watch(actor.meta_window);
        this._refresh();
    }

    _connect(object, name, callback, bucket = this.signals) {
        const id = object.connect(name, (...args) => {
            if (!this.alive) return undefined;
            try { return callback(...args); }
            catch (error) { global.logError(error, 'VScreen'); return undefined; }
        });
        bucket.push([object, id]);
    }

    _disconnect(bucket) {
        for (const [object, id] of bucket.splice(0)) {
            try { object.disconnect(id); } catch (_) { /* Already destroyed. */ }
        }
    }

    _later(callback, delay = 0) {
        const run = () => {
            this.sources.delete(id);
            if (this.alive) {
                try { callback(); } catch (error) { global.logError(error, 'VScreen'); }
            }
            return GLib.SOURCE_REMOVE;
        };
        const id = delay ? Mainloop.timeout_add(delay, run) : Mainloop.idle_add(run);
        this.sources.add(id);
        return id;
    }

    _cancel(id) {
        if (id && this.sources.delete(id)) Mainloop.source_remove(id);
    }

    _scheduleRefresh() {
        this.topologyPending = true;
        this.refreshGeneration++;
        this._cancelDrag();
        this._cancel(this.refreshSource);
        this.refreshSource = this._later(() => { this.refreshSource = 0; this._refresh(); }, 1500);
    }

    _refresh() {
        const generation = ++this.refreshGeneration;
        if (this.cancellable) this.cancellable.cancel();
        this.cancellable = new Gio.Cancellable();
        Gio.DBus.session.call('org.cinnamon.Muffin.DisplayConfig', '/org/cinnamon/Muffin/DisplayConfig',
            'org.cinnamon.Muffin.DisplayConfig', 'GetCurrentState', null, null,
            Gio.DBusCallFlags.NONE, 2000, this.cancellable, (connection, result) => {
                if (!this.alive || generation !== this.refreshGeneration) return;
                let physical = [];
                try { physical = connection.call_finish(result).deep_unpack()[1]; }
                catch (error) { global.log(`VScreen: display identity unavailable; using monitor names (${error.message})`); }
                try { this._updateMonitors(physical); }
                catch (error) { global.logError(error, 'VScreen display update'); }
            });
    }

    _updateMonitors(physical) {
        const manager = Meta.MonitorManager.get();
        const identities = new Map();
        const unpack = value => value && typeof value.deep_unpack === 'function' ? value.deep_unpack() : value;
        for (const [spec, _modes, props] of physical) {
            const [connector, vendor, product, serial] = spec;
            const index = manager.get_monitor_for_connector(connector);
            if (index < 0) continue;
            identities.set(index, {key: `connector:${connector}`, connector,
                name: unpack(props['display-name']) || product,
                identification: [vendor, product, serial, unpack(props['display-name'])].join(' ')});
        }
        const options = {'Automatically detect XREAL': 'auto'};
        const selected = [];
        const workspace = global.workspace_manager.get_active_workspace();
        for (let index = 0; index < global.display.get_n_monitors(); index++) {
            const name = global.display.get_monitor_name(index) || `Display ${index + 1}`;
            const identity = identities.get(index) || {key: `name:${name}:${index}`, name, identification: name};
            const bounds = Core.copyRect(global.display.get_monitor_geometry(index));
            const area = Core.copyRect(workspace.get_work_area_for_monitor(index));
            options[`${identity.name} (${identity.connector || index + 1})`] = identity.key;
            const matches = this.monitorChoice === 'auto' ? /xreal/i.test(`${name} ${identity.identification}`) :
                this.monitorChoice === identity.key;
            if (!matches) continue;
            const regions = Core.regionsFor(bounds, area, this.layout32);
            if (regions.length) selected.push({key: identity.key, index, bounds, area, regions});
        }
        if (!Object.values(options).includes(this.monitorChoice))
            options['Previously selected display (disconnected)'] = this.monitorChoice;
        if (JSON.stringify(options) !== JSON.stringify(this.settings.getOptions('monitor')))
            this.settings.setOptions('monitor', options);
        this.monitors = selected;
        this.topologyPending = false;
        for (const [window, record] of this.windows) {
            const p = record.state.placement;
            if (!p) continue;
            const monitor = selected.find(m => m.key === p.monitor);
            if (!monitor) {
                const original = record.state.release();
                if (!window.is_fullscreen()) this._restore(window, original);
            } else {
                p.region = Math.min(p.region, monitor.regions.length - 1);
                if (!p.suspended) this._queue(window, 'reflow', () => this._applyPlacement(window));
            }
        }
    }

    _monitorAt(x, y) {
        if (this.topologyPending) return null;
        return this.monitors.find(m => Core.contains(m.bounds, x, y)) || null;
    }

    _monitorFor(frame) {
        if (this.topologyPending) return null;
        return this._monitorAt(frame.x + frame.width / 2, frame.y + frame.height / 2);
    }

    _eligible(window) {
        return window && window.get_window_type() === Meta.WindowType.NORMAL &&
            // allows_resize() is false *while maximized*. The resizeable
            // property describes the underlying application capability.
            !window.is_override_redirect() && window.allows_move() && window.resizeable;
    }

    _watch(window) {
        if (!window || this.windows.has(window) || window.get_window_type() !== Meta.WindowType.NORMAL) return;
        const record = {state: new Core.WindowState(), signals: [], guard: 0, pending: 0,
            pendingKind: null, revision: 0};
        this.windows.set(window, record);
        this._connect(window, 'unmanaged', () => {
            if (this.drag && this.drag.window === window) this._cancelDrag();
            this._cancel(record.pending);
            this._disconnect(record.signals);
            this.windows.delete(window);
        }, record.signals);
        for (const signal of ['position-changed', 'size-changed'])
            this._connect(window, signal, () => {
                if (!record.guard && this._isDragging(window)) this._trackDragMotion();
            }, record.signals);
        for (const signal of ['notify::maximized-horizontally', 'notify::maximized-vertically'])
            this._connect(window, signal, () => {
                if (record.guard || record.pending || this._isDragging(window) || window.is_fullscreen()) return;
                if (window.get_maximized() === Meta.MaximizeFlags.BOTH && !window.tile_mode)
                    // Muffin notifies flags before resizing. Read the current
                    // frame here: a cached normal frame can refer to another monitor.
                    this._requestMaximize(window, window.get_frame_rect());
            }, record.signals);
        this._connect(window, 'notify::fullscreen', () => {
            if (window.is_fullscreen()) {
                this._cancel(record.pending);
                record.pending = 0;
                record.state.suspend();
            } else if (record.state.resume()) {
                this._queue(window, 'fullscreen-exit', () => this._applyPlacement(window));
            }
        }, record.signals);
        this._connect(window, 'monitor-changed', () => {
            const p = record.state.placement;
            if (!p || record.guard || this.topologyPending || window.is_fullscreen()) return;
            const monitor = this._monitorFor(window.get_frame_rect());
            if (!monitor || monitor.key !== p.monitor) record.state.release();
        }, record.signals);
    }

    _queue(window, kind, callback) {
        const record = this.windows.get(window);
        if (!record) return;
        if (record.pending && record.pendingKind === kind) return;
        this._cancel(record.pending);
        record.pendingKind = kind;
        record.pending = this._later(() => {
            record.pending = 0;
            record.pendingKind = null;
            if (this.windows.has(window)) callback();
        });
    }

    _sizeChange(window, kind, oldRect) {
        const record = this.windows.get(window);
        if (!record || record.guard || (this._isDragging(window) && this.drag.moved)) return;
        if (kind === Meta.SizeChange.MAXIMIZE && window.get_maximized() === Meta.MaximizeFlags.BOTH)
            this._requestMaximize(window, oldRect);
        else if (kind === Meta.SizeChange.UNMAXIMIZE && record.state.placement && !window.is_fullscreen())
            this._queue(window, 'restore', () => this._restore(window, record.state.release()));
    }

    _requestMaximize(window, oldRect) {
        if (!this._eligible(window) || window.is_fullscreen() || this.topologyPending) return;
        const original = Core.copyRect(oldRect);
        const monitor = this._monitorFor(original);
        if (!monitor) return;
        const region = Core.regionForWindow(monitor.regions, original);
        if (!region) return;
        const generation = this.refreshGeneration;
        this._queue(window, 'maximize', () => {
            if (generation !== this.refreshGeneration || window.is_fullscreen()) return;
            const record = this.windows.get(window);
            const action = record.state.maximize(original, monitor.key, region.index);
            if (action.type === 'restore') this._restore(window, action.rect);
            else this._applyPlacement(window);
        });
    }

    _withGuard(window, callback) {
        const record = this.windows.get(window);
        if (!record) return;
        record.guard++;
        record.revision++;
        try { callback(); }
        finally {
            // Hold through callbacks queued by Muffin's configure/state change.
            this._later(() => { record.guard = Math.max(0, record.guard - 1); });
        }
    }

    _clearNativeState(window) {
        // Quarter tiles need not have either maximized bit. A guarded maximize
        // followed by unmaximize clears Muffin's private tile constraints too.
        if (window.tile_mode && !window.get_maximized()) window.maximize(Meta.MaximizeFlags.BOTH);
        window.unmaximize(Meta.MaximizeFlags.BOTH);
    }

    _move(window, rect) {
        // Not a user op: Muffin then keeps the old position when it rounds the
        // size to resize increments (gnome-terminal character cells).
        window.move_resize_frame(false, Math.round(rect.x), Math.round(rect.y),
            Math.max(1, Math.round(rect.width)), Math.max(1, Math.round(rect.height)));
    }

    _applyPlacement(window) {
        const record = this.windows.get(window), p = record && record.state.placement;
        if (!p || p.suspended || window.is_fullscreen() || this.topologyPending) return;
        const monitor = this.monitors.find(m => m.key === p.monitor);
        const region = monitor && monitor.regions.find(r => r.index === p.region);
        if (!region) return;
        const rect = Core.targetRect(region, p.kind);
        this._withGuard(window, () => { this._clearNativeState(window); this._move(window, rect); });
        const revision = record.revision;
        // One check, no resize loop: terminals and other apps can enforce size hints.
        this._later(() => {
            if (!this.windows.has(window) || record.revision !== revision ||
                record.state.placement !== p || window.is_fullscreen() || this._isDragging(window)) return;
            const actual = window.get_frame_rect();
            if (actual.width > rect.width + 4 || actual.height > rect.height + 4) {
                const original = record.state.release();
                this._restore(window, original);
                global.log('VScreen: window minimum size exceeds its region; restored the window.');
            }
        }, 150);
    }

    _restore(window, rect) {
        if (!rect || window.is_fullscreen()) return;
        const area = window.get_work_area_current_monitor();
        this._withGuard(window, () => {
            this._clearNativeState(window);
            this._move(window, Core.clampRect(rect, area));
        });
    }

    _isDragging(window) { return this.drag && this.drag.window === window; }

    _grabBegin(window, op) {
        if (!this._eligible(window) || window.is_fullscreen()) return;
        this._watch(window);
        const record = this.windows.get(window);
        const moving = op === Meta.GrabOp.MOVING || op === Meta.GrabOp.KEYBOARD_MOVING;
        const resizing = Object.keys(Meta.GrabOp).some(k => k.includes('RESIZING') && Meta.GrabOp[k] === op);
        if (!moving && !resizing) return; // Ignore titlebar-button grabs.
        this._cancelDrag();
        this._cancel(record.pending);
        record.pending = 0;
        const initialRect = Core.copyRect(window.get_frame_rect());
        const initialPlacement = record.state.placement ? JSON.parse(JSON.stringify(record.state.placement)) : null;
        const original = record.state.placement ? Core.copyRect(record.state.placement.original) : null;
        const [x, y] = global.get_pointer();
        this.drag = {window, moving, initialRect, initialPlacement, original: original || initialRect,
            initialPointer: [x, y], keyboard: op === Meta.GrabOp.KEYBOARD_MOVING, moved: false,
            tracker: new Core.EdgeTracker(), target: null, poll: 0, cancelled: false};
        if (moving) this._pollDrag();
    }

    _trackDragMotion() {
        const drag = this.drag;
        if (!drag || drag.moved || drag.cancelled) return;
        const record = this.windows.get(drag.window);
        const frame = drag.window.get_frame_rect();
        const [x, y] = global.get_pointer();
        const moved = drag.moving ? Math.max(Math.abs(x - drag.initialPointer[0]),
            Math.abs(y - drag.initialPointer[1]), Math.abs(frame.x - drag.initialRect.x),
            Math.abs(frame.y - drag.initialRect.y)) >= 8 :
            frame.width !== drag.initialRect.width || frame.height !== drag.initialRect.height;
        if (!moved) return;
        drag.moved = true;
        const original = record.state.release();
        if (original && drag.moving) {
            const fraction = Math.max(0, Math.min(1, (drag.initialPointer[0] - drag.initialRect.x) / drag.initialRect.width));
            const rect = drag.keyboard ? {...original, x: frame.x, y: frame.y} :
                {...original, x: Math.round(x - fraction * original.width),
                    y: Math.round(y - Math.min(24, Math.max(0, drag.initialPointer[1] - drag.initialRect.y)))};
            this._withGuard(drag.window, () => this._move(drag.window, rect));
        }
    }

    _sampleDrag() {
        const drag = this.drag;
        if (!drag || !drag.moving || drag.keyboard || drag.cancelled || !drag.moved) return null;
        const [x, y, mask] = global.get_pointer();
        const monitor = this._monitorAt(x, y);
        // Alt while dragging: position-based zones, no edge or dwell needed.
        // Other monitors are treated as a single region and are not managed.
        if (mask & Clutter.ModifierType.MOD1_MASK) {
            drag.tracker.reset();
            if (monitor) {
                const zone = Core.altZoneFor(monitor.regions, x, y);
                return zone ? {...zone, monitor: monitor.key, vsMonitor: monitor} : null;
            }
            const workspace = global.workspace_manager.get_active_workspace();
            for (let i = 0; i < global.display.get_n_monitors(); i++) {
                const bounds = Core.copyRect(global.display.get_monitor_geometry(i));
                if (!Core.contains(bounds, x, y)) continue;
                const area = Core.copyRect(workspace.get_work_area_for_monitor(i));
                const zone = Core.altZoneFor([{index: 0, bounds, area}], x, y);
                return zone ? {...zone, monitor: `monitor:${i}`, vsMonitor: null} : null;
            }
            return null;
        }
        const candidate = monitor ? Core.edgeCandidate(monitor.regions, x, y, this.internalEdges) : null;
        if (candidate) candidate.key = `${monitor.key}:${candidate.key}`;
        const ready = drag.tracker.update(candidate, GLib.get_monotonic_time() / 1000, this.dwellMs);
        return ready ? {...ready, monitor: monitor.key} : null;
    }

    _pollDrag() {
        if (!this.drag) return;
        this._trackDragMotion();
        this.drag.target = this._sampleDrag();
        if (this.drag.target) {
            Main.wm._hideTilePreview();
            this._showPreview(this.drag.target.rect);
        } else this._hidePreview();
        this.drag.poll = this._later(() => this._pollDrag(), 16);
    }

    _grabEnd(window) {
        if (!this._isDragging(window)) return;
        const drag = this.drag;
        this._trackDragMotion();
        const target = this._sampleDrag();
        const generation = this.refreshGeneration;
        this._cancelDrag();
        const record = this.windows.get(window);
        if (!record) return;
        if (!drag.moved) return; // A titlebar click/double-click is not a drag.
        // This runs after Muffin finishes its own drop/tiling operation.
        this._queue(window, 'drop', () => {
            if (generation !== this.refreshGeneration || window.is_fullscreen()) return;
            if (drag.cancelled) {
                record.state.placement = drag.initialPlacement;
                if (drag.initialPlacement) this._applyPlacement(window);
                else this._restore(window, drag.initialRect);
            } else if (target) {
                if (target.vsMonitor === null) {
                    this._withGuard(window, () => {
                        this._clearNativeState(window);
                        this._move(window, target.rect);
                        if (target.kind === 'full') window.maximize(Meta.MaximizeFlags.BOTH);
                    });
                } else {
                    record.state.assign(drag.original, target.monitor, target.region, target.kind);
                    this._applyPlacement(window);
                }
            }
        });
    }

    _cancelDrag() {
        if (this.drag) this._cancel(this.drag.poll);
        this.drag = null;
        this._hidePreview();
    }

    _showPreview(rect) {
        if (!this.preview) {
            this.preview = new St.Widget({reactive: false, can_focus: false, style_class: 'tile-preview'});
            Main.uiGroup.add_child(this.preview);
        }
        this.preview.set_position(rect.x, rect.y);
        this.preview.set_size(rect.width, rect.height);
        this.preview.show();
    }

    _hidePreview() { if (this.preview) this.preview.hide(); }

    disable() {
        this._cancelDrag();
        if (this.cancellable) this.cancellable.cancel();
        this.refreshGeneration++;
        this._disconnect(this.signals);
        if (this.sleepSubscription) Gio.DBus.system.signal_unsubscribe(this.sleepSubscription);
        this.sleepSubscription = 0;
        for (const [window, record] of this.windows) {
            this._disconnect(record.signals);
            try { this._restore(window, record.state.release()); }
            catch (error) { global.logError(error, 'VScreen restore'); }
        }
        this.alive = false;
        for (const id of Array.from(this.sources)) this._cancel(id);
        this.windows.clear();
        this.monitors = [];
        if (this.preview) this.preview.destroy();
        this.preview = null;
        if (this.settings) this.settings.finalize();
        this.settings = null;
    }
}

function init(meta) { metadata = meta; }

function enable() {
    if (instance) return;
    instance = new VScreen(metadata);
    try { instance.enable(); }
    catch (error) { instance.disable(); instance = null; throw error; }
}

function disable() {
    if (instance) instance.disable();
    instance = null;
}
