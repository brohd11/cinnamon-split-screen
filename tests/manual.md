# Graphical acceptance checklist

Status: **not run**. Requires a Cinnamon 6.6 X11 session and, for glasses steps, the AR variant (`./install.sh --ar`) with XREAL hardware. Headless tests cannot prove native drag grabs, application title bars, animations, or visual frame placement.

Record Cinnamon/Muffin versions, GPU/driver, session type, glasses model, display mode, scale, application versions, and any other window-management extensions when reporting results.

## Setup and maximize

1. Install and enable Split Screen. Confirm it appears without requiring administrator privileges and that its display selector lists connected displays.
2. On 3840×1080 glasses, maximize a window in each half using its button, title-bar double-click, window menu, and configured maximize shortcut. Expect a 1920-pixel-wide region at 100% scale, less any panel work-area reservation.
3. Repeat the action to restore the original rectangle. A simple title-bar click must not resize the window. Repeat with an initially normal window, a half-region window, and a window crossing the center boundary.
4. Cover a Cinnamon-native application, a GTK application with client-side decorations, Firefox/Chromium, and an Electron application. Verify direct application maximize requests are intercepted, not just shell menu actions.
5. Verify dialogs and non-resizable windows remain usable. Try a terminal with resize increments and an application whose minimum width exceeds the 21:9 strip; the latter should return to its normal size without a resize loop.

## Dragging and fullscreen

1. Drag to each region's top edge: preview and final placement fill that region.
2. Drag to each outer side: preview and final placement fill half the outer region.
3. Approach an internal boundary from both sides and pause. Preview the right half of the left region or left half of the right region, respectively. Cross quickly and confirm there is no snap. Disable internal snapping in settings and repeat.
4. At each corner, and at the top or bottom 25% of a side edge, expect a quarter of the region; along the rest of the top edge, the whole region. Internal corners need the same pause as internal edges.
5. Move a region-filled window by its title bar and Alt+drag. Verify it releases at the original size and remains controllable under the pointer. Test keyboard moving/resizing too. Press Escape during a move and a resize; expect the pre-grab placement to return.
6. Release quickly at a top/outer edge and check that native Cinnamon snapping does not override the extension's final rectangle. Check for conflicting previews or persistent overlay actors.
7. Enter fullscreen using browser F11 and a video player's fullscreen control. Expect the entire glasses display. Exit and expect the prior region/half-region placement.
8. On the laptop display, edge drags, corners and Alt-drag tile as one Split Screen region; the top edge and maximize button natively maximize; fullscreen is unchanged. No Cinnamon tile preview should appear on any display.
9. Super+Left/Right/Up/Down: walk each window through halves, quarters, full and restore as documented in the README, including hopping between glasses regions and stopping at the first and last region. Super+Up on the glasses must not flash full screen.
10. With tiles placed, Super+arrow and edge snaps into a region with a moved divider fill the remaining space.

## Layout and lifecycle

1. Switch dual/triple 32:9 layouts. Confirm region assignments reflow and all horizontal pixels belong to exactly one region.
2. Switch to 2560×1080 (64:27); expect widths 1920 and 640 at 100% scale. Switch to 16:9; expect normal behavior and cleared assignments. Split Screen must not change the selected resolution.
3. Test 150% scaling, a top or side panel, and glasses positioned above or left of the laptop. Confirm work areas and offsets are respected.
4. Move the physical display in Display Settings, reconnect it through another port, and move an assigned window to the laptop via a desktop shortcut. Check that a later layout refresh does not pull an intentionally moved window back.
5. Unplug during a drag, while region-filled, and while fullscreen. All windows must remain recoverable on the remaining monitor. Reconnect and verify new maximize/snap actions work.
6. Suspend/resume with glasses connected and disconnected. Log out/in with glasses already connected. Expect automatic detection without manually launching a process.
7. Disable and re-enable the extension repeatedly. `gsettings get org.cinnamon.muffin edge-tiling` must read false while enabled and return to its previous value when disabled. Check restored normal windows, preserved fullscreen, no stale previews, and no duplicate handling. Verify idle CPU does not show continued pointer polling.
8. Update by rerunning the installer, then disable/re-enable. Uninstall and verify other extensions and Split Screen preferences are preserved.

If a check fails, capture the exact action sequence and the Split Screen entries from Looking Glass. A passing headless suite is not a substitute for these checks.
