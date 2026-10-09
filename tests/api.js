// Check the local typelib contract without connecting to a display server.
'use strict';
const {Meta, Cinnamon, GObject} = imports.gi;
let assertions = 0;
function check(value, label) { assertions++; if (!value) throw new Error(label); }
function signal(type, name, parameters) {
    GObject.type_class_ref(type);
    const id = GObject.signal_lookup(name, type);
    check(id > 0, `Missing signal ${name}`);
    const query = GObject.signal_query(id);
    check(query.param_types.map(t => GObject.type_name(t)).join(',') === parameters.join(','),
        `Signature changed: ${name}`);
}
signal(Meta.Display, 'grab-op-begin', ['MetaDisplay', 'MetaWindow', 'MetaGrabOp']);
signal(Meta.Display, 'grab-op-end', ['MetaDisplay', 'MetaWindow', 'MetaGrabOp']);
signal(Meta.Display, 'window-created', ['MetaWindow']);
signal(Meta.Display, 'workareas-changed', []);
signal(Meta.WorkspaceManager, 'active-workspace-changed', []);
signal(Cinnamon.WM, 'size-change', ['MetaWindowActor', 'MetaSizeChange', 'MetaRectangle', 'MetaRectangle']);
signal(Cinnamon.WM, 'show-tile-preview', ['MetaWindow', 'MetaRectangle', 'gint']);
for (const name of ['unmanaged', 'position-changed', 'size-changed']) signal(Meta.Window, name, []);
signal(Meta.Window, 'monitor-changed', ['gint']);
for (const name of ['get_frame_rect', 'get_maximized', 'is_fullscreen', 'allows_resize', 'allows_move',
    'get_work_area_current_monitor', 'move_resize_frame', 'maximize', 'unmaximize'])
    check(typeof Meta.Window.prototype[name] === 'function', `Missing window API: ${name}`);
for (const name of ['get_n_monitors', 'get_monitor_geometry', 'get_monitor_name'])
    check(typeof Meta.Display.prototype[name] === 'function', `Missing display API: ${name}`);
check(typeof Meta.MonitorManager.prototype.get_monitor_for_connector === 'function', 'Connector lookup');
check(typeof Meta.Workspace.prototype.get_work_area_for_monitor === 'function', 'Workspace work area');
const properties = Meta.Window.list_properties().map(p => p.name);
for (const name of ['fullscreen', 'tile-mode', 'maximized-horizontally', 'maximized-vertically', 'resizeable'])
    check(properties.includes(name), `Missing property: ${name}`);
imports.searchPath.unshift('/usr/share/cinnamon/js');
const loaded = imports.misc.fileUtils.requireModule(`${ARGV[0]}/core.js`, ARGV[0], {}, 'extension');
check(typeof loaded.regionsFor === 'function', 'Geometry exported by Cinnamon module loader');
check(typeof loaded.WindowState === 'function', 'State exported by Cinnamon module loader');
check(typeof loaded.EdgeTracker === 'function', 'Dwell exported by Cinnamon module loader');
check(typeof loaded.altZoneFor === 'function', 'Alt zones exported by Cinnamon module loader');
check(imports.gi.Clutter.ModifierType.MOD1_MASK === 8, 'Alt modifier mask matches adapter mock');
print(`Installed Cinnamon API: ${assertions} assertions passed`);
