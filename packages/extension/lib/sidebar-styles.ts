export const SIDEBAR_CSS = `
    :host, * { box-sizing: border-box; }
    :host {
      --bg: #f6f1e6;
      --surface: #fcf9f1;
      --surface-2: #f1ebdb;
      --ink: #2a2620;
      --ink-2: #4a4338;
      --muted: #8a7f6b;
      --muted-2: #b5aa94;
      --hairline: #e3dac4;
      --hairline-strong: #d3c8ae;
      --accent: #8b3a2f;
      --accent-soft: #d9a59c;
      --highlight: #f3e1a6;
      --highlight-strong: #e8c45a;
      --chip-bg: rgba(0,0,0,0.04);
      --serif: 'Source Serif 4', ui-serif, Georgia, 'Times New Roman', serif;
      --sans: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      --mono: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }
    @media (prefers-color-scheme: dark) {
      :host {
        --bg: #14130f;
        --surface: #1b1a15;
        --surface-2: #232118;
        --ink: #ece4d0;
        --ink-2: #c4bda9;
        --muted: #8a8270;
        --muted-2: #5f5947;
        --hairline: #2c2a22;
        --hairline-strong: #3a3729;
        --accent: #c4685a;
        --accent-soft: #7a3f35;
        --highlight: #5a4612;
        --highlight-strong: #c8983a;
        --chip-bg: rgba(255,247,228,0.05);
      }
    }

    /* ── Collapsed tab ── */
    .rc-tab {
      position: fixed;
      top: 50%;
      right: 0;
      transform: translateY(-50%);
      width: 36px;
      padding: 16px 6px;
      background: var(--bg);
      border: 1px solid var(--hairline-strong);
      border-right: none;
      border-radius: 8px 0 0 8px;
      cursor: pointer;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 10px;
      color: var(--ink);
      font-family: var(--sans);
      box-shadow: -2px 0 8px rgba(40,30,20,0.08);
    }
    .rc-tab-title {
      font-family: var(--serif);
      font-weight: 600;
      font-size: 14px;
      writing-mode: vertical-rl;
      transform: rotate(180deg);
      letter-spacing: 0.04em;
    }
    .rc-tab-sub {
      font-family: var(--mono);
      font-size: 10px;
      color: var(--muted);
      writing-mode: vertical-rl;
      transform: rotate(180deg);
      text-transform: uppercase;
      letter-spacing: 0.1em;
    }

    /* ── Expanded panel ── */
    .rc-panel {
      width: 400px;
      height: 100vh;
      background: var(--bg);
      color: var(--ink);
      font-family: var(--sans);
      display: flex;
      flex-direction: column;
      position: relative;
      border-left: 2px solid var(--hairline-strong);
      box-shadow: -8px 0 24px rgba(40,30,20,0.08);
      font-size: 14px;
      line-height: 1.5;
    }
    .rc-spacer { flex: 1; }
    .rc-divider { color: var(--muted-2); }
    .rc-divider-h { height: 1px; background: var(--hairline); margin: 14px 0; }
    .rc-mono { font-family: var(--mono); font-variant-numeric: tabular-nums; }
    .rc-bold { font-weight: 600; }
    .rc-accent { color: var(--accent); }
    .rc-smallcaps {
      font-family: var(--sans);
      text-transform: uppercase;
      letter-spacing: 0.12em;
      font-size: 10.5px;
      font-weight: 600;
      color: var(--muted);
    }
    .rc-muted-text { color: var(--muted); }

    /* ── Header ── */
    .rc-header {
      padding: 14px 18px 12px;
      border-bottom: 1px solid var(--hairline);
      display: flex;
      flex-direction: column;
      gap: 10px;
      flex: 0 0 auto;
    }
    .rc-title-row { display: flex; align-items: center; gap: 10px; }
    .rc-title {
      font-family: var(--serif);
      font-size: 18px;
      font-weight: 600;
      letter-spacing: -0.01em;
      color: var(--ink);
    }
    .rc-icon-btn {
      background: transparent;
      border: none;
      color: var(--muted);
      cursor: pointer;
      font-size: 18px;
      line-height: 1;
      width: 22px;
      height: 22px;
      padding: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 3px;
    }
    .rc-icon-btn:hover { background: var(--surface-2); color: var(--ink); }
    .rc-search {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 10px;
      border: 1px solid var(--hairline-strong);
      border-radius: 5px;
      background: var(--surface);
      transition: border-color 0.15s, box-shadow 0.15s;
    }
    .rc-search:focus-within {
      border-color: var(--accent);
      box-shadow: 0 0 0 2px var(--accent-soft);
    }
    .rc-search-icon { color: var(--muted); flex: 0 0 12px; }
    .rc-search-input {
      flex: 1;
      border: none;
      background: transparent;
      outline: none;
      font-size: 13px;
      font-family: var(--sans);
      color: var(--ink);
    }

    /* ── Body ── */
    .rc-body {
      flex: 1;
      overflow-y: auto;
      overflow-x: hidden;
      padding: 0 0 24px 0;
    }
    .rc-body::-webkit-scrollbar { width: 8px; }
    .rc-body::-webkit-scrollbar-thumb { background: var(--hairline-strong); border-radius: 4px; }

    /* ── Intro ── */
    .rc-intro { padding: 18px 18px 24px; }
    .rc-intro-blurb {
      font-size: 12.5px;
      color: var(--ink-2);
      font-style: italic;
      margin-top: 8px;
      line-height: 1.55;
    }
    .rc-suggestions { display: flex; flex-direction: column; gap: 4px; margin-top: 6px; }
    .rc-suggest {
      background: transparent;
      border: none;
      padding: 5px 8px;
      margin: 0 -4px;
      border-radius: 4px;
      text-align: left;
      font-size: 12.5px;
      color: var(--ink-2);
      cursor: pointer;
      font-family: var(--sans);
      font-style: italic;
    }
    .rc-suggest:hover { background: var(--surface-2); }

    /* ── Empty ── */
    .rc-empty { padding: 40px 22px; color: var(--muted); font-style: italic; }
    .rc-empty-title { font-family: var(--serif); font-size: 15px; margin-bottom: 6px; color: var(--ink-2); }
    .rc-empty-sub { font-size: 12.5px; }

    /* ── Current chat section ── */
    .rc-current-wrap { padding: 16px 18px 0; }
    .rc-section-header { margin-bottom: 6px; }
    .rc-current {
      padding: 12px 14px;
      background: var(--surface);
      border: 1px solid var(--hairline);
      border-radius: 4px;
    }
    .rc-current-title {
      font-family: var(--serif);
      font-size: 14px;
      font-weight: 600;
      color: var(--ink);
      line-height: 1.3;
      margin-bottom: 6px;
    }
    .rc-current-title-muted {
      font-family: var(--serif);
      font-size: 13.5px;
      font-style: italic;
      color: var(--muted);
      margin-bottom: 4px;
    }
    .rc-current-meta {
      display: flex;
      align-items: center;
      gap: 7px;
      font-size: 11px;
      color: var(--muted);
      margin-bottom: 10px;
    }
    .rc-current-why {
      font-size: 11.5px;
      color: var(--muted);
      font-style: italic;
      line-height: 1.5;
    }
    .rc-current-unknown { border-style: dashed; }
    .rc-empty-inline {
      font-size: 11.5px;
      color: var(--muted);
      font-style: italic;
      padding: 6px 0 4px;
    }

    /* ── Hero card ── */
    .rc-hero-wrap { padding: 16px 18px 0; }
    .rc-hero {
      padding: 14px 16px 14px;
      background: var(--surface);
      border: 1px solid var(--hairline-strong);
      border-radius: 4px;
      box-shadow: 0 1px 0 rgba(60,50,40,0.05);
    }
    .rc-pulse { animation: rcPulseGlow 2.4s ease-out 1; }
    @keyframes rcPulseGlow {
      0%   { box-shadow: 0 0 0 0 transparent; }
      15%  { box-shadow: 0 0 0 6px var(--highlight); }
      100% { box-shadow: 0 0 0 0 transparent; }
    }
    .rc-hero-header { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
    .rc-spark { color: var(--accent); font-size: 13px; }
    .rc-hero-title {
      font-family: var(--serif);
      font-size: 16px;
      font-weight: 600;
      line-height: 1.25;
      color: var(--ink);
      margin-bottom: 6px;
    }
    .rc-hero-why {
      font-size: 11.5px;
      color: var(--muted);
      font-style: italic;
      margin-bottom: 10px;
      line-height: 1.5;
    }
    .rc-hero-meta {
      display: flex;
      align-items: center;
      gap: 7px;
      font-size: 11px;
      color: var(--muted);
      margin-bottom: 10px;
    }
    .rc-provider {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--p, var(--muted));
      display: inline-block;
    }
    .rc-hero-divider {
      height: 1px;
      background: var(--hairline);
      margin: 0 0 10px 0;
    }

    /* ── Chapter list ── */
    .rc-chapter-list { display: flex; flex-direction: column; gap: 1px; margin-bottom: 12px; }
    .rc-chapter {
      background: transparent;
      border: none;
      padding: 4px 6px;
      margin: 0 -6px;
      border-radius: 3px;
      cursor: pointer;
      text-align: left;
      display: flex;
      align-items: baseline;
      gap: 8px;
      font-family: var(--sans);
      color: var(--ink-2);
      line-height: 1.35;
    }
    .rc-chapter:hover { background: var(--surface-2); }
    .rc-chapter-num {
      font-size: 9.5px;
      color: var(--muted-2);
      flex: 0 0 18px;
    }
    .rc-chapter-title {
      font-family: var(--serif);
      font-size: 12.5px;
      font-weight: 500;
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
    }
    .rc-chapter-active .rc-chapter-title {
      color: var(--accent);
      font-weight: 600;
      text-decoration: underline;
      text-decoration-color: var(--accent-soft);
      text-underline-offset: 2px;
    }

    /* ── CTA ── */
    .rc-cta {
      width: 100%;
      padding: 9px 12px;
      background: var(--accent);
      color: #f6f0e3;
      border: none;
      border-radius: 3px;
      cursor: pointer;
      font-size: 12.5px;
      font-family: var(--sans);
      font-weight: 600;
      letter-spacing: 0.02em;
      text-align: center;
      transition: filter 0.1s;
    }
    .rc-cta:hover { filter: brightness(1.08); }

    /* ── Others ── */
    .rc-others { padding: 22px 18px 0; }
    .rc-others-header { margin-bottom: 8px; }
    .rc-others-list { display: flex; flex-direction: column; gap: 8px; }
    .rc-card {
      background: transparent;
      border: 1px solid var(--hairline);
      border-radius: 3px;
      padding: 10px 12px;
      cursor: pointer;
      text-align: left;
      display: flex;
      flex-direction: column;
      gap: 5px;
      color: var(--ink-2);
      font-family: var(--sans);
      transition: border-color 0.12s, background 0.12s;
    }
    .rc-card:hover { border-color: var(--hairline-strong); background: var(--surface); }
    .rc-card-title {
      font-family: var(--serif);
      font-size: 13px;
      font-weight: 600;
      line-height: 1.3;
      color: var(--ink);
    }
    .rc-card-meta {
      display: flex;
      align-items: center;
      gap: 7px;
      font-size: 10.5px;
      color: var(--muted);
    }
    .rc-card-why {
      font-size: 11px;
      color: var(--muted);
      font-style: italic;
      line-height: 1.45;
    }

    /* ── Memory recall (hero) ── */
    .rc-mem-wrap {
      padding: 16px 18px 4px;
    }
    .rc-mem-header {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 10px;
    }
    .rc-mem-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-bottom: 12px;
    }
    .rc-mem {
      padding: 10px 12px;
      background: var(--surface);
      border: 1px solid var(--hairline-strong);
      border-radius: 5px;
      border-left: 3px solid var(--accent-soft);
    }
    .rc-mem-top {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-bottom: 6px;
    }
    .rc-mem-kind {
      font-family: var(--sans);
      font-size: 9.5px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.09em;
      color: var(--k, var(--accent));
      padding: 1px 6px;
      border-radius: 3px;
      background: color-mix(in srgb, var(--k, var(--accent)) 12%, transparent);
    }
    .rc-mem-pin { font-size: 10px; }
    .rc-mem-inject {
      background: transparent;
      border: 1px solid var(--hairline-strong);
      color: var(--accent);
      cursor: pointer;
      font-family: var(--mono);
      font-size: 10px;
      padding: 2px 8px;
      border-radius: 4px;
      transition: background 0.1s, border-color 0.1s;
    }
    .rc-mem-inject:hover { background: var(--surface-2); border-color: var(--accent-soft); }
    .rc-mem-text {
      font-family: var(--serif);
      font-size: 13px;
      line-height: 1.4;
      color: var(--ink);
    }
    .rc-mem-src {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-top: 6px;
      font-size: 10px;
      color: var(--muted);
      font-family: var(--mono);
    }
    .rc-mem-cta { margin-bottom: 4px; }

    /* ── Toast ── */
    .rc-toast {
      position: absolute;
      bottom: 52px;
      left: 50%;
      transform: translateX(-50%);
      background: var(--ink);
      color: var(--bg);
      font-family: var(--sans);
      font-size: 12px;
      font-weight: 500;
      padding: 8px 16px;
      border-radius: 20px;
      box-shadow: 0 4px 16px rgba(40,30,20,0.25);
      animation: rcToastIn 0.18s ease-out;
      white-space: nowrap;
      z-index: 10;
    }
    @keyframes rcToastIn {
      from { opacity: 0; transform: translateX(-50%) translateY(6px); }
      to   { opacity: 1; transform: translateX(-50%) translateY(0); }
    }

    /* ── Footer ── */
    .rc-footer {
      padding: 8px 18px;
      border-top: 1px solid var(--hairline);
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 10.5px;
      color: var(--muted);
      background: var(--bg);
      flex: 0 0 auto;
    }
    .rc-dot { width: 6px; height: 6px; border-radius: 50%; }
    .rc-dot-green { background: #1f7a64; }
    .rc-link { color: var(--muted); text-decoration: none; white-space: nowrap; }
    .rc-link:hover { color: var(--accent); }
  `;
