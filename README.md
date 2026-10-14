# Remote Self-Control

A custom integration for the **Unfolded Circle Remote 3** (and Remote Two) that runs on the remote itself and lets it control its own settings from activities, macros, pages and buttons. It also adds **Smart Controls**: conditional buttons you build in a browser.

> Community project, not affiliated with Unfolded Circle. MIT licensed. It changes the remote's settings through its local Core REST API.

## What you get

Entities are grouped by area in the web configurator.

| Group | Entity | Type | What it controls |
|---|---|---|---|
| **Remote Display** | Display Brightness Level | select | 10 % … 100 % (turns display auto brightness off) |
| | Display Brightness | light | brightness for the **touch slider** (Remote 3); off = dimmest; turns auto brightness off |
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
| **Remote Smart Controls** | (your Smart Controls) | button | see below |
| | Smart Controls: Last Result | sensor | what the last Smart Control did, or its error |

**Touch slider (Remote 3):** in an activity's user interface settings, set the touch slider to **Button Backlight** or **Display Brightness**.

In macros, activities and UI buttons, prefer the **select** entities ("Select option"). The remote's editor passes the light's "brightness %" and "color" commands through unconverted, so they are unreliable there. A UI button's entity must also be added to that activity's devices.

## Return to previous activity

The integration watches which activity you start and keeps a **↩** button pointed at the activity you used before, whether or not that one was turned off. Pressing it opens that activity, and pressing ↩ there takes you back again.

Set it up under Integrations → Remote Self-Control → **Configure** → **Return to previous activity: set up the ↩ button**:

- **Activities:** tick the activities that should have the button.
- **On-screen button:** a text button "↩ <previous activity>" or a back-arrow icon, added to the first free spot of each ticked activity's first page (a row is added if the page is full). Move or resize it in the web configurator as you like: any text button starting with ↩, or a back-arrow icon button that starts an activity, is kept up to date. You can also add your own text button starting with ↩.
- **Physical button:** pick a button and short or long press. This replaces what that button does in the ticked activities.
- The previous activity is added to each ticked activity's devices automatically, which the remote requires.
- Untick every activity to turn it off. Buttons already placed stay; delete them in the web configurator.

How it works: the remote only switches screens when you press a button whose command starts an activity, so the integration can't switch screens itself. Instead, every 2 seconds while the remote is awake it reads which activities are on. While you're in one activity, the ↩ buttons in all the others already point to it, so the button is right the moment the next screen opens.

Limit: the remote only reports an activity "starting" when it goes from off to on. Opening an activity that is still on (for example with ↩ itself) isn't seen, so ↩ toggles between the last two activities you started.

## Smart Controls

A Smart Control is a button that checks something, then runs the first branch that matches:

```
If   <conditions>            then <steps>
Else if <conditions>         then <steps>
Otherwise                         <steps>
```

- **Conditions:** a device's state or attribute (is, is not, above, below, contains), an activity running or not, time of day, this remote's controls and settings, or a remembered value. Combine with "all" / "any".
- **Steps:** any device command (including IR "simple commands"), this remote's controls (set an option, or next / previous / up / down), wait a time, wait until a device reaches a state, remember a value, remember / restore the remote's settings, stop.

They work on screen buttons, physical buttons (short or long press) and in macros. They run in the background, so they can't switch the remote's screen to another activity.

### Starting point

The integration starts with one control, **Smart Test Button**, which moves the button backlight to the next color preset. Add it to an activity and press it to check that Smart Controls work, then build your own.

The builder's templates include ready-made controls that use only the remote itself:

| Template | What it does |
|---|---|
| Night Mode | Toggle. Remembers the current backlight, display and sound, then sets red backlight 10 %, display 30 %, sound effects off. Press again to restore. |
| Quiet Mode | Toggle. Sound effects and haptics off; press again to restore. |
| Backlight color cycle | Next backlight color preset (wraps around). |
| Display / Backlight brighter and dimmer | One step up / down. |
| Backlight by time of day | Amber and dim in the evening, cool white otherwise. |

