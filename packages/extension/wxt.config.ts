import { defineConfig } from "wxt";

export default defineConfig({
  // ─── Modules ─────────────────────────────────────────────────────────────
  modules: ["@wxt-dev/module-react"],
  srcDir: ".",

  // ─── Manifest ────────────────────────────────────────────────────────────
  manifest: {
    name: "Smriti",
    description:
      "Local-first archive, search, and reference layer for your AI conversations.",
    permissions: [
      "storage",
      "offscreen",
      "scripting",
      "identity",
    ],
    host_permissions: [
      "https://claude.ai/*",
      "https://chatgpt.com/*",
      "https://gemini.google.com/*",
      // Sync relay (packages/sync-relay). Replace after `wrangler deploy` —
      // see packages/sync-relay/README.md.
      "https://smriti-sync-relay.YOUR-SUBDOMAIN.workers.dev/*",
      "https://www.googleapis.com/*",
    ],
    oauth2: {
      client_id: "YOUR_CLIENT_ID.apps.googleusercontent.com",
      scopes: ["https://www.googleapis.com/auth/drive.file"],
    },
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
    // The sidebar registers its vendored @font-face rules by adding a <link> to
    // the host page's document.head (Chrome ignores @font-face inside a shadow
    // tree), so the stylesheet and the .woff2 files it references are loaded from
    // page context and must be web-accessible. Keep `matches` aligned with the
    // sidebar content script's own matches in entrypoints/sidebar.content.ts.
    web_accessible_resources: [
      {
        resources: ["fonts/*"],
        matches: [
          "https://claude.ai/*",
          "https://chatgpt.com/*",
          "https://gemini.google.com/*",
        ],
      },
    ],
    content_security_policy: {
      // connect-src allows the offscreen doc to reach the sync relay. Replace
      // the placeholder host after `wrangler deploy`.
      extension_pages:
        "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; " +
        "connect-src 'self' https://smriti-sync-relay.YOUR-SUBDOMAIN.workers.dev",
    },
    minimum_chrome_version: "116",
  },

  // ─── Vite ────────────────────────────────────────────────────────────────
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
