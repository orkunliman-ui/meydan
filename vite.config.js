import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: 'web',
  plugins: [react()],
  // Polices servies en fichiers (la CSP du serveur n'autorise pas les data: pour les polices).
  build: { outDir: '../dist', emptyOutDir: true, assetsInlineLimit: 0 },
})
