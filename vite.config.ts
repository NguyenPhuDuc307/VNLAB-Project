import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    rolldownOptions: {
      output: {
        // React + router ít đổi -> chunk riêng, cache lâu giữa các lần deploy; thư viện khác gom vào vendor.
        codeSplitting: {
          groups: [
            { name: 'react', test: /node_modules[\\/](react|react-dom|scheduler|react-router|react-router-dom)[\\/]/, priority: 20 },
            { name: 'vendor', test: /node_modules[\\/]/, priority: 10 },
          ],
        },
      },
    },
  },
  server: {
    proxy: { '/api': { target: `http://127.0.0.1:${process.env.API_PORT ?? 3400}` } },
  },
});
