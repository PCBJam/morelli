import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
    plugins: [react()],
    build: { outDir: 'dist' },
    server: {
        port: 5173,
        // The Hono Worker (wrangler dev) owns /api; the OAuth callback URL of the
        // dev GitHub app points at :5173 so the whole flow stays on this origin.
        proxy: { '/api': 'http://localhost:8787' },
    },
});
