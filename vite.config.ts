import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    {
      name: 'no-compression-headers',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url?.endsWith('.gz')) {
            res.setHeader('Content-Type', 'application/octet-stream');
            // Remove any Content-Encoding header that Vite might add
            const originalSetHeader = res.setHeader.bind(res);
            res.setHeader = (name: string, value: any) => {
              if (name.toLowerCase() === 'content-encoding') {
                return res;
              }
              return originalSetHeader(name, value);
            };
          }
          next();
        });
      },
    },
  ],
  base: process.env.RECIPEVIEWER_BASE ?? '/RecipeViewer/',
  build: {
    outDir: 'docs',
  },
})
