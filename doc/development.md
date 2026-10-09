# Development and Verification

```sh
make test
```

Tests require `cjs` and Python 3. They run geometry/state tests, exercise the actual adapter against a simulated desktop, check the installed Cinnamon/Muffin API signatures when available, and test installation/update/removal in temporary directories. Tests do not alter your desktop or install the extension into your profile.

The implementation has been checked against the locally installed Cinnamon 6.6.9 / Muffin 6.6.3 APIs. It has been used on a live Cinnamon X11 desktop with XREAL glasses, but **the full graphical acceptance checklist has not been run**. Follow [the graphical acceptance checklist](tests/manual.md) before treating this version as validated for everyday use.

`core.js` contains desktop-independent geometry, edge dwell, dividers, keyboard tiling rules, and restore state. `extension.js` adapts those operations to Cinnamon's window/display signals and frame APIs. It watches native maximize transitions, including application requests, rather than just replacing JavaScript maximize calls. Frame updates run after native operations return, with recursion guards and stale-topology checks. Pointer sampling runs only during an active move operation; there is no idle polling.

Useful upstream references: [Cinnamon extension lifecycle](https://github.com/linuxmint/cinnamon/blob/6.6.9/js/ui/extensionSystem.js), [Muffin window APIs](https://github.com/linuxmint/muffin/blob/6.6.3/src/meta/window.h), and [display configuration interface](https://github.com/linuxmint/muffin/blob/6.6.3/src/org.cinnamon.Muffin.DisplayConfig.xml).

For troubleshooting, open Cinnamon's Looking Glass (Alt+F2, then `lg`) and inspect its log for `Split Screen` messages. If a display isn't split, verify the X11 session, selected display, and 32:9 or 64:27 aspect ratio. Fractional-scale rounding is allowed; arbitrary aspect ratios are deliberately left alone.