The same set is in `examples/remote-only-rules.json`.

### Showing the Last Result on an activity

The web configurator doesn't list sensor entities when you edit an activity, so the integration can place the tile for you:

1. Add **Smart Controls: Last Result** (and any Smart Controls you want) to the integration: Integrations → Remote Self-Control → add entities.
2. Integrations → Remote Self-Control → **Configure** → **Add the Last Result tile to an activity**.
3. Pick the activity. Leave **Also add the Smart Control buttons** ticked to put the buttons under the tile.

This adds a page called **Smart Controls** to that activity: the tile across the top, the buttons two per row below. It also adds those entities to the activity's devices. Running it again for the same activity replaces that page; your other pages are not touched. You can move or resize the items afterwards in the web configurator.

### The builder

The integration serves its own builder page on your network:

```
http://<remote-name>.local:10123/      or      http://<remote-ip>:10123/
```

The exact addresses are shown in the integration's setup screen (Integrations → Remote Self-Control → Configure).

1. Log in with the **web-configurator PIN** (the same PIN as the web configurator).
2. The builder lists your remote's own devices, their commands, inputs and sound modes, your activities and this integration's controls. Pick from them; no ids to type.
3. Start from a template (“This remote”: Night Mode, Quiet Mode, color cycle, brighter/dimmer, backlight by time; “Your devices”: smart volume, play/pause, input with wait, sound mode cycle, per-activity action) or build from scratch.
4. **Save** writes the rules to the remote. **Test** runs one control once and shows the result.
5. After saving, add new controls to the integration (Integrations → Remote Self-Control → add entities) and to the activities that use them.

The **Rules text** panel exports and imports the rules as JSON, so you can back them up or share them. `examples/shield-tv-receiver-rules.json` shows device rules for an NVIDIA Shield, a Samsung TV and a Marantz receiver. Replace the `YOUR_…_ID` placeholders in its `aliases` with your own entity ids (shown in the builder), or rebuild the same rules from the builder's templates.

Without a browser, the same JSON can be pasted in the integration's setup screen ("Edit Smart Controls (text)").

### Rules format (short reference)

