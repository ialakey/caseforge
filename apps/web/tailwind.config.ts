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
      },
    },
  },
  plugins: [],
} satisfies Config;
