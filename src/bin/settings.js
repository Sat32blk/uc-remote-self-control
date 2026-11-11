// The remote's settings as the integration shows them: color presets, select and switch tables,
// and small conversions. The tables write through patchSection / patchNetworkWol, which the driver
// passes in (settingsTables).
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export const pctTo255 = (p) => Math.round((clamp(Number(p) || 0, 0, 100) * 255) / 100);
export const toPct = (b) => Math.round((clamp(Number(b) || 0, 0, 255) * 100) / 255);

// hue 0..360, sat 0..255 (UC light model) -> [r,g,b] at full value
export function hsToRgb(hue, sat) {
  const h = ((Number(hue) % 360) + 360) % 360;
  const s = clamp(Number(sat), 0, 255) / 255;
  const f = (n) => {
    const k = (n + h / 60) % 6;
    return 1 - s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return [f(5), f(3), f(1)].map((x) => Math.round(x * 255));
}

// [r,g,b] -> { hue 0..360, saturation 0..255 }
export function rgbToHs(rgb) {
  const [r, g, b] = (rgb || [255, 255, 255]).map((x) => clamp(Number(x) || 0, 0, 255) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  if (h < 0) h += 360;
  const s = max === 0 ? 0 : d / max;
  return { hue: Math.round(h), saturation: Math.round(s * 255) };
}

// ---------------------------------------------------------------------------
// Select option tables: label <-> value
// ---------------------------------------------------------------------------

export const COLOR_PRESETS = {
  warm_white: { name: "Warm white", rgb: [255, 190, 120] },
  amber: { name: "Amber", rgb: [255, 140, 0] },
  orange: { name: "Orange", rgb: [255, 90, 10] },
  red: { name: "Movie red", rgb: [255, 30, 20] },
  rose: { name: "Rose", rgb: [255, 70, 140] },
  purple: { name: "Purple", rgb: [150, 60, 255] },
  indigo: { name: "Indigo", rgb: [70, 70, 255] },
  ice_blue: { name: "Ice blue", rgb: [127, 172, 255] },
  cyan: { name: "Cyan", rgb: [0, 230, 230] },
  teal: { name: "Teal", rgb: [0, 200, 160] },
  green: { name: "Green", rgb: [40, 220, 70] },
  cool_white: { name: "Cool white", rgb: [235, 240, 255] }
};

// preset key for an rgb, or "#RRGGBB" when it matches none
export function colorKeyOf(rgb) {
  if (!Array.isArray(rgb)) return undefined;
  const hit = Object.entries(COLOR_PRESETS).find(([, p]) => p.rgb.join() === rgb.join());
  if (hit) return hit[0];
  return "#" + rgb.map((x) => Number(x).toString(16).padStart(2, "0")).join("").toUpperCase();
}

export const fmtSec = (s) => (s === 0 ? "Never" : s < 60 ? `${s} s` : s < 3600 ? `${s / 60} min` : `${s / 3600} h`);

/** The select and switch tables; writing goes through the driver's patchSection / patchNetworkWol. */
export function settingsTables({ patchSection, patchNetworkWol }) {
  const SELECTS = {
    display_timeout: {
      name: "Display timeout",
      section: "power_saving",
      field: "display_off_sec",
      values: [5, 10, 15, 20, 30, 45, 60],
      label: (v) => `${v} s`
    },
    sleep_timeout: {
      name: "Sleep timeout",
      section: "power_saving",
      field: "standby_sec",
      values: [60, 120, 300, 600, 900, 1800, 3600, 10800, 0],
      label: fmtSec
    },
    wake_sensitivity: {
      name: "Wake sensitivity",
      section: "power_saving",
      field: "wakeup_sensitivity",
      values: [0, 1, 2, 3],
      label: (v) => ["Off", "Low", "Medium", "High"][v] ?? String(v)
    },
    sound_volume: {
      name: "Sound effects volume",
      section: "sound",
      field: "volume",
      values: [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100],
      label: (v) => `${v} %`
    },
    // Macro-friendly versions of the lights: the remote passes percent values of
    // light.brightness_percent / light.color unconverted, so lights are ambiguous in macros.
    backlight_color: {
      name: "Button backlight color",
      read: (c) => colorKeyOf(c.button?.static_color?.rgb),
      values: Object.keys(COLOR_PRESETS),
      label: (k) => COLOR_PRESETS[k]?.name ?? `Custom ${k}`,
      write: async (k) => {
        if (!COLOR_PRESETS[k]) return; // "Custom #RRGGBB" = current colour, nothing to change
        await patchSection("button", { static_color: { rgb: COLOR_PRESETS[k].rgb } });
      },
      sorted: false
    },
    backlight_level: {
      name: "Button backlight level",
      section: "button",
      field: "brightness",
      values: [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100],
      label: (v) => (v === 0 ? "Off" : `${v} %`)
    },
    display_level: {
      name: "Display brightness level",
      section: "display",
      field: "brightness",
      values: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100],
      label: (v) => `${v} %`,
      extra: { auto_brightness: false } // a manual level only sticks with auto off
    }
  };

  const readSel = (def, c) => (def.read ? def.read(c) : c?.[def.section]?.[def.field]);
  const writeSel = (def, v) =>
    def.write ? def.write(v) : patchSection(def.section, { [def.field]: v, ...(def.extra || {}) });

  function selectOptions(def, current) {
    const vals = [...def.values];
    if (current !== undefined && !vals.includes(current)) {
      vals.push(current);
      if (def.sorted !== false) {
        // keep "Never" (0) last for the sleep timeout, otherwise numeric order
        vals.sort((a, b) => (a === 0 && def.field === "standby_sec" ? 1 : b === 0 && def.field === "standby_sec" ? -1 : a - b));
      }
    }
    return vals.map((v) => ({ v, label: def.label(v) }));
  }

  // ---------------------------------------------------------------------------
  // Switch table
  // ---------------------------------------------------------------------------

  const SWITCHES = {
    backlight_auto: {
      name: "Button backlight auto",
      get: (c) => c.button?.auto_brightness,
      set: (on) => patchSection("button", { auto_brightness: on })
    },
    display_auto_brightness: {
      name: "Display auto brightness",
      get: (c) => c.display?.auto_brightness,
      set: (on) => patchSection("display", { auto_brightness: on })
    },
    haptic: {
      name: "Haptic feedback",
      get: (c) => c.haptic?.enabled,
      set: (on) => patchSection("haptic", { enabled: on })
    },
    sound_effects: {
      name: "Sound effects",
      get: (c) => c.sound?.enabled,
      set: (on) => patchSection("sound", { enabled: on })
    },
    wake_on_wlan: {
      name: "Wake on WLAN",
      get: (c) => c.network?.wifi?.wake_on_wlan?.enabled ?? c.network?.wake_on_wlan?.enabled,
      set: (on) => patchNetworkWol(on)
    }
  };
  return { SELECTS, SWITCHES, readSel, writeSel, selectOptions };
}
