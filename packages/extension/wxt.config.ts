import { defineConfig } from "wxt";

export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  srcDir: ".",
  manifest: ({ browser }) => ({
    name: "Smriti",
    description:
      "Local-first archive, search, and reference layer for your AI conversations.",
    permissions: [
      "storage",
      "offscreen",
      "scripting",
    ],
    host_permissions: [
      "https://claude.ai/*",
      "https://chatgpt.com/*",
      "https://gemini.google.com/*",
    ],
    action: {
      default_title: "Smriti",
      default_icon: {
        "16":  "icons/icon-16.png",
        "32":  "icons/icon-32.png",
        "48":  "icons/icon-48.png",
        "128": "icons/icon-128.png",
      },
    },
    icons: {
      "16":  "icons/icon-16.png",
      "32":  "icons/icon-32.png",
      "48":  "icons/icon-48.png",
      "128": "icons/icon-128.png",
    },
    content_security_policy: {
      extension_pages:
        "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
    minimum_chrome_version: "116",
    ...(browser === "firefox"
      ? {
          browser_specific_settings: {
            gecko: {
              id: "smriti@local",
              strict_min_version: "115.0",
            },
          },
        }
      : {}),
  }),
  vite: () => ({
    assetsInclude: ["**/*.wasm"],
    optimizeDeps: {
      exclude: ["@xenova/transformers", "sql.js"],
    },
    build: {
      rollupOptions: {
        external: [],
      },
    },
  }),
});
