# Remote Self-Control

[![test](https://github.com/Sat32blk/uc-remote-self-control/actions/workflows/test.yml/badge.svg)](https://github.com/Sat32blk/uc-remote-self-control/actions/workflows/test.yml)

A custom integration for the **Unfolded Circle Remote 3** (and Remote Two) that runs on the remote itself. It started as a way to change the button backlight and the screen brightness from a button or a macro. It has grown into a second way to set up your remote: a **Page Editor** that edits activities, pages, buttons, sequences, macros, the home screen and devices on a picture of your remote, plus things the remote can't do on its own, like buttons with if / else logic, icons that follow a device's state, sliders for any number, and a ↩ button back to the previous activity.

Everything runs on the remote and is set up in a browser page the integration serves itself: no PC, server or cloud needed.

![The Page Editor: pictures on the left, the remote in the middle, what the selected button does on the right](docs/images/page-editor.png)

> [!WARNING]
> **Back up your remote's configuration in the web configurator before installing.** The integration changes your remote's settings, activities, pages, button mappings and more. The Page Editor keeps a copy of your activities, macros and home screen before its first change of a visit, but that's not a full backup. Tested on one Remote 3 so far.

> Community project, not affiliated with Unfolded Circle. MIT licensed. It works through the remote's local Core REST API.

## Contents

- [Features](#features)
  - [Page Editor](#page-editor): [activities and pages](#activities-and-pages) · [start and stop, with a guided setup](#start-and-stop-with-a-guided-setup) · [activity groups](#activity-groups) · [home screen](#home-screen) · [macros](#macros) · [devices, integrations and app links](#devices-integrations-and-app-links) · [themes](#themes) · [safe saving](#safe-saving)
  - [Smart Controls](#smart-controls) · [State icons](#state-icons) · [Sliders, quick menus and level pictures](#sliders-quick-menus-and-level-pictures) · [Controls](#controls) · [Return ↩ and page jumps](#return--and-page-jumps) · [Smart Launchers](#smart-launchers) · [Displays](#displays) · [Auto Widgets](#auto-widgets) · [Guided tours](#guided-tours) · [Statistics](#statistics) · [Image Fusionner tiles](#image-fusionner-tiles) · [The remote's own settings](#the-remotes-own-settings) · [Device states](#device-states) · [Backup, restore and Integration Manager](#backup-restore-and-integration-manager)
- [Install](#install)
- [The builder](#the-builder) · [Entities](#entities) · [Rules reference](#rules-reference)
- [Security](#security) · [Configuration](#configuration) · [Logs and removal](#logs-and-removal) · [Development](#development) · [Changes](#changes) · [Support](#support)

## Features

### Page Editor

The builder's first tab shows your Remote 3 or Remote Two (picked from the remote's model number) and lets you edit what's on it. Nothing is written until you press a save button, and the integration keeps a copy of your activities, macros and home screen from before the first change of each visit (**Last copy before changes** downloads it). It isn't a full remote backup: the remote stops every integration while it makes one, so make that in the web configurator.

#### Activities and pages

- **Drag and drop.** The **Pictures** window sits beside the remote, as tall as it, with as many pictures per row as the page has columns; long lists scroll inside it. Pick **Icons on the remote**, **Built-in icons** (the remote's own, drawn as on the remote), **Channel icons**, **Level pictures & state icons** (the ones this integration made) or **Local folder** (pictures on your computer, shrunk and uploaded when you save).
- **Widgets:** text button, sensor, select, media widget and number pad.
- **What it does:** click a button and pick a device (the activity's own come first), then its command, or search with a few words (*shield movies*). **Custom value** sends a typed value such as an app link; **Not added yet** adds a device your integrations offer straight from there.
- **Physical keys and the touch slider:** click them on the drawing to set short and long presses.
- **Pages:** add, rename, change the grid, move, delete. **Activities:** rename, duplicate, delete or make a new one; activity group, prevent sleep and voice assistant.

![What it does: the SHIELD's commands, including app links, for the selected button](docs/images/page-editor-what-it-does.png)

<img src="docs/images/page-editor-built-in-icons.png" alt="Built-in icons in the Pictures window, next to the remote's screen" width="640">

#### Start and stop, with a guided setup

The start and off sequences with readiness check and what happens when a command fails, and the devices in the activity.

When you give a button a command of a device that isn't in the sequences yet (or use **+ Add a device…**), a short setup asks what kind of device it is (display, AV receiver, streaming device, amp / subwoofer, Home Assistant, other), then a few questions for that kind (input, app, turn off at the end). Its steps go into the sequences in signal-flow order with recommended waits, and your other steps aren't moved:

- **on:** display → 1.5 s → sources → 2 s → receiver + input → 3 s → amps
- **off:** amps → 1 s → receiver → 1 s → display → 0.5 s → sources

![Start and off sequences](docs/images/page-editor-start-stop.png)

| What kind of device is it? | Then a few questions for that kind |
|---|---|
| <img src="docs/images/page-editor-guided-setup.png" alt="Guided setup, step 1" width="480"> | <img src="docs/images/page-editor-guided-setup-2.png" alt="Guided setup, step 2" width="480"> |

#### Activity groups

What switching between activities of a group turns off, as one plain sentence, with the steps and a grid of every switch in the group.

![Activity groups](docs/images/page-editor-activity-groups.png)

#### Home screen

Your home pages with their tiles and background pictures (the remote's own, or one from your computer). Drag activities, devices and groups into a page.

![Home screen](docs/images/page-editor-home-screen.png)

#### Macros

Steps with a check that each device answers, duplicate, delete (it says where the macro is used first) and **Try it now**.

![Macros](docs/images/page-editor-macros.png)

#### Devices, integrations and app links

Per integration: what's on the remote and what it offers to add (**Add** adds it at once), remove, rename, enable / disable and reconnect. **+ Add an integration** opens [Integration Manager](https://github.com/JackJPowell/uc-intg-manager) if you have it, otherwise the web configurator.

**App links** (Android TV): load a text file with one `market://launch?id=… = Name` per line. The apps show by name in What it does, the sequences and the guided setup ("select source · Tivimate"), and buttons that already use a link show its name. Apps the device already lists aren't added twice. Since a Google Play Store change, `market://launch?id=…` links no longer open apps on Android TV; put the app's own deep link in the file instead (for example `https://www.paramountplus.com/ = Paramount+`). You can find an app's deep link with `adb shell cmd package dump <package>` (under *Schemes*), or in the [Home Assistant deep-link guide](https://community.home-assistant.io/t/android-tv-remote-app-links-deep-linking-guide/567921).

![Devices and integrations, with app links](docs/images/page-editor-devices.png)

#### Themes

A **Theme** picker for the whole builder: Automatic, Desktop, Dark mode, Remote style, Midnight blue, High contrast.

![Dark mode, Remote style and Midnight blue](docs/images/page-editor-themes.png)

#### Safe saving

- **Pages are read again before saving.** A button you didn't touch keeps what the remote has now, so a picture the integration (state icons, level pictures) or the web configurator changed meanwhile isn't overwritten. Only changed pages, keys and settings are written.
- **The activity on the remote's screen** is saved once you leave it (changing a page you're looking at would jump to page 1); **Save pages now anyway** doesn't wait.
- If a picture from your computer can't be uploaded, nothing is saved.
- Activities made by an integration, and Smart Launcher copies, are locked (🔒).
- The editor reaches the remote only through the builder's login, and only for what it needs: API keys, system commands (reboot, update, power), the remote's settings and deleting whole collections are refused.

### Smart Controls

Buttons with **if / else if / otherwise** logic, built by picking from your own devices, activities and the remote's settings: "if the receiver is on, turn *it* up, otherwise the TV". Conditions on device states, the activity that's on, the time, the remote's settings and battery, and remembered values. Steps can run commands (IR too), wait, **wait until** a device is ready, remember and restore settings, and **jump to a page**. Templates for Night Mode, Quiet Mode, smart volume, input with wait and more; **Test** runs one on the remote and shows what it did. A new install has no Smart Controls: start from a template.

![A Smart Control in the builder](docs/images/builder-overview.png)

### State icons

A button on a page that changes its picture or label with a device's state, like a green power icon while the receiver is on. Pick the button on a drawing of the page, drop in a picture per state.

<p align="center"><img src="docs/images/state-icon-demo.gif" alt="State icon: the power button turns green when the receiver is on" width="300"></p>

### Sliders, quick menus and level pictures

- **Sliders:** any number on a device (receiver volume, a light, a blind, even IR up / down) as a slider with the remote's own slider pop-up and the Remote 3 touch slider.
- **Quick menus:** a pop-up list whose choices run steps: inputs, sound modes, scenes. Build one from a device's input list in one click.
- **Level pictures:** a button that shows a level in 16 designs (bar, arc gauge, battery, needle, …), in any color, changing color with the value, always or only for a few seconds after it changes. 12 tile icons for sliders and menus.


![The 16 level pictures, colors by value and the 12 tile icons](docs/images/slider-graphics.png)

### Controls

Press a switch and the volume rocker and touch slider change something else for a moment (a light, a tone control, the screen or backlight brightness, one of your sliders), with the remote's own volume pop-up. Per activity, what they do when no control is on; optionally **borrow** the rocker from your TV only while a control is on.

![Controls with the remote's own pop-up, and a level picture on a button (illustration)](docs/images/remote-controls.png)

### Return ↩ and page jumps

- **↩ Return to the previous activity:** an on-screen button (text, arrow or your own picture) and/or a physical button that always takes you back to the activity you came from, optionally turning off the one you leave.
- **Go to page:** a step that jumps to a page of the activity you're in, with logic ("if the Shield is playing → Apps, otherwise → Remote"). **Start pages:** per activity, the page it opens on depending on your devices.

![The ↩ button and a Smart Controls page on the remote (illustration)](docs/images/remote-screens.png)

### Smart Launchers

One button (on a page, a physical button or the home screen) that opens the activity your conditions pick: *if the Shield is on → Watch ShieldTV, otherwise → Watch RokuTV*, optionally with extra steps once it has started.

### Displays

Text on a page that updates by itself: each display is its own sensor entity, shown with the Page Editor's sensor widget. It has a **default** (a device's value, one of your sliders, the remote's battery, the time, the activity on screen, or messages one after another) with text before and after it, symbols, emoji and the remote's own icons. **Temporary changes** take over for a few seconds or while something is true: when a value changes or goes above / below a number, while a Control is on, or when an activity starts. Values can show as a number or as a **bar** (◼◼◼◻◻ 60 %). A smart control step **Show on a display** puts up messages ("Ding dong | at the door"). The preview shows it on a remote screen at the widget's size and page grid.

![A display sensor in the builder with its preview](docs/images/builder-displays.png)

### Auto Widgets

Widgets on an activity's page that change by themselves, set up in **Icons & Sliders → Auto Widgets** with the same **If / Else if / Otherwise** conditions as Smart Controls (branches are checked top to bottom and can be moved up and down). How they work depends on the activity, because the remote jumps back to page 1 when a page of a multi-page activity changes:

- **One-page activity: widget spots.** A spot places your devices' **real widgets** (a media widget, a select, a sensor, also your Displays) on the page, each at its own place and size, over your icons if you like: *while Plex plays, the Plex media widget over the bottom rows; while the Shield is on the Plex app, a bigger one at the top; otherwise your icons*. The page is redrawn in place when the rule in use changes, and your icons come back when nothing is placed. Buttons, browsing and search go straight to the device. When two spots would land on the same place, the one higher in the list wins. Changes you make to the page meanwhile (Page Editor or web configurator) are kept.
- **Activity with several pages: Smart widgets.** A **Smart Media Widget**, **Smart Select** or **Smart Sensor** is one of this integration's own entities, placed once on an empty spot. It shows whichever device the rules pick: its title, artwork and state, and its buttons (and for a media widget, browsing and search) go to that device.

**Pop-ups:** a branch can be shown **while it's true**, or only **for a few seconds** (1–60): when its conditions become true (*the Roku starts playing → its media widget for 8 s*), or each time a value changes while they're true (*the receiver's input changes → its input select for 5 s, and a new change starts the 5 s again*). Then it goes away again: a spot gives the place back to your icons, a Smart widget goes back to the branches below.

Saving does the setup on the remote for you: Smart widgets are added to the remote and the activity and placed on their page, and the devices a spot shows are added to the activity. Each widget's card shows a preview of the page (with the widgets above it, so overlaps are visible), which branch is in use now, a ✓ / ✗ per condition, and the rule in words; the Device states panel marks the values your conditions check.

### Guided tours

Every tab and section of the builder and every part of the Page Editor has a **▶ Show me how** tour: the page dims except for one part at a time, and a bubble explains it. Click into the highlighted part to try it: the tour waits, and the button turns into **▶ Continue** to go on. Steps that need something done on the remote (adding a new smart control, menu, slider, display or Control switch to the integration and an activity) stand out with **📱 On your remote · needed** and a checklist, and the end of the tour reminds you. The first time you open a section, its tour **offers itself** once (Not now / Don't offer tours). A tour that opens an empty item to show it (a new smart control, say) removes it at the end unless you typed into it.

### Statistics

Which activities you use, for how long and when, screen-on time, and the battery each one uses while off the dock, with the battery level over the last week and how long a charge lasts. It also records **which app** a SHIELD, Roku or other player shows during an activity (Netflix, YouTube…), how long, and the **battery used per app**. Collected on the remote while the integration runs, with CSV download.

### Image Fusionner tiles

For people who make their button pictures with Image Fusionner (a tool that cuts a background into tiles and decorates them from a layout file): set its folder in **⚙ Settings**, and the Pictures window shows its rendered tiles, one folder per layout with its grid. Click or drag a tile onto a button, or on an empty page with the same grid use **＋ Add to page** to put every tile on its own spot. **↻ Reload tiles** after a render picks up new layouts and drops deleted ones. A web page can't read a typed path, so your browser asks once to allow the folder; the tiles stay in that browser.

### The remote's own settings

Button backlight level and color, display brightness and timeout, auto brightness, sleep timeout, wake sensitivity, Wake on LAN, sound effects and volume, and haptics, as entities you can use in activities, macros, pages, buttons and on the touch slider. See [Entities](#entities).

### Device states

A live panel with every value your devices (and the remote itself, battery included) report, with all values seen so far. Click a value to put it into a condition, a state icon or a slider.

### Backup, restore and Integration Manager

- **Builder → Backup:** one file with everything you set up, plus the pictures it uses. Restore picks the parts and checks them all before changing anything.
- **Reconfigure → Back up settings / Restore settings from a backup:** the same settings as text. [Integration Manager](https://github.com/JackJPowell/uc-intg-manager)'s **Backup Config** uses this, so it can keep your settings with its other backups.
- **Remove everything** puts back what the integration changed on your remote before you uninstall it.


## Install

1. **Back up your remote** in the web configurator and download the backup.
2. Install the integration:
   - with [Integration Manager](https://github.com/JackJPowell/uc-intg-manager): find **Remote Self-Control** in its list of available integrations (once it has been added there) and install it; or
   - download `uc-intg-self-control-<version>.tar.gz` from the [latest release](https://github.com/Sat32blk/uc-remote-self-control/releases/latest), then web configurator → **Integrations → Add new → Install custom** → choose the file.
3. Start the setup for **Remote Self-Control**. The first screen is information only. On the second, enter the **web-configurator PIN** and leave the address at `127.0.0.1`.
   - The integration uses the PIN once to create an API key named "Self-Control <date>" and stores only that key.
   - If setup fails with a connection error, run it again with the remote's own IP address.
4. Open the builder at `http://<remote-name>.local:10123/` (the exact address is in Integrations → Remote Self-Control → Configure) and log in with the same PIN. The **Page Editor** opens first.
5. For the remote settings, Smart Controls, sliders and so on: add the entities you want to the integration, then use them in activities, macros or pages.

To update, first save a **Backup** in the builder, then use Install custom with **Update existing driver** checked (or update in Integration Manager). Your settings are kept. No restart of the remote is needed.

## The builder

The integration serves its own builder page on your network, at `http://<remote-name>.local:10123/` or `http://<remote-ip>:10123/`. The exact addresses are shown in Integrations → Remote Self-Control → Configure.

<img src="docs/images/builder-login.png" alt="Builder login" width="640">

- **Log in** with the web-configurator PIN.
- **Pick, don't type:** the builder lists your remote's own devices with their commands, inputs and sound modes, your activities, and the remote's own controls and settings.
- **If / Else if / Otherwise** branches, each with conditions and steps. The first matching branch runs.
- **Templates** for the remote itself (Night Mode, Quiet Mode, color cycle, brighter/dimmer, backlight by time) and for your devices (smart volume, play/pause or turn on, input with wait, sound mode cycle, action per activity).
- **Create, then list:** each tab starts with its **+ Create** button. It opens an editor box for the new item; a **name is required**. After **Save**, the item shows below as one bar with its name, what it does and an **Edit** button that opens its settings again (with **Delete** inside).
- **Save** writes to the remote (everything is checked first; errors are listed in the editor). **Save & test** runs a smart control once and shows the result.
- **Device states (live)** (Smart Controls and Icons & Sliders tabs): pick a device and see every value its integration reports, updated every 2 seconds, with all values seen so far. Tick *Keep collecting in the background* to gather values that only show up now and then (an audio format, an app name). It sits to the right of the editor. Click a value field in the editor, then a value in the panel to fill it in (a condition also gets that device and attribute); in a state icon a clicked value is added as a state, and *use* points a slider at a number. Values seen are also offered in the value lists of state icons and conditions.
- **Backup** (top right) saves and restores everything you set up, with its pictures. **Rules text** exports and imports the smart controls alone as JSON, for sharing.
- **▶ Show me how** (right of each section bar): a guided tour of that section, see [Guided tours](#guided-tours).
- **⚙ Settings** (top right): the Image Fusionner folder, if you use it.
- **Theme** (top right): Automatic (follows your system), Desktop, Dark mode, Remote style, Midnight blue or High contrast, for every tab including the Page Editor.
- Works on phones and in dark mode, and needs no internet: everything is served by the remote.

| Dark mode | Phone |
|---|---|
| <img src="docs/images/builder-dark.png" alt="Dark mode" width="420"> | <img src="docs/images/builder-phone.png" alt="Phone" width="220"> |

After saving, add new controls to the integration (Integrations → Remote Self-Control → add entities) and to the activities that use them. Smart Controls run in the background, so they can't switch the remote's screen to another activity (use the ↩ button for that).

Without a browser, the same JSON can be pasted in the integration's setup screen (*Edit Smart Controls (text)*).

### Examples

- `examples/remote-only-rules.json`: Night Mode, Quiet Mode, color cycle, brighter/dimmer. Works on any remote.
- `examples/shield-tv-receiver-rules.json`: device rules for an NVIDIA Shield, a Samsung TV and a Marantz receiver (smart volume, play/pause, input with wait, sound mode cycle). Replace the `YOUR_…_ID` placeholders in `aliases` with your own entity ids, or rebuild them from the builder's templates.

## Entities

Grouped by area in the web configurator.

| Group | Entity | Type | What it controls |
|---|---|---|---|
| **Remote Display** | Display Brightness Level | select | 10 % … 100 % (turns display auto brightness off) |
| | Display Brightness | light | brightness for the **touch slider**; off = dimmest |
| | Display Timeout | select | 5 s … 60 s |
| | Display Auto Brightness | switch | display follows the light sensor |
| **Remote Buttons** | Button Backlight Level | select | Off, 10 % … 100 % |
| | Button Backlight Color | select | 12 presets (Warm white … Cool white) |
| | Button Backlight | light | on/off, brightness, color |
| | Button Backlight Auto | switch | backlight turns on by itself in a dark room |
| **Remote Settings** | Sound Effects Volume | select | 0 % … 100 % |
| | Wake Sensitivity | select | Off, Low, Medium, High |
| | Sleep Timeout | select | 1 min … 3 h, Never |
| | Wake on LAN | switch | Wi-Fi wake |
| | Sound Effects | switch | on/off |
| | Haptic Feedback | switch | on/off |
| **Remote Navigation** | Previous Activity | sensor | name of the activity used before the current one |
| **Remote Controls** | Control | media player | volume rocker / touch slider target; its volume is the level being changed |
| | Control Level | light | the same level as a light (touch slider set to a light, home tile pop-up) |
| | Control Active | sensor | "Ceiling Light · 60 %" or "None" |
| | Control: (your control) | switch | turns that control on (and any other off) |
| *(builder)* | State icons | page buttons | icon/label follows a device's state (single-page activities) |
| **Remote Sliders & Menus** | (your sliders) | light | slider pop-up / touch slider for a number on a device |
| | (your quick menus) | select | list pop-up; each choice runs steps |
| **Remote Displays** | (your displays) | sensor | text for a sensor widget on a page: a value, a bar, the time or messages |
| **Remote Auto Widgets** | (your Smart widgets) | media player, select or sensor | shows the device your Auto Widgets rules pick; added and placed when you save |
| **Remote Smart Controls** | (your Smart Controls) | button | press to run |
| | Smart Controls: Last Result | sensor | what the last Smart Control did, or its error |

Tips:

- In macros, activities and UI buttons, prefer the **select** entities ("Select option"). The remote's editor passes the light's "brightness %" and "color" commands through unconverted, so they are unreliable there.
- A UI button's entity must also be in that activity's devices, otherwise the web configurator says "Invalid request. Check your input."
- The web configurator doesn't list **sensor** entities when you edit an activity. Use *Configure → Add the Last Result tile to an activity* for the Last Result tile; the ↩ button already shows the previous activity's name.

## Rules reference

```json
{
  "aliases": { "receiver": "uc_denon_driver.main.media_player.YOUR_RECEIVER_ID" },
  "buttons": [
    {
      "id": "smart_volume_up",
      "name": "Smart Volume Up",
      "cases": [
        { "if": { "entity": "receiver", "is": "ON" },
          "do": [ { "cmd": "media_player.volume_up", "entity": "receiver" } ] },
        { "else": [ { "cmd": "media_player.volume_up", "entity": "samsungtv_driver.main.media_player.YOUR_TV_ID" } ] }
      ]
    }
  ]
}
```

| Condition | Example |
|---|---|
| Device | `{ "entity": "tv", "attr": "source", "is": "HDMI2" }` (`is`, `is_not`, `in`, `not_in`, `>`, `<`, `>=`, `<=`, `contains`) |
| Activity | `{ "activity_on": "<activity id>" }` |
| Time | `{ "time_between": ["22:00", "06:00"] }` |
| This remote's control | `{ "control": "backlight_color", "is": "Movie red" }` |
| This remote's setting | `{ "setting": "display.brightness", ">": 50 }`, `{ "setting": "battery.level", "<": 20 }`, `{ "setting": "battery.charging", "is": true }` |
| Memory | `{ "var": "night_mode", "is": "on" }` |
| Combine | `{ "all": [ … ] }`, `{ "any": [ … ] }`, `{ "not": … }` |

| Step | Example |
|---|---|
| Device command | `{ "cmd": "media_player.select_source", "entity": "receiver", "params": { "source": "SHIELD" } }` |
| IR / simple command | `{ "cmd": "DIMMER", "entity": "receiver" }` |
| This remote's control | `{ "self": "display_level", "option": "up" }`, `{ "self": "haptic", "state": "toggle" }` |
| Wait | `{ "delay": 500 }` |
| Wait until | `{ "wait_until": { "entity": "receiver", "is": "ON" }, "timeout": 10000 }` |
| Memory | `{ "set_var": "night_mode", "to": "on" }` |
| Remember / restore settings | `{ "save_settings": "before" }`, `{ "restore_settings": "before" }` |
| Go to page | `{ "page": "Apps" }` (activity on screen; a name, page id or `"#2"`), `{ "page": "Apps", "activity": "<activity id>" }` |
| Stop | `{ "stop": true }` |

For lists, `option` can also be `next` / `previous` (wraps around) or `up` / `down` (stops at the ends). The short form `{ "id", "name", "if", "do", "else" }` works too. Limits: 60 smart controls, 12 branches each, 24 steps per branch, pauses and waits up to 60 s; 60 state icons watching up to 25 devices; 30 sliders, quick menus (30 choices each) and Controls. A press while the same control is still running is ignored.

## Security

- The builder requires the web-configurator PIN. The PIN is checked against the remote and never stored. A session lasts 12 hours (HttpOnly, SameSite=Strict cookie).
- After 5 wrong PINs from one address, logins are blocked for 5 minutes.
- The builder is plain HTTP on your local network, like the web configurator itself. Don't forward port 10123 to the internet.
- The **Page Editor** reaches the remote's API through the builder (same login). It only lets through what the editor needs: activities, activity groups, macros, the home screen, pictures, entities and integrations. API keys, system commands (reboot, update, power), the remote's settings and deleting whole collections are refused. Its remote backups stay on the remote (newest two).
- The integration holds an admin API key for the remote. Removing the integration does not revoke it: list keys with `GET /api/auth/api_keys` and delete with `DELETE /api/auth/api_keys/{id}`.

## Configuration

| Environment variable | Default | Purpose |
|---|---|---|
| `UC_SELF_BUILDER_PORT` | `10123` | Port of the builder page |
| `UC_SELF_RETURN_POLL_MS` | `2000` | How often activity states (↩ button), state-icon devices, slider values and menu conditions are read |
| `UC_SELF_SLIDER_HOLD_MS` | `3000` | After you move a slider, device reports are ignored this long so a slow device can't jump it back |

Files in the integration's config folder: `self_control.json` (address + API key), `smart_rules.json` (your rules; absent = defaults), `smart_vars.json` (remembered values), `return.json` (↩ settings and activity history), `state_icons.json` (state icons and each button's default look), `sliders_menus.json` (sliders, quick menus and their last values), `controls.json` (Controls), `states_seen.json` (values seen in the device states panel). The Page Editor adds `app_links.json` (Android TV app links) and keeps its remote backups on the remote (the newest two). The builder's **Backup** saves all of these except the login and the caches.

Each file is saved safely: the integration writes a new copy and then swaps it in, so a file is never half-written if the hub or remote loses power. The version before the last save is kept as `<name>.bak`, and a file that can't be read is loaded from its `.bak` instead (the log says so). If neither works, the damaged file is kept as `<name>.damaged-<time>` before anything new is saved.

## Logs and removal

- Logs: web configurator → Settings → Development → Logs (lines start with `[self-control]`).
- Remove: in the builder, **Backup** → download a backup, then **Remove everything** (tick both options to also delete its pictures and its API key). Then delete the integration instance and the driver. The *Smart Controls* page with the Last Result tile (if you added it) stays until you delete it.

## Development

```
src/driver.json                         metadata and first setup screen
src/bin/driver.js                       entities, commands, setup flow, polling
src/bin/core.js                         REST client for the remote's Core API; keeps device values, kept current by the events
src/bin/settings.js                     the remote's settings as selects and switches, color presets
src/bin/setup-pages.js                  setup flow pages (PIN, Smart Controls as JSON)
src/bin/safefile.js                     safe saving: write and swap, .bak copies, batched saves
src/bin/smart.js                        Smart Controls: validation and engine
src/bin/web.js                          builder web server and device catalog
src/bin/web/builder.html                builder page (no external files; works offline)
src/bin/web/editor.html                 Page Editor (shown in the builder's first tab)
src/bin/editor.js                       Page Editor: Core API pass-through (allow list), pictures, remote backups
src/bin/tile.js                         puts the Last Result tile on an activity page
src/bin/returnbtn.js                    return to previous activity (tracking + ↩ buttons)
src/bin/stateicons.js                   state icons (watch devices, switch button looks)
src/bin/extras.js                       virtual sliders and quick menus
src/bin/controls.js                     Controls (volume rocker / touch slider for other things)
src/bin/states.js                       device states panel (live values, values seen)
src/bin/coreevents.js                   the remote's own events (which activity was opened, every device change)
src/bin/backup.js                       backup and restore
src/bin/pages.js                        page jumps and start pages
src/bin/default-rules.json              default Smart Controls (none)
examples/                               example rules
test/                                   fake Core API + Integration-API test client
```

Tests (Node 22):

```
npm install                 # dev dependency: ws
(cd src/bin && npm install)
npm test                    # every test, 4 at a time (TEST_JOBS=n to change; npm run test:serial for one at a time)
node test/run-all.js smart  # only the tests whose file name contains "smart"
```

Build the install archive:

```
./build.sh                  # -> dist/uc-intg-self-control-<version>.tar.gz
```

Built on the [Integration API](https://github.com/unfoldedcircle/integration-node-library) and the [Core REST API](https://github.com/unfoldedcircle/core-api) by Unfolded Circle.

## Changes

- **1.4.7:** Faster and lighter on the remote. The integration now keeps the device values it reads in memory, and the remote's live events keep them current. So Auto Widgets, Displays, state icons, sliders and Smart Controls conditions no longer ask the remote for every device every second or two; they react as soon as the remote reports a change, with a check every 20 s. Settings files are saved safely, with a `.bak` copy that is used if a file is damaged ([details](#configuration)). Remembered values, ↩ history and values seen are saved once every 2 s at most instead of on every change. Developers: `driver.js` is split up a little, and the tests run 4 at a time (about 50 s instead of over 2 min).
- **1.4.6:** The full 1.4.5 release below, with Auto Widgets pop-ups. The 1.4.5 download on GitHub was an earlier build without pop-ups, so install 1.4.6 instead.
- **1.4.5:** **[Auto Widgets](#auto-widgets)** (Icons & Sliders → Auto Widgets): widget spots that place your devices' real widgets on one-page activities by rules, and Smart widgets (Smart Media Widget, Smart Select, Smart Sensor) that show the device the rules pick on activities with several pages; the Smart Controls conditions, branches you can move up and down, **pop-ups** (a branch shown only for a few seconds when it becomes true or each time a value changes), a live preview per widget, ✓ / ✗ per condition (also in the Device states panel), and saving adds and places everything on the remote. **[Guided tours](#guided-tours)** for every builder section and every part of the Page Editor (**▶ Show me how**; click to try, **▶ Continue** to go on), with the steps to do on the remote highlighted, offered once the first time you open a section. A **new install** offers 20 entities: the **Smart Test Button** demo is gone (start from a template, e.g. *Backlight Color Cycle*), the builder's *Load the defaults* button is gone, and the setup menu's reset is now **Remove all Smart Controls**. (Test builds 1.3.7-autotest and 1.3.7-aw1 to aw9.)
- **1.3.6:** **Image Fusionner** tiles in the Pictures window (for [Image Fusionner](#image-fusionner-tiles) users). **⚙ Settings** (top right) takes the Image_Fusionner folder; **Browse…** reads the tiles it has rendered into this browser (the browser asks you to allow the folder), and **↻ Reload tiles** reads them again after a render: layouts deleted from `Grid_layout` drop out, new ones appear, and only that one folder is read. The Pictures window (Page Editor and every tab that takes pictures) then shows one folder per layout with its grid (e.g. 4 × 6 tiles), as many across as your page is wide, with search and **Close all**. Click or drag a tile to use it; on an empty page with the same grid, **＋ Add to page** puts every tile on its own spot. Tiles are uploaded under their name plus a short fingerprint (`…_v1vp99lo.png`), because the remote never replaces a picture of the same name, so a re-rendered tile is never shown as its old copy. (Test builds 1.3.2-image-fusionner to 1.3.6-fusionner; the remote refuses a driver version over 20 characters, which a test now checks.)
- **1.3.2:** Displays: the **widget size** is any width × height in tiles, and the preview's menu picks the **page grid** (2 × 3, 4 × 6, 6 × 9 or 8 × 12 tiles); the character count follows both. The preview shows the default; **Preview** on a temporary change plays it for as long as it would show. Statistics: **battery per app**: the battery used while each app shows during an activity (off the dock) is recorded, under Battery ("Battery used per app", %/h with how reliable it is), in Apps per activity (off the dock, %/h) and in the CSV.
- **1.3.1:** Displays: a **preview** beside the editor (the display on a remote screen at its widget size: on the remote now, the default, or any temporary change, with messages and scrolling playing); this integration's own entities (Remote Self-Control (made here)) can be shown too; the **Remote icons** in the ☺ picker show (they were white on white). **Statistics: apps** — the app a SHIELD, Roku or other player shows during an activity (its source, e.g. Netflix, YouTube) is recorded: "Apps used" on the overview, "Apps per activity" and the apps of each use under Activities, and in the CSV. TV inputs (HDMI…) and receivers aren't counted. The Statistics tab no longer stays on "Loading…" after a failed or slow read (it says so, with Try again).
- **1.3.0:** **Display sensors** (Icons & Sliders → Displays). Each display is its own sensor entity that shows text on a page (the Page Editor's sensor widget) and updates at once, without rewriting the page:
  - a **default**: a device's value, one of your sliders, the remote's battery or settings, the time or date, the activity on screen, or messages one after another; with **text before and after** it and a ☺ picker for symbols, emoji and the remote's own icons (only characters the remote's font has: no block characters);
  - values as they are, as a number, with a decimal, or as a **bar** (◼◻, ▪▫, 🟩⬜, 🟢⚪, 🟦⬛, ⚫⚪, [##--], ||··) with the % after it;
  - **temporary changes**: when a value changes, goes above / below a number or is a value, while a Control is on, or when an activity starts, it shows something else for a few seconds, while that's true, once through its messages or until the next change, with normal or high priority; a condition that's still true shows again when another change ends;
  - long text wraps or scrolls through on one line; templates for volume, a status line, a doorbell message and a ticker;
  - smart controls get a step **Show on a display** (messages one after another, e.g. "Ding dong | at the door").
  Devices a display uses are read every second and kept fresh by the remote's events. The Display test sensor (1.2.10–1.2.12) is gone; its results are in the project notes. The builder's tab row scrolls on a phone instead of widening the page.
- **1.2.12 (test build):** Display test round 3: each bar character on its own after a letter (A■ B□ … ), repeated characters, and emoji bars (🟩⬜, 🟢⚪, 🟦⬛, 🔵⚫), to see which ones the remote's font has.
- **1.2.11 (test build):** Display test round 2: a character ruler and wide / narrow letters (how much fits per widget size), six bar styles, a moving bar (0.3 s and 0.2 s steps) and scrolling text (one character every 0.3 s), other bar characters (▰▱, ▮▯, # and -, | and ·), three and four lines, a long paragraph and a big two-line value.
- **1.2.10 (test build):** a **Display test** sensor (area "Remote Self-Control test") that cycles through numbered lines (plain text, emoji, symbols, media symbols, arrows, shapes, bar characters, the remote's own icon font, accents, long text, two lines, a unit) every 4 s, then counts 1–20 every 0.5 s, to find out what a sensor widget on the remote can show and how quickly it redraws. It will be replaced by display sensors.
- **1.2.9:** level pictures keep up with the slider: a new **Steps** choice (11, 21, 51 or 101 pictures, so every 10 %, 5 %, 2 % or 1 %) lets single presses show, and a slider's level picture now updates the page within about 0.8 s (a quick press during the wait is shown right after it instead of being skipped).
- **1.2.8:** no more lock-up at zero: stepping down to the bottom (volume down) sends only the presses needed plus one, and a "down" at the bottom sends one more press. The whole-range re-sync now only runs when the slider is *set* to the bottom (dragged, turned off, "set to 0"), and it stops as soon as you press or move it again.
- **1.2.7:** sliders moved by smart controls respond faster: the smart control no longer waits for the device commands, so quick presses aren't ignored, and quick presses add up from where the slider is heading (3 fast "up" presses = +3).
- **1.2.6:** Smart Controls: picking one of your sliders as the device of a **Device command** step now offers **Step up**, **Step down**, **Step up 5**, **Step down 5** and **Set to a value** (instead of the light's on / off).
- **1.2.5:** a slider whose "Read the value from" is nothing (it remembers its last value) can show its level on a page too: the level picture follows the slider's own value, and updates right away when the slider moves.
- **1.2.4:** smart controls and quick menus can move your sliders: step **This remote's control → Your sliders → Slider: <name>** with *up one step*, *down one step*, *up / down 5 steps* or *set to* a value (the slider then sends the device's own commands, e.g. volume up presses). Sliders can also be checked in conditions. Map two smart controls to the volume keys for "Samsung volume up / down".
- **1.2.3:** everything this integration made (sliders, quick menus, smart controls, switches…) is listed together, sorted by kind, in its own group **Remote Self-Control (made here)**: in the device states (live) panel right after "This remote", and in the device pickers (smart controls, state icons).
- **1.2.2:** sliders that press up / down on a device that doesn't report its value: they start at the bottom, and setting the bottom presses down the whole range (and a little more), so the device really is at its lowest and the guess starts from zero again. Every move up counts from there. Can be turned off per slider.
- **1.2.1:** Smart Controls: the integration's own entities (sliders, quick menus, other smart controls, switches) can be used in steps, conditions and "wait until", listed in their own group **Remote Self-Control (made here)**. They show once they're added to the remote.
- **1.2.0:** slider **level pictures** reworked: an orange frame on the page sets the area (drag to move, drag the edges or corner to resize, e.g. 2 × 4; empty spots get a blank button), a new **Text** design ("62 %" as big as the whole area) plus Block, Thin bar, LED meter, Dial and Slider (22 designs), colours as one colour, changes at values or a **smooth blend**, a **gradient inside the picture**, an optional text label in a chosen button (62 % / 62 / the device's value), and more times to show it (only while changing, 2 s … 5 minutes, with or without restarting the time on each change).
- **1.1.0:** new **Statistics** tab: which activities you use, for how long and when (weekday × hour), screen-on time, battery used per activity while off the dock (marked reliable once there's enough data), idle drain, the battery level over the last 7 days and how long a charge lasts at your usual use. Collected by the integration on the remote while it runs (about every 20 s; a battery reading every 5 / 15 / 30 minutes, kept 30 / 90 / 365 days), with CSV download and Clear. The Page Editor is no longer marked beta.
- **1.0.10:** Page Editor **Home screen** rearranged: Pictures window | home screen groups | activities and devices. Tiles show their picture; drag a picture onto a tile (or click a picture, then the tile) to give that activity, macro or device its icon, saved with **Save home screen**. Fix: the built-in icons were missing from the Pictures window on the other tabs.
- **1.0.9:** the Pictures window on the other tabs looks like the Page Editor's: the same tiles, as many across as the page open in the Page Editor, and as wide as its window (it follows the Page Editor when that changes).
- **1.0.8:** one look for the whole builder, after the Page Editor: the same one-row header on every tab, a section bar per tab (e.g. State icons / Sliders, ↩ buttons / Start pages) with its status, and ⓘ for what the tab is for. The Page Editor's **Pictures window** now sits beside every editor that takes a picture (state icons, sliders and quick menus, ↩ buttons, Smart Launchers): click a picture box, then a picture (icons on the remote, the remote's built-in icons, level pictures & state icons, the drawn tile icons, or from your computer), or drag one onto the box. A ↩ button gets its own copy of the picture. Fixes: Page Editor built-in icons no longer turn into names after saving; Return & Pages shows the activities now / before by name.
- **1.0.7:** Page Editor: no more full remote backup before the first change. The remote stops every integration while it makes one, this one included, so it failed ("backup failed") and disconnected your devices meanwhile. Instead the integration keeps a copy of your activities (pages, keys, sequences), activity groups, macros and home screen: **Last copy before changes**. Keep making full backups in the web configurator.
- **1.0.6:** Page Editor, **Level pictures & state icons**: pictures nothing uses any more can be deleted (Select… → Delete). Ones still used by a level picture, state icon or ↩ button in the builder, or shown on a page, are kept and marked, so a level picture never loses a frame.
- **1.0.5:** Page Editor: a fifth picture list, **Level pictures & state icons**, shows the pictures this integration made (the 11 frames of each level picture, state-icon and ↩ pictures). Drag them onto the screen like any picture.
- **1.0.4:** Page Editor: a sensor, select or media widget whose device isn't on the remote any more (e.g. removed from Home Assistant) is outlined in red, and left out when its page is saved, with a note saying which one. The remote refuses to save a page that still has one ("Invalid sensor configuration").
- **1.0.3:** the 10 % screen limit from 1.0.1 is removed again (Display Brightness "off" is the dimmest level). Page Editor: built-in icons are drawn at the size of their tile in the Pictures window.
- **1.0.2:** Page Editor: the Pictures window is as tall as the remote and its pictures scroll inside it; the pictures are bigger and fill the window, with as many per row as the page has columns. App links: `market://launch?id=` links no longer open apps since a Google Play Store change; use the app's own deep link in the text file instead (see App links).
- **1.0.1:** Page Editor: an activity only counts as on the remote's screen while it is on and the remote's screen is on (asleep, docked or with every activity off, pages are saved right away; "On screen now" says so). The screen is never set below 10 % by the integration: Display Brightness "off" / toggle, its touch slider and Controls stop at 10 % instead of an unreadable 1 %.
- **1.0.0:** first 1.0 release, with everything from 0.9.0–0.9.10: the **Page Editor** (activities, pages, pictures including the remote's built-in icons, widgets, keys, start and off sequences with a guided setup, activity groups, home screen, macros, devices and integrations, Android TV app links), the theme picker, and backups with [Integration Manager](https://github.com/JackJPowell/uc-intg-manager) (from 0.8.8). New README with pictures of every part.
<details><summary>Earlier versions</summary>

- **0.9.10:** Page Editor: the Pictures window shows as many pictures per row as the page has columns, and sits beside the remote's screen (the activity and page bar runs across the top), for easy drag and drop.
- **0.9.9:** Page Editor: the remote is drawn bigger (up to 1.7× the window height; the page scrolls, and the remote stays in view only when it fits); the side windows are a little narrower; pictures in the Pictures window are the same size as on the remote's buttons.
- **0.9.8:** includes 0.8.8's backups with [Integration Manager](https://github.com/JackJPowell/uc-intg-manager): its **Backup Config** saves your settings (now with the Page Editor's app links) as text, and **Reconfigure → Restore settings from a backup** puts them back. Both choices are also in the integration's own setup.
- **0.9.7:** Page Editor app links: an app the device already has in its own source list isn't added a second time (names compared loosely, e.g. YouTube / You Tube); the import says which were skipped. Buttons already on the remote that use a link from the list show "select source · <name>" right after the import, and a custom value that's in the list shows the app name.
- **0.9.6:** Page Editor: the remote is drawn as big as the window allows and stays in view while the page scrolls; the pictures and settings columns take their full height (the page scrolls, not those windows). The Remote 3 / Remote Two choice only shows when the model couldn't be read from the remote. The builder's header is one row on the Page Editor tab.
- **0.9.5:** Page Editor: built-in icons are drawn as icons. The integration reads the font, the character for each icon and the web configurator's name aliases from the remote's own web configurator (Font Awesome 6 Pro, light), and sends the browser only the remote's own icons.
- **0.9.4:** Page Editor: the whole remote is always in view (drawn smaller to fit the window), and the Pictures and settings columns are as tall as the remote, each scrolling inside. Inside the builder the editor fills the window, with one compact top bar.
- **0.9.3 (beta):** Page Editor:
  - new widgets start at 1 × 1 (media widget 4 × 2);
  - **Custom value** for commands such as select source (e.g. an Android TV app link);
  - **App links** for Android TV integrations, loaded from a text file (`<command> = <name>`) and shown by name everywhere;
  - the top bar stays in place while scrolling;
  - one **Pictures** window with a selector, including the remote's **built-in icons**;
  - **Not added yet** in What it does, to add devices your integrations offer straight from a button;
  - **Smart** lists every Remote Self-Control entity, also the ones not added yet;
  - Integration Manager isn't listed; **+ Add an integration** opens it, or the web configurator's Integrations page.

  Faster: the builder and editor pages and larger answers are sent compressed (about a quarter of the size), and the editor reads everything from the remote in parallel. App links are part of the Backup.
- **0.9.2:** Page Editor: **What it does** opens on a list of devices (this activity's first, then the rest) instead of the first 80 commands; click a device for all its commands, or type to search everything. It opens on the device of the button's current command.
- **0.9.1:** Page Editor, Devices & integrations: every device an integration offers has its own **Add** button (added at once, no save needed), or tick several and **Add the N ticked**; the integration list shows how many devices each one offers; messages show at the top of the page; devices the remote lists with their full id are added correctly.
- **0.9.0 (beta):** **Page Editor** (new first tab): activities on a picture of your Remote 3 / Remote Two with pages, pictures (Icons, Channel icons, Local folder), widgets, physical keys and touch slider; start and off sequences with a **guided setup** for new devices (display, receiver, streaming, amp, Home Assistant, other) that adds their steps in signal-flow order with recommended waits; activity settings; activity groups; macros; home screen with backgrounds; devices & integrations. Full remote backup before the first change (newest two kept on the remote). **Theme picker** for the whole builder: Automatic, Desktop, Dark mode, Remote style, Midnight blue, High contrast.

- **0.8.7:** smart launchers: extra steps after the activity starts are optional and no longer described as "the app".
- **0.8.6:** the builder tab is called **Smart Launchers**.
- **0.8.5 (beta):** **Smart Launchers** (new tab): one button (page, physical or home screen) that opens the activity your conditions pick, optionally with extra steps, using launcher copies of your activities that follow their original. ↩, start pages, state icons and Controls treat a copy as its original. Part of the backup and of Remove everything.
- **0.8.4:** the Device states (live) panel is also in the Return & Pages tab, for start-page conditions (click a value field, then a value). A Go to page step whose page doesn't exist in the activity on screen is skipped (noted in the Last Result) instead of stopping the smart control.
- **0.8.3:** safety: state icons and level pictures write each activity's page at most every 5 seconds; if a page was changed outside the integration (e.g. in the web configurator) its state icons pause instead of overwriting it (save them again to resume); a counter shows how many changes the integration made to the remote in the last hour; **Remove everything** (Backup panel) puts back what the integration changed before you uninstall it (state icons, ↩ buttons, page orders, borrowed volume keys, quick-menu buttons, optionally its pictures and its API key).
- **0.8.2:** fix: when the integration changed an activity's pages (a start page, a ↩ button), the remote's report of that change was taken as you opening that activity, so ↩ could lead to the wrong activity (e.g. the page-jump test activity). Those reports are now ignored.
- **0.8.1:** **Page jumps**: a *Go to page* step for smart controls and quick menus (the activity on screen, or the page another activity opens on), and **start pages** per activity with if / otherwise (Return & Pages tab). Pages are rotated so your swipe order stays, and your own order comes back when you leave. Start pages are part of the backup.
- **0.8.0:** Backup and restore in the builder (Backup button): one .json file with smart controls, sliders and quick menus, state icons and level pictures, ↩ buttons and Controls, plus the custom pictures they use (not the login). Restore picks the parts, checks them all before changing anything and uploads missing pictures. The Return tab's event test panel is removed (the events are used automatically).
- **0.7.9:** Return: the integration listens to the remote's own events, so going back with ↩ to an activity that is still on is seen: the ↩ buttons follow it and "turn off when leaving" works there too. Previous Activity sensor shows the name and is only sent when it changes.
- **0.7.8:** fix: editing a smart button, slider or quick menu that is already on an activity no longer breaks it (saved ids stay fixed; the remote gets the new definition right away; removed ones show as unavailable). Quick menus: the step-through button option is gone (map Select next/previous). Return: "turn off when leaving" sends a plain activity.off (no activity groups) + a test panel of the remote's own events. Slider levels: one button, no draw-over, 16 designs (Battery, Needle, Pie, Steps added), color wheel, colors by value. Controls: start from the last or the starting value; reset / set the counted value.
- **0.7.7:** higher limits: 60 smart buttons (12 cases, 24 steps, pauses and waits up to 60 s), 60 state icons watching up to 25 devices (24 states each), 30 Controls, 30 sliders, 30 quick menus with 30 choices, 30 watched devices, 512 KB builder saves. The State icons tab shows how many icons and devices are in use and how long the last check took on the remote.
- **0.7.6:** battery: *This remote* in the device states panel shows battery level, charging, on the charger and status; all four can be used in smart-control conditions (e.g. battery level < 20).
- **0.7.5:** device states panel: *This remote* entry (screen and backlight brightness, sound, haptic, timeouts and this integration's controls such as backlight color), devices grouped by integration (Home Assistant, Denon, …), clicking a remote value sets a setting or control condition; more settings available in conditions.
- **0.7.4:** fixes the builder page not loading in 0.7.3 (a quote in a help text broke its script); a test now checks the page script.
- **0.7.3:** device states panel moved to the right of the editor; clicking a value fills the value field you clicked last (conditions also get the device and attribute), and copying works on the builder's plain-http address.
- **0.7.2:** **Device states (live)** panel in the builder (live values, values seen, background collecting, click to use).
- **0.7.1:** turn off when leaving: activity group members are read per group (the remote's group list has no members), so members you added yourself are kept.
- **0.7.0:** **Controls**: a *Control* media player for the volume rocker and touch slider, *Control: <name>* switches that point them at a light, a volume, the remote's own brightness or a slider, a *Control Active* sensor, per-activity defaults (or nothing), a borrowed volume rocker (mapped to Control only while a control is on) and a timeout or stay-on-until-changed. New *Controls ⇅* tab in the builder.
- **0.6.0:** **New builder layout**: a *+ Create* button per tab opens an editor box (name required); saved items are listed as bars with what they do and an *Edit* button. Three tabs: *Smart Controls* (smart controls and quick menus), *Icons & Sliders* (state icons and sliders) and *Return ↩* (per-activity ↩ buttons with custom pictures and turning off the activity you leave). ↩ buttons no longer add a row to a full page (that resized every button and broke picture-tile pages); new option to use the physical button only where the on-screen button doesn't fit. **Sliders & quick menus**. 12 tile icons for sliders and menus, and **level graphics** (12 designs × 6 colors, on one button or stretched over several, e.g. a column down the left side, always shown or only for a few seconds after the value changes) as a new kind of state icon that shows a number as a bar, gauge, dots and more. Sliders are light entities mapped to a number on any device (one "set value" command, or repeated up/down presses), with the remote's slider pop-up on home tiles and the Remote 3 touch slider; they follow the device's value. Quick menus are select entities whose choices run Smart Control steps, with an optional condition that marks the current choice; *Add from a device's list* builds one from a device's inputs or sound modes.
- **0.5.0:** **State icons**: new *State Icons* tab in the builder. Pick a button on a single-page activity, a device and what to check, then drop an image and/or type a label per state; the button switches look within about 2 seconds and returns to its own look otherwise. Images are resized to 90×90 and uploaded to the remote. Builder renamed *Remote Self-Control Builder* with *Smart Controls* and *State Icons* tabs.
- **0.4.0:** Return to previous activity: tracks the activities you start and keeps a ↩ text or icon button and/or a physical button pointed at the previous one, set up in the integration's Configure menu. New Previous Activity sensor (area Remote Navigation). Smart Control results name devices instead of showing entity ids.
- **0.3.2:** new **Display Brightness** light entity so the Remote 3 touch slider can set the display brightness.
- **0.3.1:** setup option "Add the Last Result tile to an activity".
- **0.3.0:** Smart Controls are generic: starts with one Smart Test Button; remote-only templates; builder page served by the integration with PIN login, device list, templates, save and test; remember / restore settings; next / previous / up / down; IR simple commands.
- 0.2.0: Smart Buttons: conditional rules, last-result sensor, rule editor in the setup screen.
- 0.1.x: remote settings entities, grouped into Remote Display / Remote Buttons / Remote Settings; macro-friendly selects.

</details>

## Support

If this integration makes your remote more fun to use, you can buy me a coffee. Thank you! ☕

<p align="center">
  <a href="https://buymeacoffee.com/sat32blk"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" height="80"></a>
</p>
