**Beta.** Back up your remote's configuration in the web configurator before installing. If you already use the integration, also save a **Backup** in its builder first.

**Install:** web configurator → Integrations → Add new → Install custom → `uc-intg-self-control-0.8.7.tar.gz`. To update, tick **Update existing driver**.

## New in 0.8.5 – 0.8.7: Smart Launchers (beta)
One button that opens the activity your conditions pick, e.g. *if the Shield is on → Watch ShieldTV, otherwise → Watch RokuTV*. It can also run extra steps after that activity starts (optional).
- New builder tab **Smart Launchers**: activities, if / otherwise branches, optional extra steps (with a wait before them).
- Put the launcher on an activity page, a physical button or the home screen, from the builder or in the web configurator.
- **How it works:** the remote only switches to an activity's screen when the button you press starts that activity directly, so the launcher decides before the press. For each of its activities the integration keeps a **launcher copy** (same devices, pages and buttons, named after the launcher, extra steps at the end of its start sequence) and points the launcher's buttons at the copy your conditions pick.
  - The copies follow their original within about a minute: edit the original, not the copy.
  - They're in the same activity groups as their original. As for any activity, the remote skips the power-on steps of devices that are already on.
  - ↩, start pages, state icons and Controls treat a copy as its original.
  - A button on a page of the activity on screen is re-pointed when you leave it; physical buttons and home tiles change at once.
- **This feature creates activities on your remote.** Removing a launcher, or **Remove everything**, points its buttons back at the original activity and deletes the copies. Launchers are part of the backup.

## Everything else since 0.5.0

### Page jumps
The remote has no "go to page" command. The integration gets the same result by turning an activity's page order around: your swipe order stays the same and just starts at another page. Your own order comes back when you leave the activity.
- **Go to page**, a step for smart controls and quick menus:
  - jump to a page of the activity you're in, e.g. "if the Shield is playing → Apps, otherwise → Remote";
  - or set the page another activity opens on next time.
- **Start pages:** per activity, *if* conditions → open on a page, *otherwise* another page. It's in the **Return & Pages ↩** tab, with the Device states panel beside it.

### Controls
Point the volume rocker and the Remote 3 touch slider at something else for a moment, with the remote's own volume pop-up: a light, a tone control, the screen or backlight brightness, or one of your sliders (including IR up/down).
- One **Control: \<name\>** switch per control.
- A **Control Active** sensor.
- A timeout, or stay on until changed.
- Per activity, what the rocker and slider do when no control is on.
- Optional **borrow**: keeps the rocker on your TV until a control is on.
- **Reset the value** for devices that don't report their level.

### Sliders, quick menus and level pictures
- **Sliders** for any number on a device, using the remote's slider pop-up and the touch slider.
- **Quick menus** whose choices run steps (inputs, sound modes, scenes).
- **Level pictures:** a button shows the slider's level.
  - 16 designs: bar, column, arc gauge, ring, dots, signal, speaker, knob, tank, thermometer, equalizer, segments, battery, needle, pie and steps.
  - Any color from a color wheel, and **colors by value** (e.g. red from 85 %).
- 12 tile icons.

### Device states (live)
- See every value a device reports, including **This remote**: its settings, the integration's controls and its **battery** (level, charging, on the charger, status).
- Click a value to put it into a condition or a state icon.
- Battery and settings work as conditions, e.g. *battery level < 20*.

### Return ↩
- Per-activity ↩ buttons, with your own picture and an optional physical button.
- **Turn off when leaving** sends a plain "turn off" to a device page you leave.
- The integration follows the remote's own events, so going back to an activity that is still running is seen.

### Backup, restore and removal
- **Backup** saves everything you set up, including its pictures (never the login), in one file. **Restore** lets you pick the parts.
- **Remove everything**, for before you uninstall, puts back what the integration changed:
  - state icons go back to the buttons' own looks;
  - ↩ buttons are removed;
  - page orders are restored;
  - borrowed volume keys and quick-menu buttons are given back;
  - optionally its pictures and its access key are deleted too.

### Safety and fixes
- State icons and level pictures write each page at most every 5 seconds.
- If you changed a page yourself (e.g. in the web configurator), its state icons pause instead of overwriting it. Save them again to resume.
- A counter shows how many changes the integration made to the remote in the last hour.
- Editing an item that is already used on an activity no longer breaks it: saved ids stay fixed.
- The remote reports the integration's own page changes as if an activity was opened. These are now ignored, so ↩ no longer goes to the wrong activity.
- A Go to page step for a page the current activity doesn't have is skipped instead of stopping the smart control.
- Higher limits: 60 smart controls, 60 state icons (up to 25 watched devices), and 30 sliders, menus and Controls.

Full list in the README's [Changes](https://github.com/Sat32blk/uc-remote-self-control#changes). Community project, not affiliated with Unfolded Circle.
