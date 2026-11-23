import { defineConfig } from 'vite';
import { createApiMiddleware } from './server/apiMiddleware.mjs';

function leaderboardApiPlugin() {
  const middleware = createApiMiddleware();
  return {
    name: 'sentinel-pong-leaderboard-api',
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}

export default defineConfig({
  plugins: [leaderboardApiPlugin()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: false,
  },
  build: {
    target: 'es2022',
    sourcemap: false,
  },
});
