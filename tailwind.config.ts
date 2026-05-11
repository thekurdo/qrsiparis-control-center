import type { Config } from 'tailwindcss';

/**
 * Tailwind v4 configuration for the QrSiparis Control Center.
 *
 * Per IMPLEMENTATION_NOTES.md §1 + UI_DESIGN.md control-center tokens:
 *   - V1 ships dark theme ONLY (light theme in V1.5)
 *   - slate-900 base bg, slate-800 cards, slate-700 elevated
 *   - blue-500 primary, emerald-500 success, amber-500 warning, red-500 danger
 *   - status: healthy=emerald, degraded=amber, error=red, paused=slate
 *
 * Tailwind v4 is mostly CSS-first. This file primarily declares content sources;
 * design tokens live in `src/app/globals.css` via `@theme`.
 */
const config: Config = {
  // Enable dark mode via class. App will set `class="dark"` on <html> by default.
  darkMode: 'class',
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      // Control-center specific tokens (also expose as CSS vars in globals.css)
      colors: {
        cc: {
          bg: '#0f172a', // slate-900
          card: '#1e293b', // slate-800
          elevated: '#334155', // slate-700
          border: '#475569', // slate-600
          primary: '#3b82f6', // blue-500
          success: '#10b981', // emerald-500
          warning: '#f59e0b', // amber-500
          danger: '#ef4444', // red-500
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
    },
  },
  plugins: [],
};

export default config;
