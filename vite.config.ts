import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';

const api = `http://127.0.0.1:${process.env.PORT || 3001}`;

export default defineConfig({
  root: 'src/web',
  plugins: [react()],
  server: {
    port: 5173,
    open: true,
    proxy: {'/api': api, '/media': api, '/music': api},
  },
  // Versão instalada: a tela já compilada é servida pelo próprio servidor (porta 3001).
  build: {outDir: '../../dist/web', emptyOutDir: true, chunkSizeWarningLimit: 4000},
});
