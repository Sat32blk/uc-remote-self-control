**Beta.** Back up your remote's configuration in the web configurator before installing. If you used an earlier version, save a **Backup** in the builder first (new in this release).

Install: web configurator → Integrations → Add new → Install custom → `uc-intg-self-control-0.8.0.tar.gz` (tick **Update existing driver** to update).

## What's new since 0.5.0

### Controls (new tab "Controls ⇅")
Point the volume rocker and the Remote 3 touch slider at something else for a moment: a light, a tone control, the screen or backlight brightness, or one of your sliders (IR up/down too). You get the remote's own vertical volume pop-up with it.
- One **Control: \<name\>** switch per control; turning one on switches to it.
- A **Control Active** sensor ("Ceiling Light · 60 %").
- A timeout, or "stay on until changed".
- Per activity, what the rocker and slider do when no control is on, or nothing.
- Optional **borrow**: the rocker stays mapped straight to your TV and points at Control only while a control is on.
- **Reset the value** for devices that don't report their level.

### Sliders, quick menus and level pictures
- **Sliders:** any number on a device (receiver volume, a light, a blind) becomes a slider with the remote's pop-up and the touch slider.
- **Quick menus:** pop-up lists whose choices run steps. You can build one from a device's inputs or sound modes. To step through the choices, map a button to *Select next* / *Select previous*.
- **Level pictures:** a button shows the slider's level.
  - 16 designs: bar, column, arc gauge, ring, dots, signal, speaker, knob, tank, thermometer, equalizer, segments, battery, needle, pie and steps.
  - Any color from a color wheel, and **colors by value** (e.g. red from 85 %).
  - Always shown, or only for a few seconds after a change.
- 12 tile icons for sliders and menus.

### Device states (live)
A panel beside the editor shows every value a device reports, updated live, plus every value seen so far. Click a value to use it in a condition or state icon.
- **This remote** shows the screen and button brightness, sound, haptics, timeouts, the integration's own controls and the **battery** (level, charging, on the charger, status).
- These can all be used in smart-control conditions, e.g. *battery level < 20*.
- Devices are grouped by integration.

### Return ↩
- Per-activity ↩ buttons with your own picture and an optional physical button.
- **Turn off when leaving** sends a plain "turn off" to a device page when you leave it. It no longer uses activity groups.
- The integration now follows the remote's own events, so going back with ↩ to an activity that is still running is seen.
- ↩ buttons never change a page's grid any more.

### Backup and restore
**Backup** (top right in the builder) saves one `.json` file with smart controls, sliders and quick menus, state icons and level pictures, ↩ buttons and Controls, **including the custom pictures**, but not the login.
- Restore lets you pick the parts.
- Every part is checked before anything changes, and missing pictures are uploaded again.

### Fixes and limits
- **Editing an item that is already used on an activity no longer breaks it.** Saved ids stay fixed, and the remote gets the new definition right away.
- Higher limits:
  - 60 smart controls (12 branches, 24 steps, 60 s waits)
  - 60 state icons watching up to 25 devices
  - 30 sliders, menus and Controls
- The State icons tab shows how long each check takes on your remote.
- New builder layout: **+ Create** per tab, saved items as bars with **Edit**, and ids locked once saved.

Full list in the README's [Changes](https://github.com/Sat32blk/uc-remote-self-control#changes).
