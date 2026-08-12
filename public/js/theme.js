// v2.9.9 Phase B（B2/B31/B32）— Appearance manager：theme（dark/light/system）+ density.
// Persists to settings and applies by toggling data-attributes on <html>.
// The renderer only displays/applies user preference; it never invents runtime truth.
import { api } from './api.js';

const THEME_KEY = 'ui.theme';
const DENSITY_KEY = 'ui.density';

let currentTheme = 'dark';
let currentDensity = 'comfortable';
let mediaQuery = null;

function apply() {
  const root = document.documentElement;
  // Resolve "system" to the concrete scheme so CSS only ever sees dark/light.
  const resolved = currentTheme === 'system'
    ? (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
    : currentTheme;
  root.setAttribute('data-theme', resolved);
  root.setAttribute('data-density', currentDensity === 'compact' ? 'compact' : 'comfortable');
}

function watchSystem() {
  if (!window.matchMedia) return;
  if (mediaQuery) { try { mediaQuery.removeEventListener('change', watchSystem.onChange); } catch { /* noop */ } }
  mediaQuery = window.matchMedia('(prefers-color-scheme: light)');
  watchSystem.onChange = () => { if (currentTheme === 'system') apply(); };
  try { mediaQuery.addEventListener('change', watchSystem.onChange); } catch { /* older Electron */ }
}

/** Apply a theme immediately (used before settings load to avoid flash). */
export function applyImmediate(theme, density) {
  if (theme) currentTheme = theme;
  if (density) currentDensity = density;
  apply();
}

/** Load persisted preferences and apply. Called once during boot. */
export async function init() {
  try {
    const [theme, density] = await Promise.all([
      api.settingsGet(THEME_KEY, 'dark'),
      api.settingsGet(DENSITY_KEY, 'comfortable')
    ]);
    currentTheme = ['dark', 'light', 'system'].includes(theme) ? theme : 'dark';
    currentDensity = ['comfortable', 'compact'].includes(density) ? density : 'comfortable';
  } catch { /* settings unavailable -> defaults */ }
  apply();
  watchSystem();
}

/** Set + persist theme. */
export async function setTheme(theme) {
  if (!['dark', 'light', 'system'].includes(theme)) return;
  currentTheme = theme;
  apply();
  try { await api.settingsSet(THEME_KEY, theme); } catch { /* best effort */ }
}

/** Set + persist density. */
export async function setDensity(density) {
  if (!['comfortable', 'compact'].includes(density)) return;
  currentDensity = density;
  apply();
  try { await api.settingsSet(DENSITY_KEY, density); } catch { /* best effort */ }
}

export function getTheme() { return currentTheme; }
export function getDensity() { return currentDensity; }
