/**
 * The hub's one stylesheet, inlined into every page under the response's CSP nonce. No font, image
 * or script comes from anywhere else. Colours are tokens on `:root`; dark mode redefines them.
 */
export const STYLE = `
:root {
  color-scheme: light dark;
  --page: #f3f0e8;
  --surface: #fffdf8;
  --ink: #1c2420;
  --muted: #566159;
  --line: #d9d3c4;
  --focus: #1b5fc7;
  --connected-fg: #0b5f31; --connected-bg: #d9f1e1; --connected-bar: #1f9d55;
  --waiting-fg: #7a4100; --waiting-bg: #ffe6b8; --waiting-bar: #e08a00;
  --starting-fg: #24476d; --starting-bg: #dbe8f6; --starting-bar: #3b82c4;
  --disconnected-fg: #41474a; --disconnected-bg: #e4e1d9; --disconnected-bar: #8b918c;
  --down-fg: #8f1818; --down-bg: #fadada; --down-bar: #d33b3b;
}
@media (prefers-color-scheme: dark) {
  :root {
    --page: #0f1411;
    --surface: #19201b;
    --ink: #e8eee7;
    --muted: #9aa69c;
    --line: #2b352e;
    --focus: #7db0ff;
    --connected-fg: #86e3a9; --connected-bg: #13331f; --connected-bar: #2fbf6c;
    --waiting-fg: #ffd47a; --waiting-bg: #3b2a08; --waiting-bar: #f0a020;
    --starting-fg: #a9cdf5; --starting-bg: #172b43; --starting-bar: #5a9fe0;
    --disconnected-fg: #c5cbc6; --disconnected-bg: #2a302c; --disconnected-bar: #7d857f;
    --down-fg: #ffadad; --down-bg: #3d1717; --down-bar: #ea5a5a;
  }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  background: var(--page);
  color: var(--ink);
  font: 16px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
}
:focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; }

.wrap { max-width: 1200px; margin: 0 auto; padding: 20px 12px 56px; }
.top { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 4px 16px; margin: 0 0 16px; }
.top h1 { margin: 0; font-size: 1.25rem; font-weight: 700; letter-spacing: -0.005em; }
.live { margin: 0; color: var(--muted); font-size: 0.875rem; }
.offline, .notice {
  margin: 0 0 16px; padding: 12px 14px; border-radius: 12px; font-weight: 600;
}
.offline { background: var(--down-bg); color: var(--down-fg); }
.notice { background: var(--waiting-bg); color: var(--waiting-fg); }
.offline[hidden] { display: none; }

.cards { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(min(100%, 340px), 1fr)); align-items: start; }

.card {
  --state-fg: var(--disconnected-fg); --state-bg: var(--disconnected-bg); --state-bar: var(--disconnected-bar);
  position: relative;
  scroll-margin-top: 16px;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 16px;
  padding: 18px 14px 16px 22px;
  box-shadow: 0 1px 2px rgb(0 0 0 / 0.05), 0 8px 22px rgb(0 0 0 / 0.05);
}
.card::before {
  content: ""; position: absolute; left: 0; top: 16px; bottom: 16px; width: 6px;
  border-radius: 0 6px 6px 0; background: var(--state-bar);
}
.card[data-state="connected"] { --state-fg: var(--connected-fg); --state-bg: var(--connected-bg); --state-bar: var(--connected-bar); }
.card[data-state="waiting_qr"] { --state-fg: var(--waiting-fg); --state-bg: var(--waiting-bg); --state-bar: var(--waiting-bar); }
.card[data-state="starting"] { --state-fg: var(--starting-fg); --state-bg: var(--starting-bg); --state-bar: var(--starting-bar); }
.card[data-state="down"], .card[data-state="mismatch"] { --state-fg: var(--down-fg); --state-bg: var(--down-bg); --state-bar: var(--down-bar); }
.card.is-target { outline: 3px solid var(--state-bar); outline-offset: 3px; }

.label { margin: 0; font-size: 1.75rem; line-height: 1.15; font-weight: 750; letter-spacing: -0.01em; overflow-wrap: anywhere; }
.state {
  display: inline-flex; align-items: flex-start; gap: 8px; text-wrap: balance;
  margin: 12px 0 0; padding: 6px 14px 6px 10px; border-radius: 16px;
  background: var(--state-bg); color: var(--state-fg);
  font-size: 0.9rem; font-weight: 650; line-height: 1.3;
}
.ico { display: none; flex: none; width: 20px; height: 20px; margin-top: 1px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.card[data-state="connected"] .ico-connected,
.card[data-state="waiting_qr"] .ico-waiting_qr,
.card[data-state="starting"] .ico-starting,
.card[data-state="disconnected"] .ico-disconnected,
.card[data-state="down"] .ico-down,
.card[data-state="mismatch"] .ico-mismatch { display: block; }
.ico-starting { animation: spin 1.1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .ico-starting { animation: none; } }

.desc { margin: 14px 0 0; }
.digits { margin: 2px 0 0; color: var(--muted); font-variant-numeric: tabular-nums; }
.desc[hidden], .digits[hidden], .qr[hidden] { display: none; }

.qr { margin-top: 18px; }
.qr-help { margin: 0 0 12px; font-size: 1.0625rem; line-height: 1.45; }
.qr-frame { background: #fff; border: 1px solid var(--line); border-radius: 14px; padding: 10px; }
.qr-img { display: block; width: 100%; max-width: 420px; height: auto; margin: 0 auto; aspect-ratio: 1; image-rendering: pixelated; }

.connect { margin-top: 18px; border-top: 1px solid var(--line); padding-top: 4px; }
.connect summary {
  display: flex; align-items: center; gap: 10px; min-height: 44px; cursor: pointer;
  font-weight: 650; list-style: none; border-radius: 8px;
}
.connect summary::-webkit-details-marker { display: none; }
.connect summary::before {
  content: ""; flex: none; width: 8px; height: 8px; margin: 0 4px 2px 2px;
  border-right: 2px solid var(--muted); border-bottom: 2px solid var(--muted);
  transform: rotate(-45deg); transition: transform 0.12s ease;
}
.connect[open] summary::before { transform: rotate(45deg); }
@media (prefers-reduced-motion: reduce) { .connect summary::before { transition: none; } }
.connect-body { display: grid; gap: 14px; padding: 6px 0 4px; }
.snippet-title { margin: 0 0 6px; font-size: 0.875rem; font-weight: 650; color: var(--muted); }
.snippet-box { display: grid; gap: 8px; }
.code {
  margin: 0; padding: 10px 12px; background: var(--page); border: 1px solid var(--line); border-radius: 12px;
  font: 0.8125rem/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  white-space: pre-wrap; overflow-wrap: anywhere;
}
.copy {
  justify-self: start; min-height: 44px; padding: 8px 16px; font: inherit; font-size: 0.9rem; font-weight: 650;
  color: var(--ink); background: transparent; border: 1px solid var(--line); border-radius: 12px; cursor: pointer;
}
.token-note { margin: 0; color: var(--muted); font-size: 0.875rem; }

.unlink-link {
  display: inline-flex; align-items: center; min-height: 44px; margin-top: 4px; padding: 0 2px;
  color: var(--down-fg); font-weight: 650; text-decoration: underline; text-underline-offset: 3px; border-radius: 8px;
}

.gate { min-height: 100vh; min-height: 100dvh; display: grid; place-items: center; padding: 16px; }
.gate-card {
  width: 100%; max-width: 380px; padding: 24px 20px;
  background: var(--surface); border: 1px solid var(--line); border-radius: 16px;
  box-shadow: 0 1px 2px rgb(0 0 0 / 0.05), 0 8px 22px rgb(0 0 0 / 0.05);
}
.gate-card h1 { margin: 0 0 16px; font-size: 1.375rem; font-weight: 750; letter-spacing: -0.01em; }
.gate-card p { margin: 0; }
.gate-card label { display: block; margin-bottom: 6px; font-weight: 650; }
.error { margin: 0 0 16px !important; padding: 10px 12px; border-radius: 10px; background: var(--down-bg); color: var(--down-fg); font-weight: 600; }
.pin {
  width: 100%; padding: 14px; font: inherit; font-size: 1.25rem; letter-spacing: 0.12em;
  color: var(--ink); background: var(--page); border: 1px solid var(--line); border-radius: 12px;
}
.btn {
  width: 100%; margin-top: 14px; padding: 14px; font: inherit; font-weight: 700;
  color: var(--surface); background: var(--ink); border: 0; border-radius: 12px; cursor: pointer;
}

.who { margin: -8px 0 16px !important; color: var(--muted); font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.warning {
  margin: 0 0 16px; padding: 12px 14px; border-radius: 12px;
  background: var(--waiting-bg); color: var(--waiting-fg); border-left: 6px solid var(--waiting-bar);
}
.warning h2 { margin: 0 0 8px; font-size: 1.1rem; font-weight: 800; line-height: 1.25; }
.warning p { margin: 0; font-weight: 500; line-height: 1.5; }
.effect { margin: 0 0 18px !important; color: var(--muted); }
.unlink .pin { margin-bottom: 14px; letter-spacing: normal; }
.unlink label { margin-top: 2px; }
.btn { display: block; text-align: center; text-decoration: none; }
.btn-danger { background: var(--down-fg); color: var(--surface); }
.cancel {
  display: flex; align-items: center; justify-content: center; min-height: 44px; margin-top: 6px;
  color: var(--muted); font-weight: 650; text-decoration: underline; text-underline-offset: 3px; border-radius: 8px;
}

@media (min-width: 720px) {
  .wrap { padding: 32px 24px 64px; }
  .card { padding: 22px 22px 20px 28px; }
  .qr-frame { padding: 14px; }
}
`;
