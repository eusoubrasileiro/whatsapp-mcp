import type { InstanceView } from "./poller.ts";
import { en, fill, type Strings } from "./strings.ts";
import { STYLE } from "./style.ts";

/** How often the page asks `/_hub/status.json` for the current picture. */
export const PAGE_POLL_INTERVAL_MS = 2000;

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ESCAPES[char]);
}

/** "less than a minute", "12 min", "2 h 5 min". The page script has the same rule. */
export function formatDuration(seconds: number, t: Strings = en): string {
  if (seconds < 60) return t.durations.lessThanMinute;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return fill(t.durations.minutes, { n: minutes });
  return fill(t.durations.hoursMinutes, { h: Math.floor(minutes / 60), m: minutes % 60 });
}

export function stateText(view: InstanceView, t: Strings = en): string {
  return view.state === "down"
    ? fill(t.states.down, { duration: formatDuration(view.down_for_s ?? 0, t) })
    : t.states[view.state];
}

/** One small outline icon per state, so the state is never told by colour alone. */
const ICONS: Record<InstanceView["state"], string> = {
  connected: '<circle cx="12" cy="12" r="9"/><path d="M7.5 12.5l3 3 6-6.5"/>',
  waiting_qr:
    '<rect x="3.5" y="3.5" width="6.5" height="6.5" rx="1"/><rect x="14" y="3.5" width="6.5" height="6.5" rx="1"/><rect x="3.5" y="14" width="6.5" height="6.5" rx="1"/><path d="M14 14h3v3h-3zM20.5 14v3.5M14 20.5h3M20.5 20.5h.01"/>',
  starting: '<path d="M12 3a9 9 0 1 0 9 9"/>',
  disconnected: '<circle cx="12" cy="12" r="9"/><path d="M5.7 5.7l12.6 12.6"/>',
  down: '<path d="M12 3.5l9.5 16.5h-19z"/><path d="M12 10v4.5M12 17.2v.01"/>',
  mismatch: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5v.01"/>',
};

function icons(): string {
  return Object.entries(ICONS)
    .map(
      ([state, shape]) =>
        `<svg class="ico ico-${state}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${shape}</svg>`,
    )
    .join("");
}

function scanSentence(view: InstanceView, t: Strings): string {
  return fill(view.phone_last4 ? t.scan.withDigits : t.scan.withoutDigits, {
    label: view.label,
    last4: view.phone_last4 ?? "",
  });
}

function qrUrl(view: InstanceView): string {
  return `/_hub/qr/${view.label}.png?rev=${view.qr_rev}`;
}

function renderCard(view: InstanceView, target: string | null, t: Strings): string {
  const showQr = view.state === "waiting_qr" && view.qr_rev !== null;
  const label = escapeHtml(view.label);
  const classes = view.label === target ? "card is-target" : "card";
  return `<article class="${classes}" id="card-${label}" data-label="${label}" data-state="${view.state}"${view.label === target ? ' aria-current="location"' : ""}>
<h2 class="label">${label}</h2>
<p class="state" role="status">${icons()}<span data-role="state-text">${escapeHtml(stateText(view, t))}</span></p>
<p class="desc" data-role="desc"${view.description ? "" : " hidden"}>${escapeHtml(view.description ?? "")}</p>
<p class="digits" data-role="digits"${view.phone_last4 ? "" : " hidden"}>${escapeHtml(view.phone_last4 ? fill(t.numberEnding, { last4: view.phone_last4 }) : "")}</p>
<div class="qr" data-role="qr"${showQr ? "" : " hidden"}>
<p class="qr-help" data-role="qr-help">${escapeHtml(scanSentence(view, t))}</p>
<div class="qr-frame"><img class="qr-img" data-role="qr-img" width="512" height="512" alt="${escapeHtml(fill(t.scan.imageAlt, { label: view.label }))}"${showQr ? ` src="${escapeHtml(qrUrl(view))}"` : ""}></div>
</div>
</article>`;
}

