import { defineConfig } from 'vite';
import { createApiMiddleware } from './server/apiMiddleware.mjs';

function leaderboardApiPlugin() {
  const middleware = createApiMiddleware();
  return {
    name: 'robot-pong-leaderboard-api',
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}

export default defineConfig({
  // Relative asset URLs so the same build runs at a domain root or under any sub-path
  // (a GitHub Pages project site is served from /<repo>/).
  base: './',
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
