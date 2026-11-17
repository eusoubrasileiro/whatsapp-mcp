import { describe, expect, it } from "vitest";
import {
  renderHubPage,
  renderUnlinkPage,
  renderUnlinkResult,
  type UnlinkError,
} from "../hub/page.ts";
import type { InstanceView } from "../hub/poller.ts";
import { fill, stringsFor } from "../hub/strings.ts";
import type { UnlinkOutcome } from "../hub/unlink.ts";
import { englishLeaks } from "./helpers/hub-english.ts";

const NONCE = "bm9uY2Utbm9uY2Utbm9uY2U=";
const CSRF = "c".repeat(64);

/** The rule from docs/account-restrictions.md, in the words each language's page must carry. */
const RULE = {
  en: "Never unlink or re-link a number while WhatsApp shows a restriction countdown on that phone. Linking again under a restriction makes it worse: a temporary restriction can turn into a longer one. Wait until the countdown ends.",
  "pt-BR":
    "Nunca desvincule nem vincule de novo um número enquanto o WhatsApp mostrar uma contagem regressiva de restrição no celular desse número. Vincular de novo durante a restrição piora a situação: uma restrição temporária pode virar uma restrição mais longa. Espere a contagem terminar.",
} as const;
const LANGS = ["en", "pt-BR"] as const;

function view(overrides: Partial<InstanceView> = {}): InstanceView {
  return {
    label: "empresa",
    description: "Company line",
    phone_last4: "1234",
    state: "connected",
    down_for_s: null,
    qr_rev: null,
    ...overrides,
  };
}

const confirmation = (
  lang: (typeof LANGS)[number] = "en",
  extra: { view?: InstanceView; error?: UnlinkError | null } = {},
) =>
  renderUnlinkPage({
    nonce: NONCE,
    view: extra.view ?? view(),
    csrf: CSRF,
    error: extra.error,
    t: stringsFor(lang),
  });