/** The page's own script: patches the cards from `/_hub/status.json`. Plain ES5, no dependencies. */
function clientScript(t: Strings): string {
  const words = JSON.stringify({
    states: t.states,
    durations: t.durations,
    numberEnding: t.numberEnding,
    scan: t.scan,
  }).replace(/</g, "\\u003c");
  return `(function () {
var T = ${words};
var INTERVAL = ${PAGE_POLL_INTERVAL_MS};
var cards = {};
document.querySelectorAll(".card").forEach(function (c) { cards[c.dataset.label] = c; });
function fill(tpl, v) { return tpl.replace(/\\{(\\w+)\\}/g, function (m, k) { return k in v ? v[k] : m; }); }
function duration(s) {
  if (s < 60) return T.durations.lessThanMinute;
  var m = Math.floor(s / 60);
  if (m < 60) return fill(T.durations.minutes, { n: m });
  return fill(T.durations.hoursMinutes, { h: Math.floor(m / 60), m: m % 60 });
}
function stateText(v) {
  return v.state === "down" ? fill(T.states.down, { duration: duration(v.down_for_s || 0) }) : T.states[v.state];
}
function part(card, role) { return card.querySelector('[data-role="' + role + '"]'); }
function patch(card, v) {
  card.dataset.state = v.state;
  part(card, "state-text").textContent = stateText(v);
  var desc = part(card, "desc");
  desc.textContent = v.description || "";
  desc.hidden = !v.description;
  var digits = part(card, "digits");
  digits.textContent = v.phone_last4 ? fill(T.numberEnding, { last4: v.phone_last4 }) : "";
  digits.hidden = !v.phone_last4;
  var show = v.state === "waiting_qr" && !!v.qr_rev;
  part(card, "qr").hidden = !show;
  if (!show) return;
  part(card, "qr-help").textContent = fill(v.phone_last4 ? T.scan.withDigits : T.scan.withoutDigits, { label: v.label, last4: v.phone_last4 || "" });
  var img = part(card, "qr-img");
  var src = "/_hub/qr/" + v.label + ".png?rev=" + v.qr_rev;
  if (img.getAttribute("src") !== src) img.setAttribute("src", src);
}
var busy = false;
var offline = document.getElementById("offline");
function poll() {
  if (busy || document.hidden) return;
  busy = true;
  fetch("/_hub/status.json", { cache: "no-store", credentials: "same-origin" })
    .then(function (r) {
      if (r.status === 401) { location.reload(); return null; }
      if (!r.ok) throw new Error("status " + r.status);
      return r.json();
    })
    .then(function (d) {
      if (!d) return;
      offline.hidden = true;
      d.instances.forEach(function (v) { if (cards[v.label]) patch(cards[v.label], v); });
    })
    .catch(function () { offline.hidden = false; })
    .then(function () { busy = false; });
}
setInterval(poll, INTERVAL);
document.addEventListener("visibilitychange", poll);
var target = document.querySelector(".is-target");
if (target) target.scrollIntoView({ block: "start" });
})();`;
}

function document(options: {
  nonce: string;
  title: string;
  body: string;
  script?: string;
}): string {
  const nonce = escapeHtml(options.nonce);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex">
<title>${escapeHtml(options.title)}</title>
<style nonce="${nonce}">${STYLE}</style>
</head>
<body>
${options.body}
${options.script ? `<script nonce="${nonce}">${options.script}</script>` : ""}
</body>
</html>
`;
}

export interface HubPageOptions {
  nonce: string;
  views: InstanceView[];
  /** The label to highlight and scroll to, when the address was `/<label>`. */
  target?: string | null;
  /** A label that was asked for and does not exist; the page says so. */
  unknownLabel?: string | null;
  t?: Strings;
}

export function renderHubPage(options: HubPageOptions): string {
  const t = options.t ?? en;
  const notice = options.unknownLabel
    ? `<p class="notice" role="alert">${escapeHtml(fill(t.unknownLabel, { label: options.unknownLabel }))}</p>`
    : "";
  const body = `<div class="wrap">
<header class="top"><h1>${escapeHtml(t.title)}</h1><p class="live">${escapeHtml(t.liveNote)}</p></header>
<p class="offline" id="offline" role="alert" hidden>${escapeHtml(t.offline)}</p>
${notice}
<main class="cards">
${options.views.map((view) => renderCard(view, options.target ?? null, t)).join("\n")}
</main>
</div>`;
  return document({ nonce: options.nonce, title: t.title, body, script: clientScript(t) });
}

export interface PinFormOptions {
  nonce: string;
  /** Where the visitor is sent after a right PIN. Must already be a safe path. */
  next: string;
  /** Show the "did not work" sentence. */
  failed: boolean;
  t?: Strings;
}

export function renderPinForm(options: PinFormOptions): string {
  const t = options.t ?? en;
  const error = options.failed
    ? `<p class="error" role="alert">${escapeHtml(t.pin.wrong)}</p>`
    : "";
  const body = `<main class="gate">
<form class="gate-card" method="post" action="/_hub/login">
<h1>${escapeHtml(t.pin.title)}</h1>
${error}
<label for="pin">${escapeHtml(t.pin.field)}</label>
<input id="pin" class="pin" name="pin" type="password" autocomplete="current-password" autofocus required>
<input type="hidden" name="next" value="${escapeHtml(options.next)}">
<button class="btn" type="submit">${escapeHtml(t.pin.submit)}</button>
</form>
</main>`;
  return document({ nonce: options.nonce, title: t.pin.title, body });
}

export function renderLockedPage(options: { nonce: string; t?: Strings }): string {
  const t = options.t ?? en;
  const body = `<main class="gate">
<div class="gate-card">
<h1>${escapeHtml(t.pin.lockedTitle)}</h1>
<p>${escapeHtml(t.pin.locked)}</p>
</div>
</main>`;
  return document({ nonce: options.nonce, title: t.pin.lockedTitle, body });
}
