import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Builds the drop-in widget: one self-contained file that mounts the trading
 * interface into any page.
 *
 * React is bundled rather than externalised on purpose. The host is a Python
 * template stack, not a JS app with its own React — expecting it to supply
 * peer dependencies would defeat the point of a drop-in.
 */
export default defineConfig({
  plugins: [react()],
  define: {
    // Vite only substitutes NODE_ENV for its own app builds; in library mode
    // React would otherwise ship its development build.
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  build: {
    outDir: 'dist-embed',
    emptyOutDir: true,
    lib: {
      entry: 'src/embed.tsx',
      name: 'Clearswap',
      formats: ['iife'],
      fileName: () => 'clearswap.js',
    },
  },
})
