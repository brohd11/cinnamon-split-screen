'use strict';

const {Clutter, Gio, GLib, Meta, St} = imports.gi;
const Main = imports.ui.main;
const Mainloop = imports.mainloop;
const Settings = imports.ui.settings;
const Core = require('./core');

let metadata;
let instance = null;
const PUSH_TILE = ['left', 'right', 'up', 'down'];

class SplitScreen {
    constructor(meta) {
        this.meta = meta;
        this.name = meta.name || 'Split Screen';
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
        this.splits = new Map();
        this.preview = null;
        this.previewRect = null;
        this.muffin = null;
        this.settings = null;
    }

    enable() {
        if (Meta.is_wayland_compositor())
            throw new Error(`${this.name} supports Cinnamon X11 sessions. Wayland has not been validated.`);
        // Variants (such as the AR glasses build) share tiling ownership; only one may run.
        if (global.__splitScreenVariant)
            throw new Error(`${this.name} cannot run while ${global.__splitScreenVariant} is enabled.`);
        global.__splitScreenVariant = this.meta.uuid;
        this.variantOwner = true;
        this.alive = true;
        this.settings = new Settings.ExtensionSettings(this, this.meta.uuid);
        this._bindSettings();
        this._takeOverTiling();

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
            const monitor = this._monitorAt(...global.get_pointer());
            if (this.drag && (this.drag.target || (monitor && !monitor.plain))) Main.wm._hideTilePreview();
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

    _bindSettings() {
        for (const [key, property] of [['internal-edges', 'internalEdges'], ['dwell-ms', 'dwellMs']])
            this.settings.bind(key, property, () => this._scheduleRefresh());
    }

    // Split Screen owns tiling while enabled: Muffin keeps no split sizes and its
    // tiles cannot describe a region, so its edge tiling is switched off and
    // the Super+arrow tile shortcuts are handled here instead.
    _takeOverTiling() {
        const source = Gio.SettingsSchemaSource.get_default();
        if (source && source.lookup('org.cinnamon.muffin', true)) {
            this.muffin = new Gio.Settings({schema_id: 'org.cinnamon.muffin'});
            // The persisted flag covers a crash while edge tiling was held off.
            if (this.muffin.get_boolean('edge-tiling')) {
                this.settings.setValue('restore-edge-tiling', true);
                this.muffin.set_boolean('edge-tiling', false);
            }
        }
        for (const dir of PUSH_TILE)
            Meta.keybindings_set_custom_handler(`push-tile-${dir}`, (_display, window) => {
                if (!this.alive) return;
                try { this._pushTile(window, dir); }
                catch (error) { global.logError(error, this.name); }
            });
    }

    _releaseTiling() {
        for (const dir of PUSH_TILE) Meta.keybindings_set_custom_handler(`push-tile-${dir}`, null);
        if (this.muffin && this.settings && this.settings.getValue('restore-edge-tiling')) {
            this.muffin.set_boolean('edge-tiling', true);
            this.settings.setValue('restore-edge-tiling', false);
        }
        this.muffin = null;
    }

    _connect(object, name, callback, bucket = this.signals) {
        const id = object.connect(name, (...args) => {
            if (!this.alive) return undefined;
            try { return callback(...args); }
            catch (error) { global.logError(error, this.name); return undefined; }
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
                try { callback(); } catch (error) { global.logError(error, this.name); }
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
                catch (error) { global.log(`${this.name}: display identity unavailable; using monitor names (${error.message})`); }
                try { this._updateMonitors(physical); }
                catch (error) { global.logError(error, `${this.name} display update`); }
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
        const selected = [], displays = [];
        const workspace = global.workspace_manager.get_active_workspace();
        for (let index = 0; index < global.display.get_n_monitors(); index++) {
            const name = global.display.get_monitor_name(index) || `Display ${index + 1}`;
            const identity = identities.get(index) || {key: `name:${name}:${index}`, name, identification: name};
            const bounds = Core.copyRect(global.display.get_monitor_geometry(index));
            const area = Core.copyRect(workspace.get_work_area_for_monitor(index));
            displays.push({index, name, identity});
            // Unsplit monitors are one plain region: Alt-drag tiles link there,
            // while edge drags and maximize stay native Cinnamon behaviour.
            const regions = this._regionsFor(identity, name, bounds, area);
            selected.push(regions.length ? {key: identity.key, index, bounds, area, regions, plain: false} :
                {key: identity.key, index, bounds, area, regions: [{index: 0, bounds, area}], plain: true});
        }
        this._monitorsUpdated(displays);
        this.monitors = selected;
        this.topologyPending = false;
        for (const key of Array.from(this.splits.keys())) {
            const [monitorKey, region] = this._splitKeyParts(key);
            const monitor = selected.find(m => m.key === monitorKey);
            if (!monitor || !monitor.regions.some(r => r.index === region)) this.splits.delete(key);
        }
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

    // Variant hooks. The base never splits a display into regions.
    _regionsFor(_identity, _name, _bounds, _area) { return []; }

    _monitorsUpdated(_displays) {}

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
        if (monitor.plain) {
            // Native maximize; its native restore returns to the tile rect.
            const record = this.windows.get(window);
            if (record) record.state.release();
            return;
        }
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
        // size to resize increments (gnome-terminal character cells), and
        // _centreSlack() can centre the rounded-down frame in its slot.
        window.move_resize_frame(false, Math.round(rect.x), Math.round(rect.y),
            Math.max(1, Math.round(rect.width)), Math.max(1, Math.round(rect.height)));
    }

    // Size hints leave up to one cell of slack; split it around the window
    // rather than leaving it all at the bottom/right. A move cannot re-round.
    _centreSlack(window, rect) {
        const actual = window.get_frame_rect();
        const dx = Math.round(rect.width) - actual.width, dy = Math.round(rect.height) - actual.height;
        if (dx < 0 || dy < 0 || (!dx && !dy)) return;
        const x = Math.round(rect.x) + Math.floor(dx / 2), y = Math.round(rect.y) + Math.floor(dy / 2);
        if (x !== actual.x || y !== actual.y) window.move_frame(false, x, y);
    }

    _applyPlacement(window) {
        const record = this.windows.get(window), p = record && record.state.placement;
        if (!p || p.suspended || window.is_fullscreen() || this.topologyPending) return;
        const monitor = this.monitors.find(m => m.key === p.monitor);
        const region = monitor && monitor.regions.find(r => r.index === p.region);
        if (!region) return;
        const rect = Core.targetRect(region, p.kind, this._split(p.monitor, p.region));
        this._withGuard(window, () => {
            this._clearNativeState(window);
            this._move(window, rect);
            this._centreSlack(window, rect);
        });
        const revision = record.revision;
        // One check, no resize loop: terminals and other apps can enforce size hints.
        this._later(() => {
            if (!this.windows.has(window) || record.revision !== revision ||
                record.state.placement !== p || window.is_fullscreen() || this._isDragging(window)) return;
            const actual = window.get_frame_rect();
            if (actual.width > rect.width + 4 || actual.height > rect.height + 4) {
                const original = record.state.release();
                this._restore(window, original);
                global.log(`${this.name}: window minimum size exceeds its region; restored the window.`);
            } else {
                // The client may settle on its size after the first check.
                this._withGuard(window, () => this._centreSlack(window, rect));
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

    _splitKey(monitor, region) { return JSON.stringify([monitor, region]); }

    _splitKeyParts(key) { return JSON.parse(key); }

    _regionWindows(monitor, region, except = null) {
        return Array.from(this.windows).filter(([window, record]) => {
            const p = record.state.placement;
            return window !== except && p && !p.suspended && p.monitor === monitor &&
                p.region === region && p.kind !== 'full';
        }).map(([window]) => window);
    }

    // A region's dividers persist while a half or quarter is placed in it.
    _split(monitor, region) {
        const key = this._splitKey(monitor, region);
        if (!this._regionWindows(monitor, region).length) this.splits.delete(key);
        return this.splits.get(key);
    }

    _reflowRegion(monitor, region, except = null) {
        for (const window of this._regionWindows(monitor, region, except))
            this._queue(window, 'reflow', () => this._applyPlacement(window));
    }

    _trackDivider() {
        const drag = this.drag, record = this.windows.get(drag.window);
        const p = record && record.state.placement;
        const monitor = p && this.monitors.find(m => m.key === p.monitor);
        const region = monitor && monitor.regions.find(r => r.index === p.region);
        if (!region) return;
        const frame = drag.window.get_frame_rect();
        if (frame.width === drag.initialRect.width && frame.height === drag.initialRect.height &&
            frame.x === drag.initialRect.x && frame.y === drag.initialRect.y) return;
        drag.moved = true;
        this.splits.set(this._splitKey(p.monitor, p.region),
            Core.resizeSplit(region, p.kind, drag.divider, frame, this._split(p.monitor, p.region)));
        this._reflowRegion(p.monitor, p.region, drag.window);
    }

    _pushTile(window, dir) {
        if (!this._eligible(window) || window.is_fullscreen() || this.topologyPending || this._isDragging(window)) return;
        this._watch(window);
        const record = this.windows.get(window);
        const p = record.state.placement && !record.state.placement.suspended ? record.state.placement : null;
        const monitor = p ? this.monitors.find(m => m.key === p.monitor) : this._monitorFor(window.get_frame_rect());
        if (!monitor) return;
        const nativeFull = !p && window.get_maximized() === Meta.MaximizeFlags.BOTH;
        const region = p ? p.region : (Core.regionForWindow(monitor.regions, window.get_frame_rect()) || {}).index;
        if (region === undefined) return;
        const next = Core.pushTile(p ? p.kind : nativeFull ? 'full' : null, dir, region,
            monitor.regions.map(r => r.index));
        if (!next) return;
        if (next.restore) {
            if (p) this._restore(window, record.state.release());
            else this._withGuard(window, () => window.unmaximize(Meta.MaximizeFlags.BOTH));
        } else if (monitor.plain && next.kind === 'full') {
            this._withGuard(window, () => { this._clearNativeState(window); window.maximize(Meta.MaximizeFlags.BOTH); });
        } else {
            // From a native maximize, keep Muffin's normal rect as the restore size.
            if (nativeFull) this._withGuard(window, () => window.unmaximize(Meta.MaximizeFlags.BOTH));
            record.state.assign(Core.copyRect(window.get_frame_rect()), monitor.key, next.region, next.kind);
            this._queue(window, 'push-tile', () => this._applyPlacement(window));
        }
    }

    _isDragging(window) { return this.drag && this.drag.window === window; }

    _grabBegin(window, op) {
        if (!this._eligible(window) || window.is_fullscreen()) return;
        this._watch(window);
        const record = this.windows.get(window);
        const moving = op === Meta.GrabOp.MOVING || op === Meta.GrabOp.KEYBOARD_MOVING;
        const resizeName = Object.keys(Meta.GrabOp).find(k => k.includes('RESIZING') && Meta.GrabOp[k] === op);
        if (!moving && !resizeName) return; // Ignore titlebar-button grabs.
        const direction = resizeName ? resizeName.replace(/^.*RESIZING_/, '') : '';
        const edges = /^[NSEW]+$/.test(direction) ? direction.toLowerCase().split('') : [];
        const p = record.state.placement;
        const divider = !moving && p && !p.suspended ? Core.dividerFor(p.kind, edges) : null;
        this._cancelDrag();
        this._cancel(record.pending);
        record.pending = 0;
        const initialRect = Core.copyRect(window.get_frame_rect());
        const initialPlacement = record.state.placement ? JSON.parse(JSON.stringify(record.state.placement)) : null;
        const original = record.state.placement ? Core.copyRect(record.state.placement.original) : null;
        const [x, y] = global.get_pointer();
        this.drag = {window, moving, initialRect, initialPlacement, original: original || initialRect,
            initialPointer: [x, y], keyboard: op === Meta.GrabOp.KEYBOARD_MOVING, moved: false,
            tracker: new Core.EdgeTracker(), target: null, poll: 0, cancelled: false, divider,
            initialSplit: p ? this._split(p.monitor, p.region) : undefined};
        if (moving) this._pollDrag();
    }

    _trackDragMotion() {
        const drag = this.drag;
        if (drag && drag.divider && !drag.cancelled) { this._trackDivider(); return; }
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
        if (!monitor) return null;
        const splitFor = region => this._split(monitor.key, region);
        // Alt while dragging: position-based zones, no edge or dwell needed.
        if (mask & Clutter.ModifierType.MOD1_MASK) {
            drag.tracker.reset();
            const zone = Core.altZoneFor(monitor.regions, x, y, splitFor);
            return zone ? {...zone, monitor: monitor.key, plain: monitor.plain} : null;
        }
        const candidate = Core.edgeCandidate(monitor.regions, x, y, this.internalEdges, splitFor);
        if (candidate) candidate.key = `${monitor.key}:${candidate.key}`;
        const ready = drag.tracker.update(candidate, GLib.get_monotonic_time() / 1000, this.dwellMs);
        return ready ? {...ready, monitor: monitor.key, plain: monitor.plain} : null;
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
                if (drag.divider) {
                    const p = drag.initialPlacement, key = this._splitKey(p.monitor, p.region);
                    if (drag.initialSplit) this.splits.set(key, drag.initialSplit);
                    else this.splits.delete(key);
                    this._reflowRegion(p.monitor, p.region, window);
                }
                if (drag.initialPlacement) this._applyPlacement(window);
                else this._restore(window, drag.initialRect);
            } else if (drag.divider) {
                this._applyPlacement(window); // Settle exactly on the new divider.
            } else if (target && target.plain && target.kind === 'full') {
                this._withGuard(window, () => { this._clearNativeState(window); window.maximize(Meta.MaximizeFlags.BOTH); });
            } else if (target) {
                record.state.assign(drag.original, target.monitor, target.region, target.kind);
                this._applyPlacement(window);
            }
        });
    }

    _cancelDrag() {
        if (this.drag) this._cancel(this.drag.poll);
        this.drag = null;
        this._hidePreview();
    }

    _previewTime() {
        if (!Main.animations_enabled) return 0;
        return (Main.wm.TILE_PREVIEW_ANIMATION_TIME || 150) * (Main.wm.window_effect_multiplier || 1);
    }

    // Like Cinnamon's own tile preview: grow out of the window, slide between
    // targets and fade out.
    _showPreview(rect) {
        if (!this.preview) {
            this.preview = new St.Widget({reactive: false, can_focus: false, style_class: 'tile-preview'});
            Main.uiGroup.add_child(this.preview);
        }
        const preview = this.preview, time = this._previewTime();
        if (this.previewRect && Core.sameRect(this.previewRect, rect)) return;
        preview.remove_all_transitions();
        if (!this.previewRect) {
            const from = this.drag ? this.drag.window.get_frame_rect() : rect;
            preview.set_position(from.x, from.y);
            preview.set_size(from.width, from.height);
            preview.opacity = 0;
            preview.show();
        }
        this.previewRect = Core.copyRect(rect);
        const props = {x: rect.x, y: rect.y, width: rect.width, height: rect.height, opacity: 255};
        if (time) preview.ease({...props, duration: time, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        else Object.assign(preview, props);
    }

    _hidePreview() {
        if (!this.preview || !this.previewRect) return;
        const preview = this.preview, time = this._previewTime();
        this.previewRect = null;
        preview.remove_all_transitions();
        if (time) preview.ease({opacity: 0, duration: time, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => preview.hide()});
        else preview.hide();
    }

    disable() {
        this._cancelDrag();
        // A refused variant must not release the running variant's shortcuts.
        try { if (this.variantOwner) this._releaseTiling(); }
        catch (error) { global.logError(error, `${this.name} tiling restore`); }
        if (this.cancellable) this.cancellable.cancel();
        this.refreshGeneration++;
        this._disconnect(this.signals);
        if (this.sleepSubscription) Gio.DBus.system.signal_unsubscribe(this.sleepSubscription);
        this.sleepSubscription = 0;
        for (const [window, record] of this.windows) {
            this._disconnect(record.signals);
            try { this._restore(window, record.state.release()); }
            catch (error) { global.logError(error, `${this.name} restore`); }
        }
        this.alive = false;
        for (const id of Array.from(this.sources)) this._cancel(id);
        this.windows.clear();
        this.monitors = [];
        if (this.preview) this.preview.destroy();
        this.preview = null;
        this.previewRect = null;
        this.splits.clear();
        if (this.settings) this.settings.finalize();
        this.settings = null;
        if (this.variantOwner) delete global.__splitScreenVariant;
        this.variantOwner = false;
    }
}

function init(meta) { metadata = meta; }

function enable() {
    if (instance) return;
    instance = new SplitScreen(metadata);
    try { instance.enable(); }
    catch (error) { instance.disable(); instance = null; throw error; }
}

function disable() {
    if (instance) instance.disable();
    instance = null;
}
