/**
 * Per-user theme preferences.
 *
 * One source of truth for what a user can customize and how it maps onto the
 * app's CSS variables. Deliberately framework-neutral and side-effect-free so
 * the SAME code runs three places:
 *   - the server layout (renders the initial theme inline → no flash of default)
 *   - the client customizer (applies changes live as the user drags a slider)
 *   - the API route (normalizes whatever JSON is submitted before it is stored)
 *
 * Colours are applied as inline custom properties on <html>, which beat the
 * stylesheet's `:root` rules without any specificity games, and `color-mix`
 * derives the accent's lighter/soft variants from the single chosen colour so
 * the user only picks one swatch.
 */

export type ThemeMode = 'system' | 'light' | 'dark';
export type Density = 'comfortable' | 'compact';
export type SidebarSide = 'left' | 'right';
export type FontKey = 'system' | 'grotesk' | 'rounded' | 'serif' | 'mono';

export interface ThemePreferences {
  /** Light, dark, or follow the operating system. */
  mode: ThemeMode;
  /** Primary accent as a #rrggbb hex; lighter/soft variants are derived. */
  accent: string;
  /** Which font stack the UI text uses. */
  fontFamily: FontKey;
  /** Multiplier on the base font size, 0.85–1.3. */
  fontScale: number;
  /** Corner radius in px, 0–20. */
  radius: number;
  /** Overall spacing. */
  density: Density;
  /** Which side the navigation sits on. */
  sidebar: SidebarSide;
}

export const DEFAULT_THEME: ThemePreferences = {
  mode: 'system',
  accent: '#0c6e63',
  fontFamily: 'system',
  fontScale: 1,
  radius: 12,
  density: 'comfortable',
  sidebar: 'left',
};

/** Real, offline-safe stacks — no network font loading, works on every OS. */
export const FONT_STACKS: Record<FontKey, string> = {
  system: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  grotesk: "'Segoe UI', system-ui, 'Helvetica Neue', Arial, sans-serif",
  rounded: "ui-rounded, 'SF Pro Rounded', 'Segoe UI Rounded', system-ui, 'Segoe UI', sans-serif",
  serif: "Georgia, Cambria, 'Times New Roman', Times, serif",
  mono: "ui-monospace, 'SF Mono', 'Cascadia Code', 'Segoe UI Mono', Consolas, monospace",
};

export const FONT_LABELS: Record<FontKey, string> = {
  system: 'System (default)',
  grotesk: 'Grotesk',
  rounded: 'Rounded',
  serif: 'Serif',
  mono: 'Monospace',
};

/** Curated accent swatches; the user can also enter any custom hex. */
export const ACCENT_PRESETS: { name: string; value: string }[] = [
  { name: 'Teal', value: '#0c6e63' },
  { name: 'Emerald', value: '#047857' },
  { name: 'Blue', value: '#2c6e9b' },
  { name: 'Indigo', value: '#4f46e5' },
  { name: 'Violet', value: '#6d28d9' },
  { name: 'Rose', value: '#be185d' },
  { name: 'Amber', value: '#b45309' },
  { name: 'Slate', value: '#334155' },
];

export const FONT_SCALE_MIN = 0.85;
export const FONT_SCALE_MAX = 1.3;
export const RADIUS_MIN = 0;
export const RADIUS_MAX = 20;

const HEX = /^#[0-9a-fA-F]{6}$/;
const MODES: ThemeMode[] = ['system', 'light', 'dark'];
const DENSITIES: Density[] = ['comfortable', 'compact'];
const SIDES: SidebarSide[] = ['left', 'right'];
const FONT_KEYS: FontKey[] = ['system', 'grotesk', 'rounded', 'serif', 'mono'];

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/**
 * Coerce arbitrary/partial/untrusted input into a complete, valid preferences
 * object. Anything missing or out of range falls back to the default, so a
 * stored value written by an older version can never break the page.
 */
export function normalizeTheme(raw: unknown): ThemePreferences {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof ThemePreferences, unknown>>;

  const accent = typeof r.accent === 'string' && HEX.test(r.accent) ? r.accent : DEFAULT_THEME.accent;
  const fontScaleRaw = Number(r.fontScale);
  const radiusRaw = Number(r.radius);

  return {
    mode: MODES.includes(r.mode as ThemeMode) ? (r.mode as ThemeMode) : DEFAULT_THEME.mode,
    accent,
    fontFamily: FONT_KEYS.includes(r.fontFamily as FontKey) ? (r.fontFamily as FontKey) : DEFAULT_THEME.fontFamily,
    fontScale: Number.isFinite(fontScaleRaw)
      ? Math.round(clamp(fontScaleRaw, FONT_SCALE_MIN, FONT_SCALE_MAX) * 100) / 100
      : DEFAULT_THEME.fontScale,
    radius: Number.isFinite(radiusRaw) ? Math.round(clamp(radiusRaw, RADIUS_MIN, RADIUS_MAX)) : DEFAULT_THEME.radius,
    density: DENSITIES.includes(r.density as Density) ? (r.density as Density) : DEFAULT_THEME.density,
    sidebar: SIDES.includes(r.sidebar as SidebarSide) ? (r.sidebar as SidebarSide) : DEFAULT_THEME.sidebar,
  };
}

/**
 * The CSS custom properties for a theme, as a plain record. Applied as inline
 * styles on <html> (server render) or via setProperty (client) — both beat the
 * stylesheet `:root` defaults, so the switch is instant and flash-free.
 */
export function themeCssVars(t: ThemePreferences): Record<string, string> {
  return {
    '--accent': t.accent,
    '--accent-2': `color-mix(in srgb, ${t.accent} 72%, white)`,
    '--accent-soft': `color-mix(in srgb, ${t.accent} 14%, var(--panel))`,
    '--font-sans': FONT_STACKS[t.fontFamily],
    '--font-scale': String(t.fontScale),
    '--radius': `${t.radius}px`,
    '--radius-sm': `${Math.round(t.radius * 0.66)}px`,
  };
}

/** The data-* attributes that drive light/dark, density, and placement. */
export function themeDataAttributes(t: ThemePreferences): Record<string, string> {
  return {
    ...(t.mode !== 'system' ? { 'data-theme': t.mode } : {}),
    'data-density': t.density,
    'data-sidebar': t.sidebar,
  };
}

/**
 * Apply a theme to the live document (client only). Used for instant preview as
 * the user edits, before anything is saved.
 */
export function applyThemeToDocument(t: ThemePreferences): void {
  if (typeof document === 'undefined') return;
  const el = document.documentElement;

  for (const [key, value] of Object.entries(themeCssVars(t))) {
    el.style.setProperty(key, value);
  }

  el.setAttribute('data-density', t.density);
  el.setAttribute('data-sidebar', t.sidebar);
  if (t.mode === 'system') el.removeAttribute('data-theme');
  else el.setAttribute('data-theme', t.mode);
}
