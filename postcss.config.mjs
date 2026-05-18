// Tailwind CSS v4 PostCSS plugin — required so `@import 'tailwindcss'` in
// `src/app/globals.css` is processed by the dev server and the production
// Next.js / Turbopack build.
export default {
  plugins: {
    '@tailwindcss/postcss': {},
  },
};