describe("the unlink button on a card", () => {
  const cards = (canUnlink?: boolean) =>
    renderHubPage({
      nonce: NONCE,
      publicUrl: "https://hub.example.com",
      views: [view(), view({ label: "pessoal" })],
      canUnlink,
    });

  it.each([
    ["not given", undefined],
    ["false", false],
  ])("is absent when unlinking is %s", (_name, canUnlink) => {
    const html = cards(canUnlink);

    expect(html).not.toContain("Unlink this number");
    expect(html).not.toContain("/_hub/unlink/");
  });

  it("is a link to that number's confirmation page, on every card, when unlinking is on", () => {
    const html = cards(true);

    for (const label of ["empresa", "pessoal"]) {
      expect(html).toContain(
        `<a class="unlink-link" href="/_hub/unlink/${label}">Unlink this number</a>`,
      );
    }
    expect(html.match(/\/_hub\/unlink\//g)).toHaveLength(2);
  });

  it("is in Portuguese under pt-BR", () => {
    const html = renderHubPage({
      nonce: NONCE,
      publicUrl: "https://hub.example.com",
      views: [view()],
      canUnlink: true,
      t: stringsFor("pt-BR"),
    });

    expect(html).toContain(">Desvincular este número</a>");
    expect(englishLeaks(html)).toEqual([]);
  });
});

describe.each(LANGS)("the confirmation page in %s", (lang) => {
  const t = stringsFor(lang);

  it("names the number and says what it is", () => {
    const html = confirmation(lang);

    expect(html).toContain(`<html lang="${t.htmlLang}">`);
    expect(html).toContain(`<h1>${fill(t.unlink.title, { label: "empresa" })}</h1>`);
    expect(html).toContain("Company line");
    expect(html).toContain(fill(t.numberEnding, { last4: "1234" }));
  });

  it("states the restriction rule, in full, before any field", () => {
    const html = confirmation(lang);

    const rule = html.indexOf(RULE[lang]);
    expect(rule).toBeGreaterThan(-1);
    expect(html).toContain(`<section class="warning" role="note">`);
    expect(html).toContain(t.unlink.warningTitle);
    expect(rule).toBeLessThan(html.indexOf("<input"));
    expect(html.indexOf(t.unlink.warningTitle)).toBeLessThan(rule);
  });

  it("explains what will happen", () => {
    expect(confirmation(lang)).toContain(fill(t.unlink.effect, { label: "empresa" }));
  });

  it("is a form that posts the PIN, the typed name and the hidden token to this number only", () => {
    const html = confirmation(lang);

    expect(html).toContain(
      '<form class="gate-card unlink" method="post" action="/_hub/unlink/empresa">',
    );
    expect(html).toMatch(/<input id="pin" class="pin" name="pin" type="password"[^>]*required>/);
    expect(html).toMatch(
      /<input id="label" class="pin" name="label" type="text"[^>]*autocomplete="off"[^>]*required>/,
    );
    expect(html).toContain(`<input type="hidden" name="csrf" value="${CSRF}">`);
    expect(html).toContain(fill(t.unlink.labelField, { label: "empresa" }).replace(/"/g, "&quot;"));
    expect(html).toContain(`>${fill(t.unlink.submit, { label: "empresa" })}</button>`);
    expect(html.match(/<form\b/g)).toHaveLength(1);
  });

  it("lets the visitor go back without doing anything", () => {
    expect(confirmation(lang)).toContain(`<a class="cancel" href="/">${t.unlink.cancel}</a>`);
  });

  it.each([["expired"], ["locked"], ["wrongPin"], ["wrongLabel"]] as const)(
    "shows only the %s sentence as an alert, and keeps the rule and the form",
    (error) => {
      const html = confirmation(lang, { error });

      expect(html).toContain(`<p class="error" role="alert">${t.unlink[error]}</p>`);
      expect(html.match(/role="alert"/g)).toHaveLength(1);
      expect(html).toContain(RULE[lang]);
      expect(html).toContain('name="csrf"');
    },
  );

  it("shows no alert when nothing went wrong", () => {
    expect(confirmation(lang)).not.toContain('role="alert"');
  });

  it("carries no script and no inline style, and no word of the other language", () => {
    expectPlain(confirmation(lang, { error: "wrongPin" }), lang);
  });

  it("leaves out the description and the digits when the number has neither", () => {
    const html = confirmation(lang, { view: view({ description: null, phone_last4: null }) });

    expect(html).not.toContain("1234");
    expect(html).not.toContain("null");
  });

  it("escapes a label, a description and a token that carry markup", () => {
    const html = renderUnlinkPage({
      nonce: NONCE,
      view: view({ label: 'a"><b>x', description: "<script>alert(1)</script>" }),
      csrf: '"><i>',
      t,
    });

    expect(html).not.toContain("<b>x");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<i>");
  });
});

describe.each(LANGS)("the result page in %s", (lang) => {
  const t = stringsFor(lang);
  const result = (outcome: UnlinkOutcome, label = "empresa") =>
    renderUnlinkResult({ nonce: NONCE, label, outcome, t });

  it.each([
    ["unlinked", t.unlink.unlinkedTitle, t.unlink.unlinked],
    ["not_connected", t.unlink.notConnectedTitle, t.unlink.notConnected],
    ["failed", t.unlink.failedTitle, t.unlink.failed],
  ] as const)("says %s in its own words and offers the way back", (outcome, title, sentence) => {
    const html = result(outcome);

    expect(html).toContain(`<html lang="${t.htmlLang}">`);
    expect(html).toContain(`<h1>${title}</h1>`);
    expect(html).toContain(escapeQuotes(fill(sentence, { label: "empresa" })));
    expect(html).toContain(`<a class="btn" href="/">${t.unlink.back}</a>`);
    expectPlain(html, lang);
  });

  it("names only the sentence of its own outcome", () => {
    const html = result("not_connected");

    expect(html).not.toContain(t.unlink.unlinkedTitle);
    expect(html).not.toContain(t.unlink.failedTitle);
  });

  it("escapes the label", () => {
    expect(result("unlinked", '<img src=x onerror="y">')).not.toContain("<img");
  });
});

/** No script, no inline style (the CSP forbids both), and nothing in English on a Portuguese page. */
function expectPlain(html: string, lang: (typeof LANGS)[number]): void {
  expect(html).not.toMatch(/<script\b/);
  expect(html).not.toMatch(/\sstyle="/);
  if (lang === "pt-BR") expect(englishLeaks(html)).toEqual([]);
}

/** The page escapes the double quotes the sentences are written with. */
function escapeQuotes(text: string): string {
  return text.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
