'use strict';
// Appearance: validated design tokens -> CSS custom properties. Only hex colours and whitelisted keywords are accepted,
// and contrast is enforced, so the admin can never produce an unreadable or broken storefront.
const HEX = /^#[0-9a-fA-F]{6}$/;
const lum = (h) => { const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const mix = (a, b, t) => '#' + [1, 3, 5].map((i) => Math.round(parseInt(a.slice(i, i + 2), 16) * (1 - t) + parseInt(b.slice(i, i + 2), 16) * t).toString(16).padStart(2, '0')).join('');
const FONTS = { system: 'Tahoma,"Segoe UI",system-ui,-apple-system,sans-serif', serif: 'Georgia,"Times New Roman",serif', mono: 'ui-monospace,Menlo,Consolas,monospace' };
const ENUMS = { button_style: ['rounded', 'pill', 'square'], font: Object.keys(FONTS), header_style: ['solid', 'minimal'], footer_style: ['minimal', 'columns'], scheme: ['dark', 'light'] };
const PRESETS = {
  dark: { background: '#000000', text: '#ffffff', primary: '#ffffff', secondary: '#0e0e0e', accent: '#ffd166' },
  light: { background: '#ffffff', text: '#111111', primary: '#111111', secondary: '#f2f2f2', accent: '#b45309' },
};

function validateTheme(input) {
  const errors = {}; const t = {};
  const src = input && typeof input === 'object' ? input : {};
  for (const k of ['background', 'text', 'primary', 'secondary', 'accent']) { if (!HEX.test(src[k] || '')) errors[k] = 'must be a hex colour like #000000'; else t[k] = src[k].toLowerCase(); }
  for (const [k, list] of Object.entries(ENUMS)) { if (!list.includes(src[k])) errors[k] = 'invalid value'; else t[k] = src[k]; }
  const r = Number(src.radius); if (!Number.isInteger(r) || r < 0 || r > 24) errors.radius = 'must be 0-24'; else t.radius = r;
  for (const k of ['animations', 'hero_animation']) t[k] = src[k] === true || src[k] === 1 || src[k] === '1' || src[k] === 'true';
  if (!Object.keys(errors).length) {
    if (contrast(t.text, t.background) < 4.5) errors.text = `text/background contrast is ${contrast(t.text, t.background).toFixed(1)}:1 (minimum 4.5:1)`;
    if (contrast(t.text, t.secondary) < 4.5) errors.secondary = `text/surface contrast is ${contrast(t.text, t.secondary).toFixed(1)}:1 (minimum 4.5:1)`;
    if (contrast(t.primary, t.background) < 3) errors.primary = `button/background contrast is ${contrast(t.primary, t.background).toFixed(1)}:1 (minimum 3:1)`;
    if (contrast(t.accent, t.background) < 3) errors.accent = `accent/background contrast is ${contrast(t.accent, t.background).toFixed(1)}:1 (minimum 3:1)`;
  }
  return { theme: t, errors };
}

/** CSS variables for a validated theme (never built from raw input). */
function themeVars(t) {
  const primaryFg = contrast(t.primary, '#000000') >= contrast(t.primary, '#ffffff') ? '#000000' : '#ffffff';
  const radius = { pill: '999px', rounded: `${t.radius}px`, square: '2px' }[t.button_style];
  return {
    '--bg': t.background, '--fg': t.text, '--primary': t.primary, '--primary-fg': primaryFg, '--card': t.secondary, '--accent': t.accent,
    '--panel': mix(t.background, t.text, 0.05), '--inp': mix(t.background, t.text, 0.08), '--line': mix(t.background, t.text, 0.18), '--mut': mix(t.background, t.text, 0.6),
    '--radius': `${t.radius}px`, '--btn-radius': radius, '--font': FONTS[t.font], '--logo-filter': lum(t.background) > 0.5 ? 'invert(1)' : 'none',
  };
}
const themeCss = (t) => `:root{${Object.entries(themeVars(t)).map(([k, v]) => `${k}:${v}`).join(';')}}`;
const htmlClasses = (t) => [t.animations ? '' : 'no-anim', t.hero_animation ? '' : 'no-hero-anim', `hdr-${t.header_style}`, `ftr-${t.footer_style}`].filter(Boolean).join(' ');
function parseTheme(raw, fallback) { try { const { theme, errors } = validateTheme(JSON.parse(raw)); return Object.keys(errors).length ? fallback : theme; } catch { return fallback; } }
module.exports = { validateTheme, themeVars, themeCss, htmlClasses, parseTheme, contrast, PRESETS, ENUMS };
