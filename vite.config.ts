import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolveDevProxyTarget } from './src/web/devProxyTarget';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const proxyTarget = resolveDevProxyTarget(env);
  console.log(`[vite] dev proxy target: ${proxyTarget}`);

  const frontendPort = Number.parseInt(env.FRONTEND_PORT || env.VITE_FRONTEND_PORT || '', 10);
  const resolvedFrontendPort = Number.isFinite(frontendPort) && frontendPort > 0 ? frontendPort : 5173;
  const frontendHost = (env.VITE_DEV_HOST || '127.0.0.1').trim() || '127.0.0.1';

  function resolveVChartChunk(id: string) {
    if (!id.includes('/node_modules/')) return undefined;

    if (id.includes('/@visactor/vrender')) return 'vchart-render';

    if (
      id.includes('/@visactor/vdataset')
      || id.includes('/@visactor/vgrammar')
      || id.includes('/@visactor/vscale')
      || id.includes('/@visactor/vutils')
    ) {
      return 'vchart-data';
    }

    if (
      id.includes('/@visactor/react-vchart/esm/charts/BaseChart')
      || id.includes('/@visactor/react-vchart/esm/containers/')
      || id.includes('/@visactor/react-vchart/esm/context/')
      || id.includes('/@visactor/react-vchart/esm/eventsUtils')
      || id.includes('/@visactor/react-vchart/esm/constants')
      || id.includes('/@visactor/react-vchart/esm/util')
      || id.includes('/@visactor/react-vchart/esm/components/tooltip/')
      || id.includes('/@visactor/vchart/esm/core/')
      || id.includes('/@visactor/vchart/esm/compile/')
      || id.includes('/@visactor/vchart/esm/plugin/')
      || id.includes('/@visactor/vchart/esm/typings/')
      || id.includes('/@visactor/vchart/esm/util/')
      || id.includes('/@visactor/vchart/esm/theme/')
      || id.includes('/@visactor/vchart/esm/animation/')
      || id.includes('/@visactor/vchart/esm/env/')
      || id.includes('/@visactor/vchart/esm/event/')
      || id.includes('/@visactor/vchart/esm/constant/')
      || id.includes('/@visactor/vchart/esm/data/transforms/')
    ) {
      return 'vchart-core';
    }

    return undefined;
  }

  return {
    root: 'src/web',
    plugins: [react(), tailwindcss()],
    build: {
      outDir: '../../dist/web',
      emptyOutDir: true,
      rollupOptions: {
        output: {
          manualChunks(id) {
            return resolveVChartChunk(id);
          },
        },
      },
    },
    server: {
      host: frontendHost,
      port: resolvedFrontendPort,
      proxy: {
        '^/api($|/)': {
          target: proxyTarget,
          changeOrigin: true,
        },
        '^/monitor-proxy($|/)': {
          target: proxyTarget,
          changeOrigin: true,
        },
        '^/v1($|/)': {
          target: proxyTarget,
          changeOrigin: true,
        },
      },
    },
  };
});
