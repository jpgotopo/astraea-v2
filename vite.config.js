import process from "node:process";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// Derives the GitHub Pages base path ("/<repo-name>/") from the
// GITHUB_REPOSITORY env var GitHub Actions sets automatically, instead of
// hardcoding the original repo's name — important now that this project
// lives in a differently-named repository.
const ghPagesBase = process.env.GITHUB_ACTIONS
  ? `/${(process.env.GITHUB_REPOSITORY || "/").split("/")[1]}/`
  : "/";

// https://vite.dev/config/
export default defineConfig({
  base: ghPagesBase,
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.ico", "apple-touch-icon.png", "mask-icon.svg"],
      manifest: {
        name: "Astraea - Universal Phonetic Fieldwork",
        short_name: "Astraea",
        description:
          "Offline-first universal phonetic transcription tool for linguistic fieldwork.",
        theme_color: "#020617",
        background_color: "#020617",
        display: "standalone",
        icons: [
          {
            src: "pwa-icon.svg",
            sizes: "any",
            type: "image/svg+xml",
          },
          {
            src: "pwa-icon.svg",
            sizes: "any",
            type: "image/svg+xml",
            purpose: "any maskable",
          },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,ico,png,svg,wasm}"],
        maximumFileSizeToCacheInBytes: 25000000,
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/huggingface\.co\/.*$/,
            handler: "CacheFirst",
            options: {
              cacheName: "huggingface-models",
              expiration: {
                maxEntries: 10,
                maxAgeSeconds: 60 * 60 * 24 * 365, // 1 year
              },
              cacheableResponse: {
                statuses: [0, 200],
              },
            },
          },
          {
            urlPattern: /^https:\/\/onnx-community\.s3\.amazonaws\.com\/.*$/,
            handler: "CacheFirst",
            options: {
              cacheName: "onnx-models",
              expiration: {
                maxEntries: 10,
                maxAgeSeconds: 60 * 60 * 24 * 365,
              },
              cacheableResponse: {
                statuses: [0, 200],
              },
            },
          },
        ],
      },
    }),
  ],
});
