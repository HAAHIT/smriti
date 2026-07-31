import { defineConfig } from "wxt";
import { allOrigins, overlayOrigins } from "./lib/connectors/registry";

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
      // Capture origins come from lib/connectors/registry.ts — the same list
      // that generates every content script's `matches`. Adding a source there
      // is the only edit needed.
      ...allOrigins(),
      // Sync relay (packages/sync-relay). Replace after `wrangler deploy` —
      // see packages/sync-relay/README.md. Frozen: see FEATURES in
      // entrypoints/options/main.tsx.
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
    // The sidebar's @font-face rules live in the host page's head (Chrome does
    // not apply @font-face inside a shadow root), so the host origin must be
    // allowed to load the vendored font files. Only sources that actually mount
    // the sidebar need this.
    web_accessible_resources: [
      {
        resources: ["fonts/*.woff2"],
        matches: overlayOrigins(),
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
