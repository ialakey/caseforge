import type { Config } from 'tailwindcss';

export default {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // CS2 rarity palette — the same values as in @caseforge/shared, so the
        // item badge and the card highlight cannot drift apart.
        rarity: {
          consumer: '#b0c3d9',
          industrial: '#5e98d9',
          milspec: '#4b69ff',
          restricted: '#8847ff',
          classified: '#d32ce6',
          covert: '#eb4b4b',
          extraordinary: '#ffd700',
        },
        // The design tokens from globals.css, reachable as Tailwind utilities.
        // Declared with <alpha-value> so `bg-surface-raised/60` keeps working.
        surface: {
          base: 'hsl(var(--surface-base) / <alpha-value>)',
          raised: 'hsl(var(--surface-raised) / <alpha-value>)',
          overlay: 'hsl(var(--surface-overlay) / <alpha-value>)',
          hover: 'hsl(var(--surface-hover) / <alpha-value>)',
        },
        edge: {
          subtle: 'hsl(var(--border-subtle) / <alpha-value>)',
          strong: 'hsl(var(--border-strong) / <alpha-value>)',
        },
        ink: {
          primary: 'hsl(var(--text-primary) / <alpha-value>)',
          muted: 'hsl(var(--text-muted) / <alpha-value>)',
          faint: 'hsl(var(--text-faint) / <alpha-value>)',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent) / <alpha-value>)',
          strong: 'hsl(var(--accent-strong) / <alpha-value>)',
        },
        positive: 'hsl(var(--positive) / <alpha-value>)',
        negative: 'hsl(var(--negative) / <alpha-value>)',
      },
      keyframes: {
        'fade-up': {
          from: { opacity: '0', transform: 'translateY(6px)' },
          to: { opacity: '1', transform: 'none' },
        },
      },
      animation: {
        'fade-up': 'fade-up 220ms ease-out both',
      },
    },
  },
  plugins: [],
} satisfies Config;
