'use strict';

// The AR glasses variant: Split Screen plus virtual screens on ultrawide displays.
// Built flat next to the base files, with the base extension.js renamed to base.js.
const Base = require('./base');
const Layouts = require('./layouts');

let metadata;
let instance = null;

class ArSplitScreen extends Base.SplitScreen {
    _bindSettings() {
        super._bindSettings();
        for (const [key, property] of [['monitor', 'monitorChoice'], ['layout-32', 'layout32']])
            this.settings.bind(key, property, () => this._scheduleRefresh());
    }

    _regionsFor(identity, name, bounds, area) {
        const matches = this.monitorChoice === 'auto' ? /xreal/i.test(`${name} ${identity.identification}`) :
            this.monitorChoice === identity.key;
        return matches ? Layouts.regionsFor(bounds, area, this.layout32) : [];
    }

    _monitorsUpdated(displays) {
        const options = {'Automatically detect XREAL': 'auto'};
        for (const {index, identity} of displays)
            options[`${identity.name} (${identity.connector || index + 1})`] = identity.key;
        if (!Object.values(options).includes(this.monitorChoice))
            options['Previously selected display (disconnected)'] = this.monitorChoice;
        if (JSON.stringify(options) !== JSON.stringify(this.settings.getOptions('monitor')))
            this.settings.setOptions('monitor', options);
    }
}

function init(meta) { metadata = meta; }

function enable() {
    if (instance) return;
    instance = new ArSplitScreen(metadata);
    try { instance.enable(); }
    catch (error) { instance.disable(); instance = null; throw error; }
}

function disable() {
    if (instance) instance.disable();
    instance = null;
}
