# Cinnamon Split Screen

A Cinnamon extension for tiling windows.
- adds alt-drag tiling, overides Cinnamon's edge drag and Super+Arrow key tiling to allow compatibility between the systems.
- drag the shared edge between tiles to resize them together, and snap new windows into the space that's left.
- includes a extra  mode for XREAL glasses that splits and ultrawide screen into smaller screens for easier workspace management. Fullscreen (for example, browser F11 or fullscreen video) still uses the entire physical display.

## Install

Target: Linux Mint 22+ / Cinnamon 6.4+, **X11**. Python 3 is needed by the installer; the extension runs in Cinnamon's JavaScript runtime. Cinnamon on other Linux distributions can use the same extension, but other desktops and Wayland are not supported by this version.

```sh
cd cinnamon-split-screen
./install.sh
```

Open **System Settings → Extensions**, select **Split Screen**, and enable it. Enabled extensions load automatically at each desktop login.

Installation is per user, under `~/.local/share/cinnamon/extensions/split-screen@brohd11`. Run the installer again to update, then disable and re-enable Split Screen to load the new code.

## Uninstall

```sh
./uninstall.sh
```

Run this from your Cinnamon desktop session. It removes Split Screen from the enabled extension list, which turns Cinnamon's edge tiling back on, and deletes its installed files, preserving other enabled extensions and saved Split Screen preferences. You can also disable Split Screen without uninstalling it in Extensions.

## XREAL/Glasses

Split Screen detects XREAL by the display name/product reported by Cinnamon and splits the ultrawide display into regions that behave as a display in regards to tiling. It runs when displays are changed or when the glasses were connected before login. Display changes are applied after a 1.5-second settling period.

Use Split Screen's settings button in Extensions to choose which display is split, if automatic detection fails or you want to split a desktop ultrawide monitor instead. The display list is populated while the extension is enabled. Automatic detection handles all connected XREAL displays; a manual selection targets one connector.

### Layouts and controls

| Split display mode | Arrangement |
| --- | --- |
| 32:9 | Two equal regions, by default |
| 32:9, three-region setting | Quarter / half / quarter |
| 21:9 (64:27) | 16:9 left region, remaining strip on the right |
| 16:9 or other aspect ratios, and every other display | One region |

The extension uses the current logical display size, including scaling, and excludes panels from window placement. It does not change resolutions or rearrange physical displays. Split boundaries follow the physical display proportions, even when a panel reserves part of its work area.

- **Maximize button, title-bar double-click, or maximize shortcut:** fill the region containing the window's center. Repeat to restore the original size. Maximizing a half-region window expands it to its whole region.
- **Drag to a region's top edge:** fill that region.
- **Drag to its left/right edge:** fill the corresponding half of the region, or a quarter in the top or bottom 25% of the edge (so corners give quarters, like Cinnamon's native tiling). Internal boundaries require a short pause (250 ms by default) within 12 logical pixels. A preview in your theme's tile-preview style shows the pending placement; release to apply it. Crossing without pausing does not snap.
- **Hold Alt while dragging:** snap by position, without reaching an edge. The centre 20% of a region fills it, each side takes that half, and the top or bottom 30% of a side takes that quarter. This works on every display; on non-glasses displays the whole screen is one region, and the centre zone natively maximizes. Alt does nothing unless a window is being dragged.
- **Resize the shared edge between tiles:** move that region's divider. Neighbouring halves and quarters resize with it, and later snaps into that region fill the remaining space. The divider resets once no half or quarter is left in the region.
- **Move a placed window, or resize one of its outer edges:** release its region assignment. Moving restores its original size; resizing uses your chosen size. A title-bar click without movement does not release it. Escape cancels a drag.
- **Super+Left/Right/Up/Down:** tile from the keyboard.
  - Left/Right snap that half. From the opposite half they restore the window; from a quarter they move it to the other side.
  - Pressed toward the outside of a region, a half or quarter moves into the neighbouring region, so the glasses' regions behave like separate monitors.
  - Up turns a half into its top quarter, a bottom quarter back into its half, and a normal window into a full region.
  - Down turns a half into its bottom quarter, a top quarter back into its half, and a full region back to normal.
- **Fullscreen:** use the whole physical display. Exiting fullscreen returns to the previous region placement.

Non-resizable windows and dialogs are excluded. Applications with minimum sizes wider than a region are restored instead of being repeatedly forced to fit.

Region-filled windows are ordinary resized windows internally. Consequently, their maximize icon/menu wording may still say “Maximize”; pressing it again restores the window. Native unmaximize-only shortcuts are not region-restore commands. Other extensions that change maximize or snapping behavior may conflict. Native Cinnamon size animations can briefly show the physical monitor's maximize geometry before region sizing completes.

Changing layouts or display geometry reflows only region-assigned windows. Disconnecting the glasses, returning to 16:9, or disabling the extension clears assignments and restores ordinary windows within the available work area. A window currently in fullscreen is left in fullscreen; its saved region assignment is discarded if that display disappears or the extension is disabled. Placements are not persisted across Cinnamon restarts.