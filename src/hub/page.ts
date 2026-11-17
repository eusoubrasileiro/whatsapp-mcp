import type { InstanceView } from "./poller.ts";
import { en, fill, type Strings } from "./strings.ts";
import { STYLE } from "./style.ts";
import type { UnlinkOutcome } from "./unlink.ts";

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

/** Where an MCP client reaches the number `label` through this hub's public address. */
export function mcpUrl(publicUrl: string, label: string): string {
  return `${publicUrl}/${label}/mcp`;
}

/** The token is never known here: every snippet carries this placeholder in its place. */
const TOKEN_PLACEHOLDER = "<token>";

/** One titled snippet and the button that copies it. */
function snippet(id: string, title: string, text: string, t: Strings): string {
  return `<div class="snippet">
<p class="snippet-title">${escapeHtml(title)}</p>
<div class="snippet-box"><pre class="code" id="${escapeHtml(id)}">${escapeHtml(text)}</pre><button class="copy" type="button" data-copy="${escapeHtml(id)}">${escapeHtml(t.connect.copy)}</button></div>
</div>`;
}

/** The collapsed "connect a client" block: the address and the two documented config forms. */
function renderConnect(view: InstanceView, publicUrl: string, t: Strings): string {
  const url = mcpUrl(publicUrl, view.label);
  const name = `whatsapp-${view.label}`;
  const entry = `${JSON.stringify(name)}: ${JSON.stringify(
    { type: "http", url, headers: { Authorization: `Bearer ${TOKEN_PLACEHOLDER}` } },
    null,
    2,
  )}`;
  const command = `claude mcp add --transport http ${name} ${url} --header "Authorization: Bearer ${TOKEN_PLACEHOLDER}"`;
  const id = (part: string) => `snip-${view.label}-${part}`;
  return `<details class="connect">
<summary>${escapeHtml(t.connect.summary)}</summary>
<div class="connect-body">
${snippet(id("url"), t.connect.addressTitle, url, t)}
${snippet(id("entry"), t.connect.jsonTitle, entry, t)}
${snippet(id("command"), t.connect.commandTitle, command, t)}
<p class="token-note">${escapeHtml(t.connect.tokenNote)}</p>
</div>
</details>`;
}

/** What every card needs besides its own view. */
interface CardContext {
  target: string | null;
  publicUrl: string;
  /** Whether the hub can unlink numbers: the card then links to the confirmation page. */
  canUnlink: boolean;
  t: Strings;
}

function renderCard(view: InstanceView, { target, publicUrl, canUnlink, t }: CardContext): string {
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
${renderConnect(view, publicUrl, t)}
${canUnlink ? `<a class="unlink-link" href="/_hub/unlink/${label}">${escapeHtml(t.unlink.open)}</a>` : ""}
</article>`;
}

/** The page's own script: patches the cards from `/_hub/status.json`. Plain ES5, no dependencies. */
function clientScript(t: Strings): string {
  const words = JSON.stringify({
    states: t.states,
    durations: t.durations,
    numberEnding: t.numberEnding,
    scan: t.scan,
    connect: { copy: t.connect.copy, copied: t.connect.copied, selected: t.connect.selected },
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
function say(button, text) {
  button.textContent = text;
  clearTimeout(button.resetTimer);
  button.resetTimer = setTimeout(function () { button.textContent = T.connect.copy; }, 2000);
}
function selectText(node) {
  var range = document.createRange();
  range.selectNodeContents(node);
  var selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}
document.addEventListener("click", function (event) {
  var button = event.target && event.target.closest ? event.target.closest("[data-copy]") : null;
  var source = button && document.getElementById(button.getAttribute("data-copy"));
  if (!source) return;
  var fallback = function () { selectText(source); say(button, T.connect.selected); };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(source.textContent).then(function () { say(button, T.connect.copied); }, fallback);
  } else {
    fallback();
  }
});
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
  lang: string;
  title: string;
  body: string;
  script?: string;
}): string {
  const nonce = escapeHtml(options.nonce);
  return `<!doctype html>
<html lang="${escapeHtml(options.lang)}">
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
  /** The hub's own public origin: the MCP addresses on the cards are built from it. */
  publicUrl: string;
  /** The label to highlight and scroll to, when the address was `/<label>`. */
  target?: string | null;
  /** A label that was asked for and does not exist; the page says so. */
  unknownLabel?: string | null;
  /** Show "unlink this number" on every card. Only when the hub holds the instances' secret. */
  canUnlink?: boolean;
  t?: Strings;
}

