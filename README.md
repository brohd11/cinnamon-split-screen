# Linux VScreen

A Cinnamon extension for using XREAL ultrawide glasses as two or three window regions. Maximize and drag-to-top fill one region; side drags fill half of that region. Fullscreen (for example, browser F11 or fullscreen video) still uses the entire physical display.

This is a separate Linux implementation of the layouts in `../macos-vscreen`. It does **not** create virtual monitor identities, capture the screen, or need a kernel driver. Applications and Display Settings continue to see one XREAL display.

## Install

Target: Linux Mint 22.3 / Cinnamon 6.6, **X11**. Python 3 is needed by the installer; the extension runs in Cinnamon's JavaScript runtime. Cinnamon on other Linux distributions can use the same extension, but other desktops and Wayland are not supported by this version.

```sh
cd linux-vscreen
./install.sh
```

Open **System Settings → Extensions**, select **VScreen**, and enable it with the **+** button. Enabled extensions load automatically at each desktop login. No separate autostart entry or background service is needed. If Cinnamon does not list a newly installed extension immediately, reopen Extensions or log out and back in.

Connect the glasses and select their ultrawide mode and desired resolution. VScreen detects XREAL by the display name/product reported by Cinnamon. It also runs when the glasses were connected before login. Display changes are applied after a 1.5-second settling period.

Use VScreen's settings button in Extensions to select a display manually if automatic detection fails. The display list is populated while the extension is enabled. Automatic detection handles all connected XREAL displays; a manual selection targets one connector. This also allows testing on another ultrawide monitor.

Installation is per user, under `~/.local/share/cinnamon/extensions/vscreen@brohd`. Run the installer again to update, then disable and re-enable VScreen to load the new code. No administrator privileges are needed. Settings are managed by Cinnamon and survive updates.

## Layouts and controls

| Glasses mode | Arrangement |
| --- | --- |
| 32:9 | Two equal regions, by default |
| 32:9, three-region setting | Quarter / half / quarter |
| 21:9 (64:27) | 16:9 left region, remaining strip on the right |
| 16:9 or other aspect ratios | Normal Cinnamon behavior |

The extension uses the current logical display size, including scaling, and excludes panels from window placement. It does not change resolutions or rearrange physical displays. Split boundaries follow the physical display proportions, even when a panel reserves part of its work area.

- **Maximize button, title-bar double-click, or maximize shortcut:** fill the region containing the window's center. Repeat to restore the original size. Maximizing a half-region window expands it to its whole region.
- **Drag to a region's top edge:** fill that region. At corners, top-edge behavior wins.
- **Drag to its left/right edge:** fill the corresponding half of the region. Internal boundaries require a short pause (250 ms by default) within 12 logical pixels. A preview in your theme's tile-preview style shows the pending placement; release to apply it. Crossing without pausing does not snap.
- **Hold Alt while dragging:** snap by position, without reaching an edge. The centre 20% of a region fills it, each side takes that half, and the top or bottom 30% of a side takes that quarter. This works on every display; on non-glasses displays the whole screen is one region, and the centre zone natively maximizes. Alt does nothing unless a window is being dragged.
- **Resize the shared edge between tiles:** move that region's divider. Neighbouring halves and quarters resize with it, and later snaps into that region fill the remaining space. The divider resets once no half or quarter is left in the region.
- **Move a placed window, or resize one of its outer edges:** release its region assignment. Moving restores its original size; resizing uses your chosen size. A title-bar click without movement does not release it. Escape cancels a drag.
- **Fullscreen:** use the whole physical display. Exiting fullscreen returns to the previous region placement.

Normal laptop and other unselected displays keep Cinnamon's edge tiling and maximize behavior; only Alt-drag tiles are managed there. Non-resizable windows and dialogs are excluded. Applications with minimum sizes wider than a region are restored instead of being repeatedly forced to fit.

Region-filled windows are ordinary resized windows internally. Consequently, their maximize icon/menu wording may still say “Maximize”; pressing it again restores the window. Native unmaximize-only shortcuts are not region-restore commands. Other extensions that change maximize or snapping behavior may conflict. Native Cinnamon size animations can briefly show the physical monitor's maximize geometry before region sizing completes.

Changing layouts or display geometry reflows only region-assigned windows. Disconnecting the glasses, returning to 16:9, or disabling the extension clears assignments and restores ordinary windows within the available work area. A window currently in fullscreen is left in fullscreen; its saved region assignment is discarded if that display disappears or the extension is disabled. Placements are not persisted across Cinnamon restarts.

## Uninstall

```sh
./uninstall.sh
```

Run this from your Cinnamon desktop session. It removes VScreen from the enabled extension list and deletes its installed files, preserving other enabled extensions and saved VScreen preferences. You can also disable VScreen without uninstalling it in Extensions.

## Development and verification

```sh
make test
```

Tests require `cjs` and Python 3. They run geometry/state tests, exercise the actual adapter against a simulated desktop, check the installed Cinnamon/Muffin API signatures when available, and test installation/update/removal in temporary directories. Tests do not alter your desktop or install the extension into your profile.

The implementation has been checked against the locally installed Cinnamon 6.6.9 / Muffin 6.6.3 APIs. **Live graphical behavior and XREAL hardware remain unverified in this workspace**, which has no attached desktop session. Follow [the graphical acceptance checklist](tests/manual.md) before treating this version as validated for everyday use.

`core.js` contains desktop-independent geometry, edge dwell, and restore state. `extension.js` adapts those operations to Cinnamon's window/display signals and frame APIs. It watches native maximize transitions, including application requests, rather than just replacing JavaScript maximize calls. Frame updates run after native operations return, with recursion guards and stale-topology checks. Pointer sampling runs only during an active move operation; there is no idle polling.

Useful upstream references: [Cinnamon extension lifecycle](https://github.com/linuxmint/cinnamon/blob/6.6.9/js/ui/extensionSystem.js), [Muffin window APIs](https://github.com/linuxmint/muffin/blob/6.6.3/src/meta/window.h), and [display configuration interface](https://github.com/linuxmint/muffin/blob/6.6.3/src/org.cinnamon.Muffin.DisplayConfig.xml).

For troubleshooting, open Cinnamon's Looking Glass (Alt+F2, then `lg`) and inspect its log for `VScreen` messages. If no layout activates, verify the X11 session, selected display, and 32:9 or 64:27 aspect ratio. Fractional-scale rounding is allowed; arbitrary aspect ratios are deliberately left alone.