```json
{
  "aliases": { "tv": "samsungtv_driver.main.media_player.uuid:…" },
  "buttons": [
    {
      "id": "smart_volume_up",
      "name": "Smart Volume Up",
      "cases": [
        { "if": { "entity": "receiver", "is": "ON" },
          "do": [ { "cmd": "media_player.volume_up", "entity": "receiver" } ] },
        { "else": [ { "cmd": "media_player.volume_up", "entity": "tv" } ] }
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
| This remote's setting | `{ "setting": "display.brightness", ">": 50 }` |
| Memory | `{ "var": "night_mode", "is": "on" }` |
| Combine | `{ "all": [ … ] }`, `{ "any": [ … ] }`, `{ "not": … }` |

| Step | Example |
|---|---|
| Device command | `{ "cmd": "media_player.select_source", "entity": "receiver", "params": { "source": "SHIELD" } }` |
| This remote's control | `{ "self": "display_level", "option": "up" }`, `{ "self": "haptic", "state": "toggle" }` |
| Wait | `{ "delay": 500 }` |
| Wait until | `{ "wait_until": { "entity": "receiver", "is": "ON" }, "timeout": 10000 }` |
| Memory | `{ "set_var": "night_mode", "to": "on" }` |
| Remember / restore settings | `{ "save_settings": "before" }`, `{ "restore_settings": "before" }` |
| Stop | `{ "stop": true }` |

The short form `{ "id", "name", "if", "do", "else" }` works too. Limits: 30 controls, 8 branches each, 12 steps per branch, 30 s per run. A press while the same control is still running is ignored.

## Install

1. Download `uc-intg-self-control-<version>.tar.gz` from the [latest release](https://github.com/Sat32blk/uc-remote-self-control/releases/latest).
2. Web configurator → **Integrations → Add new → Install custom** → choose the file.
3. Start the setup for **Remote Self-Control**. The first screen is information only. On the second, enter the **web-configurator PIN** and leave the address at `127.0.0.1`.
   - The integration uses the PIN once to create an API key named "Self-Control <date>" and stores only that key.
   - If setup fails with a connection error, run it again with the remote's own IP address.
4. Add the entities you want, then use them in activities, macros or pages.

To update, use Install custom with **Update existing driver** checked. Your Smart Controls and settings are kept.

## Security

- The builder requires the web-configurator PIN. The PIN is checked against the remote and never stored. A session lasts 12 hours (HttpOnly, SameSite=Strict cookie).
- After 5 wrong PINs from one address, logins are blocked for 5 minutes.
- The builder is plain HTTP on your local network, like the web configurator itself. Don't forward port 10123 to the internet.
- The integration holds an admin API key for the remote. Removing the integration does not revoke it: list keys with `GET /api/auth/api_keys` and delete with `DELETE /api/auth/api_keys/{id}`.

## Configuration

| Environment variable | Default | Purpose |
|---|---|---|
| `UC_SELF_BUILDER_PORT` | `10123` | Port of the builder page |

Files in the integration's config folder: `self_control.json` (address + API key), `smart_rules.json` (your rules; absent = defaults), `smart_vars.json` (remembered values).

## Logs and removal

- Logs: web configurator → Settings → Development → Logs (lines start with `[self-control]`).
- Remove: delete the integration instance, then the driver, then revoke the API key (see Security).

## Development

```
src/driver.json            metadata and first setup screen
src/bin/driver.js          entities, commands, setup flow, polling
src/bin/core.js            REST client for the remote's Core API
src/bin/smart.js           Smart Controls: validation and engine
src/bin/web.js             builder web server and device catalog
src/bin/tile.js            puts the Last Result tile on an activity page
src/bin/returnbtn.js       return to previous activity (tracking + ↩ buttons)
src/bin/web/builder.html   builder page (no external files; works offline)
src/bin/default-rules.json default Smart Controls (Smart Test Button)
examples/remote-only-rules.json  remote-only example rules
examples/shield-tv-receiver-rules.json     device-specific example rules
test/                      fake Core API + Integration-API test client
```

Tests (Node 22):

```
npm install            # dev dependency: ws
(cd src/bin && npm install)
node test/run-test.js  # settings entities, setup, commands
node test/smart-test.js  # Smart Controls + builder API
node test/return-test.js # return to previous activity
```

Build the install archive:

```
./build.sh             # -> dist/uc-intg-self-control-<version>.tar.gz
```

## Changes

- **0.4.0:** Return to previous activity: tracks the activities you start and keeps a ↩ text or icon button and/or a physical button pointed at the previous one, set up in the integration's Configure menu. New Previous Activity sensor (area Remote Navigation).
- **0.3.2:** new **Display Brightness** light entity so the Remote 3 touch slider can set the display brightness (like Button Backlight does for the buttons).
- **0.3.1:** setup option “Add the Last Result tile to an activity”: creates or replaces a “Smart Controls” page with the tile and, optionally, the Smart Control buttons.
- **0.3.0:** Smart Controls are generic: starts with one Smart Test Button; Night Mode, Quiet Mode, Backlight Color Cycle and Brighter/Dimmer controls are builder templates. New area **Remote Smart Controls**. Builder page served by the integration on port 10123 with PIN login, a list of your devices, commands and activities, templates, save and test. New steps: remember / restore settings, next / previous / up / down for the remote's own controls, IR simple commands. New conditions: this remote's controls. Setup menu shows the builder address.
- 0.2.0: Smart Buttons: conditional rules, last-result sensor, rule editor in the setup screen.
- 0.1.4: entities grouped into Remote Display / Remote Buttons / Remote Settings.
- 0.1.3: macro-friendly selects for backlight color and level and display level.
- 0.1.2: accepts the macro editor's "Set brightness" / "Set color" commands.
- 0.1.1: PIN asked on the second setup screen.