export function renderHubPage(options: HubPageOptions): string {
  const t = options.t ?? en;
  const notice = options.unknownLabel
    ? `<p class="notice" role="alert">${escapeHtml(fill(t.unknownLabel, { label: options.unknownLabel }))}</p>`
    : "";
  const card: CardContext = {
    target: options.target ?? null,
    publicUrl: options.publicUrl,
    canUnlink: options.canUnlink ?? false,
    t,
  };
  const body = `<div class="wrap">
<header class="top"><h1>${escapeHtml(t.title)}</h1><p class="live">${escapeHtml(t.liveNote)}</p></header>
<p class="offline" id="offline" role="alert" hidden>${escapeHtml(t.offline)}</p>
${notice}
<main class="cards">
${options.views.map((view) => renderCard(view, card)).join("\n")}
</main>
</div>`;
  return document({
    nonce: options.nonce,
    lang: t.htmlLang,
    title: t.title,
    body,
    script: clientScript(t),
  });
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
  return document({ nonce: options.nonce, lang: t.htmlLang, title: t.pin.title, body });
}

export function renderLockedPage(options: { nonce: string; t?: Strings }): string {
  const t = options.t ?? en;
  const body = `<main class="gate">
<div class="gate-card">
<h1>${escapeHtml(t.pin.lockedTitle)}</h1>
<p>${escapeHtml(t.pin.locked)}</p>
</div>
</main>`;
  return document({ nonce: options.nonce, lang: t.htmlLang, title: t.pin.lockedTitle, body });
}

/** Why the confirmation page is being shown again: the key of the sentence in `t.unlink`. */
export type UnlinkError = "expired" | "locked" | "wrongPin" | "wrongLabel";

export interface UnlinkPageOptions {
  nonce: string;
  view: InstanceView;
  /** The form's anti-forgery token for this session and number. */
  csrf: string;
  /** Show this refusal above the form. */
  error?: UnlinkError | null;
  t?: Strings;
}

/** The confirmation page: what unlinking does, the restriction rule, and the form that does it. */
export function renderUnlinkPage(options: UnlinkPageOptions): string {
  const t = options.t ?? en;
  const { view } = options;
  const label = escapeHtml(view.label);
  const who = [
    view.description,
    view.phone_last4 ? fill(t.numberEnding, { last4: view.phone_last4 }) : null,
  ]
    .filter((part): part is string => Boolean(part))
    .map(escapeHtml)
    .join(" · ");
  const error = options.error
    ? `<p class="error" role="alert">${escapeHtml(t.unlink[options.error])}</p>`
    : "";
  const body = `<main class="gate">
<form class="gate-card unlink" method="post" action="/_hub/unlink/${label}">
<h1>${escapeHtml(fill(t.unlink.title, { label: view.label }))}</h1>
${who ? `<p class="who">${who}</p>` : ""}
${error}
<section class="warning" role="note">
<h2>${escapeHtml(t.unlink.warningTitle)}</h2>
<p>${escapeHtml(t.unlink.warning)}</p>
</section>
<p class="effect">${escapeHtml(fill(t.unlink.effect, { label: view.label }))}</p>
<label for="pin">${escapeHtml(t.unlink.pinField)}</label>
<input id="pin" class="pin" name="pin" type="password" autocomplete="current-password" required>
<label for="label">${escapeHtml(fill(t.unlink.labelField, { label: view.label }))}</label>
<input id="label" class="pin" name="label" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" required>
<input type="hidden" name="csrf" value="${escapeHtml(options.csrf)}">
<button class="btn btn-danger" type="submit">${escapeHtml(fill(t.unlink.submit, { label: view.label }))}</button>
<a class="cancel" href="/">${escapeHtml(t.unlink.cancel)}</a>
</form>
</main>`;
  return document({
    nonce: options.nonce,
    lang: t.htmlLang,
    title: fill(t.unlink.title, { label: view.label }),
    body,
  });
}

/** What the hub says after it asked: never the instance's own words, only these. */
export function renderUnlinkResult(options: {
  nonce: string;
  label: string;
  outcome: UnlinkOutcome;
  t?: Strings;
}): string {
  const t = options.t ?? en;
  const words = {
    unlinked: [t.unlink.unlinkedTitle, t.unlink.unlinked],
    not_connected: [t.unlink.notConnectedTitle, t.unlink.notConnected],
    failed: [t.unlink.failedTitle, t.unlink.failed],
  }[options.outcome];
  const [title, sentence] = words;
  const body = `<main class="gate">
<div class="gate-card">
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(fill(sentence, { label: options.label }))}</p>
<a class="btn" href="/">${escapeHtml(t.unlink.back)}</a>
</div>
</main>`;
  return document({ nonce: options.nonce, lang: t.htmlLang, title, body });
}
