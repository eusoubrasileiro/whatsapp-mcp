import vm from "node:vm";
import { describe, expect, it } from "vitest";
import {
  escapeHtml,
  formatDuration,
  mcpUrl,
  PAGE_POLL_INTERVAL_MS,
  renderHubPage,
  renderLockedPage,
  renderPinForm,
  stateText,
} from "../hub/page.ts";
import type { InstanceView } from "../hub/poller.ts";
import { en, fill, type Strings, stringsFor } from "../hub/strings.ts";
import { englishLeaks } from "./helpers/hub-english.ts";

const NONCE = "bm9uY2Utbm9uY2Utbm9uY2U=";
const PUBLIC_URL = "https://hub.example.com";

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

describe("escapeHtml", () => {
  it("escapes the five characters that can open markup or end an attribute", () => {
    expect(escapeHtml(`<a href="x" onclick='y'>&`)).toBe(
      "&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;",
    );
  });

  it("leaves ordinary text alone", () => {
    expect(escapeHtml("Línea de la empresa 1234")).toBe("Línea de la empresa 1234");
  });
});

describe("formatDuration", () => {
  it.each([
    [0, "less than a minute"],
    [59, "less than a minute"],
    [60, "1 min"],
    [119, "1 min"],
    [3599, "59 min"],
    [3600, "1 h 0 min"],
    [7500, "2 h 5 min"],
    [90_000, "25 h 0 min"],
  ])("writes %i seconds as %s", (seconds, expected) => {
    expect(formatDuration(seconds)).toBe(expected);
  });

  it("takes its words from the table it is given", () => {
    const other: Strings = {
      ...en,
      durations: { lessThanMinute: "pochi istanti", minutes: "{n} minuti", hoursMinutes: "{h} h" },
    };

    expect(formatDuration(10, other)).toBe("pochi istanti");
    expect(formatDuration(600, other)).toBe("10 minuti");
    expect(formatDuration(7200, other)).toBe("2 h");
  });
});

describe("stateText", () => {
  it.each([
    ["connected", "Connected"],
    ["waiting_qr", "Waiting for you to scan the QR code"],
    ["starting", "Connecting…"],
    ["disconnected", "Disconnected"],
    ["mismatch", "Misconfigured: this address answers as another number"],
  ] as const)("says %s in plain words", (state, text) => {
    expect(stateText(view({ state }))).toBe(text);
  });

  it("says how long a number has been down, and treats a missing duration as under a minute", () => {
    expect(stateText(view({ state: "down", down_for_s: 725 }))).toBe("Down for 12 min");
    expect(stateText(view({ state: "down", down_for_s: null }))).toBe(
      "Down for less than a minute",
    );
  });
});

describe("fill", () => {
  it("fills known markers, repeats, and leaves unknown ones as written", () => {
    expect(fill("{a}-{a}-{b}-{c}", { a: 1, b: "x" })).toBe("1-1-x-{c}");
  });
});

describe("the string table", () => {
  it("has no empty string and no raw markup", () => {
    const walk = (node: unknown, path: string): void => {
      if (typeof node === "string") {
        expect(node.length, path).toBeGreaterThan(0);
        expect(node, path).not.toMatch(/[<>]/);
      } else {
        for (const [key, child] of Object.entries(node as object)) walk(child, `${path}.${key}`);
      }
    };
    walk(en, "en");
  });

  it("has a sentence for every state a card can be in", () => {
    const states: InstanceView["state"][] = [
      "connected",
      "waiting_qr",
      "starting",
      "disconnected",
      "down",
      "mismatch",
    ];
    for (const state of states) expect(en.states[state].length).toBeGreaterThan(0);
  });
});

describe("renderHubPage", () => {
  const page = (views: InstanceView[], extra: Record<string, unknown> = {}) =>
    renderHubPage({ nonce: NONCE, publicUrl: PUBLIC_URL, views, ...extra });

  it("escapes every value that came from an instance", () => {
    const html = page([
      view({
        label: "a-1",
        description: '<img src=x onerror="alert(1)"> & "quotes"',
        phone_last4: "1234",
      }),
    ]);

    expect(html).not.toContain("<img src=x");
    expect(html).toContain(
      "&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &quot;quotes&quot;",
    );
  });

  it("escapes the label of an unknown address in the notice", () => {
    const html = page([], { unknownLabel: "<b>x</b>" });

    expect(html).toContain("There is no number called &quot;&lt;b&gt;x&lt;/b&gt;&quot;.");
    expect(html).not.toContain("<b>x</b>");
  });

  it("puts the nonce on the style and the script, and says the page is English", () => {
    const html = page([view()]);

    expect(html).toContain(`<style nonce="${NONCE}">`);
    expect(html).toContain(`<script nonce="${NONCE}">`);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
    expect(html).toContain('<meta name="robots" content="noindex">');
  });

  it("gives each card an icon for every state, shown by the state, so colour is never alone", () => {
    const html = page([view()]);

    for (const state of [
      "connected",
      "waiting_qr",
      "starting",
      "disconnected",
      "down",
      "mismatch",
    ]) {
      expect(html).toContain(`class="ico ico-${state}"`);
      expect(html).toContain(`.card[data-state="${state}"] .ico-${state}`);
    }
  });

  it("hides the QR slot, the description and the digits when there is nothing to show", () => {
    const html = page([
      view({ description: null, phone_last4: null, state: "down", down_for_s: 5 }),
    ]);

    expect(html).toContain('data-role="qr" hidden>');
    expect(html).toContain('data-role="desc" hidden>');
    expect(html).toContain('data-role="digits" hidden>');
    expect(html).not.toContain(' src="');
  });

  it("shows the QR only for a waiting number that has an image", () => {
    const waiting = page([view({ state: "waiting_qr", qr_rev: "abcdef012345" })]);
    const noImage = page([view({ state: "waiting_qr", qr_rev: null })]);
    const connected = page([view({ state: "connected", qr_rev: "abcdef012345" })]);

    expect(waiting).toContain('src="/_hub/qr/empresa.png?rev=abcdef012345"');
    expect(waiting).toContain('data-role="qr">');
    expect(noImage).toContain('data-role="qr" hidden>');
    expect(noImage).not.toContain(' src="');
    expect(connected).toContain('data-role="qr" hidden>');
    expect(connected).not.toContain(' src="');
  });

  it("says which phone to pick up, with the digits when it has them and without when it does not", () => {
    const withDigits = page([view({ state: "waiting_qr", qr_rev: "abcdef012345" })]);
    const without = page([
      view({ state: "waiting_qr", qr_rev: "abcdef012345", phone_last4: null }),
    ]);

    expect(withDigits).toContain(
      "Pick up the phone for &quot;empresa&quot; (number ending 1234) and scan this code: WhatsApp → Settings → Linked devices → Link a device.",
    );
    expect(without).toContain(
      "Pick up the phone for &quot;empresa&quot; and scan this code: WhatsApp → Settings → Linked devices → Link a device.",
    );
  });

  it("loads the page's script with the same polling rhythm the server tests assert", () => {
    expect(page([view()])).toContain(`var INTERVAL = ${PAGE_POLL_INTERVAL_MS};`);
  });

  it("cannot be broken out of by a table entry that contains markup", () => {
    const hostile: Strings = { ...en, numberEnding: "</script><script>alert(1)</script> {last4}" };

    const html = renderHubPage({
      nonce: NONCE,
      publicUrl: PUBLIC_URL,
      views: [view()],
      t: hostile,
    });

    expect(html.match(/<script\b/g)).toHaveLength(1);
    expect(html.match(/<\/script>/g)).toHaveLength(1);
  });
});

describe("the gate pages", () => {
  it("renders the PIN form with the destination and no error at first", () => {
    const html = renderPinForm({ nonce: NONCE, next: "/empresa", failed: false });

    expect(html).toContain('<input type="hidden" name="next" value="/empresa">');
    expect(html).toContain('type="password"');
    expect(html).not.toContain('role="alert"');
    expect(html.match(/<script\b/g)).toBeNull();
  });

  it("adds the one sentence after a wrong PIN, and nothing else", () => {
    const html = renderPinForm({ nonce: NONCE, next: "/", failed: true });

    expect(html).toContain('<p class="error" role="alert">That PIN did not work.</p>');
  });

  it("escapes the destination even though the server only passes safe paths", () => {
    const html = renderPinForm({ nonce: NONCE, next: '/"><script>', failed: false });

    expect(html).not.toContain('"><script>');
  });

  it("renders the locked page with no form and no way to try again from it", () => {
    const html = renderLockedPage({ nonce: NONCE });

    expect(html).toContain("Too many wrong PINs");
    expect(html).toContain("Try again later.");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("<input");
  });
});

describe("in Brazilian Portuguese", () => {
  const t = stringsFor("pt-BR");
  const pages = () => [
    renderHubPage({
      nonce: NONCE,
      publicUrl: PUBLIC_URL,
      t,
      target: "empresa",
      views: [
        view({ state: "waiting_qr", qr_rev: "abcdef012345" }),
        view({ label: "b", state: "connected" }),
        view({ label: "c", state: "down", down_for_s: 7500 }),
        view({ label: "d", state: "mismatch", phone_last4: null }),
      ],
    }),
    renderHubPage({ nonce: NONCE, publicUrl: PUBLIC_URL, t, views: [], unknownLabel: "nobody" }),
    renderPinForm({ nonce: NONCE, t, next: "/", failed: false }),
    renderPinForm({ nonce: NONCE, t, next: "/", failed: true }),
    renderLockedPage({ nonce: NONCE, t }),
  ];

  it("says the page is Brazilian Portuguese, and English by default", () => {
    for (const html of pages()) expect(html).toContain('<html lang="pt-BR">');
    expect(page([view()])).toContain('<html lang="en">');
    expect(renderPinForm({ nonce: NONCE, next: "/", failed: false })).toContain('<html lang="en">');
    expect(renderLockedPage({ nonce: NONCE })).toContain('<html lang="en">');
  });

  function page(views: InstanceView[]): string {
    return renderHubPage({ nonce: NONCE, publicUrl: PUBLIC_URL, views });
  }

  it("writes the cards in Portuguese: state, digits, QR sentence and image text", () => {
    const html = pages()[0];

    expect(html).toContain("Aguardando você escanear o QR code");
    expect(html).toContain("Conectado");
    expect(html).toContain("Fora do ar há 2 h 5 min");
    expect(html).toContain("Configuração errada: este endereço responde como outro número");
    expect(html).toContain("número terminado em 1234");
    expect(html).toContain(
      "Pegue o celular do número &quot;empresa&quot; (terminado em 1234) e escaneie este código: WhatsApp → Configurações → Dispositivos conectados → Conectar dispositivo.",
    );
    expect(html).toContain('alt="QR code para vincular o número de WhatsApp &quot;empresa&quot;"');
    expect(html).toContain("<h1>Números de WhatsApp</h1>");
    expect(html).toContain("Esta página se atualiza sozinha.");
    expect(html).toContain("Sem contato com o hub. Tentando de novo…");
  });

  it("writes the notice for an unknown number in Portuguese", () => {
    expect(pages()[1]).toContain(
      "Não existe nenhum número chamado &quot;nobody&quot;. Estes são os números que este hub mostra.",
    );
  });

  it("writes the PIN form, the wrong-PIN sentence and the locked page in Portuguese", () => {
    const [, , form, wrong, locked] = pages();

    expect(form).toContain("<h1>Digite o PIN</h1>");
    expect(form).toContain(">Abrir</button>");
    expect(wrong).toContain('<p class="error" role="alert">Esse PIN não funcionou.</p>');
    expect(locked).toContain("Muitos PINs errados");
    expect(locked).toContain("Tente de novo mais tarde.");
  });

  it("has none of the English table's sentences on any page", () => {
    for (const html of pages()) expect(englishLeaks(html)).toEqual([]);
  });

  it("finds an English sentence when one is there (the check can fail)", () => {
    expect(englishLeaks(page([view()]))).toContain("Connected");
  });

  it("gives the page script the Portuguese words, so a patched card stays in Portuguese", () => {
    const script = /<script nonce="[^"]+">([\s\S]*)<\/script>/.exec(pages()[0])?.[1] ?? "";

    expect(script).toContain('"connected":"Conectado"');
    expect(script).toContain('"down":"Fora do ar há {duration}"');
    expect(script).toContain('"lessThanMinute":"menos de um minuto"');
    expect(script).toContain('"numberEnding":"número terminado em {last4}"');
    expect(englishLeaks(script)).toEqual([]);
  });

  it("formats a duration with the table it is given", () => {
    expect(formatDuration(5, t)).toBe("menos de um minuto");
    expect(formatDuration(600, t)).toBe("10 min");
    expect(stateText(view({ state: "down", down_for_s: 725 }), t)).toBe("Fora do ar há 12 min");
  });
});

describe("connect a client", () => {
  const html = () =>
    renderHubPage({
      nonce: NONCE,
      publicUrl: PUBLIC_URL,
      views: [view(), view({ label: "pessoal", description: "Personal line" })],
    });
  const cardOf = (page: string, label: string) =>
    new RegExp(`<article[^>]*data-label="${label}"[\\s\\S]*?</article>`).exec(page)?.[0] ?? "";

  it("builds the MCP address of a number from the hub's public address", () => {
    expect(mcpUrl("https://hub.example.com", "empresa")).toBe(
      "https://hub.example.com/empresa/mcp",
    );
  });

  it("gives every card its own collapsed block with its own address", () => {
    for (const label of ["empresa", "pessoal"]) {
      const card = cardOf(html(), label);

      expect(card).toMatch(/<details class="connect">\s*<summary>Connect a client<\/summary>/);
      expect(card).not.toMatch(/<details[^>]*\sopen/);
      expect(card).toContain(`https://hub.example.com/${label}/mcp`);
      expect(card).not.toContain(`/${label === "empresa" ? "pessoal" : "empresa"}/mcp`);
    }
  });

  it("shows the JSON entry the examples document, with the placeholder in place of a token", () => {
    const card = cardOf(html(), "empresa");

    expect(card).toContain("&quot;whatsapp-empresa&quot;: {");
    expect(card).toContain("&quot;type&quot;: &quot;http&quot;,");
    expect(card).toContain("&quot;url&quot;: &quot;https://hub.example.com/empresa/mcp&quot;,");
    expect(card).toContain("&quot;Authorization&quot;: &quot;Bearer &lt;token&gt;&quot;");
  });

  it("shows the one-line claude mcp add command with the same placeholder", () => {
    expect(cardOf(html(), "empresa")).toContain(
      "claude mcp add --transport http whatsapp-empresa https://hub.example.com/empresa/mcp --header &quot;Authorization: Bearer &lt;token&gt;&quot;",
    );
  });

  it("says where the token is, and never carries anything but the placeholder after Bearer", () => {
    const page = html();

    expect(page).toContain(
      "The token is in this number&#39;s env file on the server. It is never shown here.",
    );
    const tokens = [...page.matchAll(/Bearer (&lt;token&gt;|\S+)/g)].map((m) => m[1]);
    expect(tokens).toHaveLength(4); // the entry and the command, on two cards
    expect(new Set(tokens)).toEqual(new Set(["&lt;token&gt;"]));
  });

  it("gives each snippet a copy button that names an element on the same page", () => {
    const page = html();
    const buttons = [
      ...page.matchAll(/<button class="copy" type="button" data-copy="([^"]+)">Copy<\/button>/g),
    ];

    expect(buttons).toHaveLength(6); // address, entry and command, for two cards
    for (const [, id] of buttons) expect(page.match(new RegExp(`id="${id}"`, "g"))).toHaveLength(1);
    expect(new Set(buttons.map((b) => b[1])).size).toBe(6);
  });

  it("escapes a public address that carries markup", () => {
    const page = renderHubPage({
      nonce: NONCE,
      publicUrl: 'https://x.example.com/"><b>',
      views: [view()],
    });

    expect(page).not.toContain("<b>");
  });

  it("writes the block in Portuguese under pt-BR", () => {
    const page = renderHubPage({
      nonce: NONCE,
      publicUrl: PUBLIC_URL,
      views: [view()],
      t: stringsFor("pt-BR"),
    });

    expect(page).toContain("<summary>Conectar um cliente</summary>");
    expect(page).toContain("Endereço MCP");
    expect(page).toContain(">Copiar</button>");
    expect(englishLeaks(page)).toEqual([]);
  });
});

describe("the copy button's script", () => {
  interface FakeButton {
    attrs: Record<string, string>;
    textContent: string;
    getAttribute(name: string): string;
  }

  function rig(options: { clipboard?: "ok" | "refuses" | "missing" } = {}) {
    const html = renderHubPage({ nonce: NONCE, publicUrl: PUBLIC_URL, views: [view()] });
    const script = /<script nonce="[^"]+">([\s\S]*)<\/script>/.exec(html)?.[1] ?? "";
    const listeners: Record<string, (event: unknown) => void> = {};
    const written: string[] = [];
    const selected: string[] = [];
    const timers: (() => void)[] = [];
    const source = { textContent: "the snippet text" };
    const button: FakeButton = {
      attrs: { "data-copy": "snip-empresa-url" },
      textContent: "Copy",
      getAttribute: (name) => button.attrs[name],
    };
    const context = {
      document: {
        hidden: false,
        querySelectorAll: () => [],
        querySelector: () => null,
        getElementById: (id: string) =>
          id === "snip-empresa-url" ? source : id === "offline" ? { hidden: true } : null,
        addEventListener: (type: string, fn: (event: unknown) => void) => {
          listeners[type] = fn;
        },
        createRange: () => ({
          selectNodeContents: (node: unknown) =>
            selected.push(node === source ? "source" : "other"),
        }),
      },
      window: {
        getSelection: () => ({ removeAllRanges: () => undefined, addRange: () => undefined }),
      },
      navigator:
        options.clipboard === "missing"
          ? {}
          : {
              clipboard: {
                writeText: (text: string) => {
                  written.push(text);
                  return options.clipboard === "refuses"
                    ? Promise.reject(new Error("denied"))
                    : Promise.resolve();
                },
              },
            },
      location: { reload: () => undefined },
      setInterval: () => undefined,
      fetch: () => new Promise(() => undefined),
      setTimeout: (fn: () => void) => timers.push(fn),
      clearTimeout: () => undefined,
    };
    vm.runInNewContext(script, context);
    const click = async (target: unknown) => {
      listeners.click({ target });
      await new Promise((resolve) => setImmediate(resolve));
    };
    return { button, written, selected, timers, click, listeners };
  }

  const onButton = (button: FakeButton) => ({ closest: () => button });

  it("listens for clicks once, on the document", () => {
    expect(Object.keys(rig().listeners)).toContain("click");
  });

  it("copies the snippet's text and says so, then goes back to the word Copy", async () => {
    const r = rig();

    await r.click(onButton(r.button));

    expect(r.written).toEqual(["the snippet text"]);
    expect(r.button.textContent).toBe("Copied");
    expect(r.selected).toEqual([]);
    r.timers[0]();
    expect(r.button.textContent).toBe("Copy");
  });

  it("selects the snippet's text instead when the clipboard refuses", async () => {
    const r = rig({ clipboard: "refuses" });

    await r.click(onButton(r.button));

    expect(r.written).toEqual(["the snippet text"]);
    expect(r.selected).toEqual(["source"]);
    expect(r.button.textContent).toBe("Selected. Press Ctrl+C to copy.");
  });

  it("selects the snippet's text instead when there is no clipboard API", async () => {
    const r = rig({ clipboard: "missing" });

    await r.click(onButton(r.button));

    expect(r.written).toEqual([]);
    expect(r.selected).toEqual(["source"]);
    expect(r.button.textContent).toBe("Selected. Press Ctrl+C to copy.");
  });

  it("ignores a click that is not on a copy button", async () => {
    const r = rig();

    await r.click({ closest: () => null });
    await r.click({});
    await r.click(null);

    expect(r.written).toEqual([]);
    expect(r.selected).toEqual([]);
    expect(r.button.textContent).toBe("Copy");
  });

  it("ignores a button whose snippet is not on the page", async () => {
    const r = rig();
    r.button.attrs["data-copy"] = "gone";
    const reachable = { ...r.button, getAttribute: () => "gone" };

    await r.click(onButton(reachable));

    expect(r.written).toEqual([]);
    expect(r.selected).toEqual([]);
  });
});

/* ---- the page's own script, run against a stand-in for the parts of the page it touches ---- */

interface FakeCard {
  dataset: { label: string; state: string };
  parts: Record<string, FakePart>;
  querySelector(selector: string): FakePart;
}
interface FakePart {
  hidden: boolean;
  textContent: string;
  attrs: Record<string, string>;
  getAttribute(name: string): string | undefined;
  setAttribute(name: string, value: string): void;
}

function fakePart(): FakePart {
  const part: FakePart = {
    hidden: false,
    textContent: "",
    attrs: {},
    getAttribute: (name) => part.attrs[name],
    setAttribute: (name, value) => {
      part.attrs[name] = value;
    },
  };
  return part;
}

function fakeCard(label: string): FakeCard {
  const parts: Record<string, FakePart> = {};
  for (const role of ["state-text", "desc", "digits", "qr", "qr-help", "qr-img"]) {
    parts[role] = fakePart();
  }
  return {
    dataset: { label, state: "disconnected" },
    parts,
    querySelector: (selector) => parts[/data-role="([^"]+)"/.exec(selector)?.[1] ?? ""],
  };
}

interface Rig {
  cards: Record<string, FakeCard>;
  offline: FakePart;
  tick(): Promise<void>;
  reloads: number;
  fetches: number;
  intervalMs: number;
  scrolled: number;
}

type Answer = { status: number; body?: unknown } | "throw";

function runScript(labels: string[], answers: Answer[], options: { target?: boolean } = {}): Rig {
  const html = renderHubPage({ nonce: NONCE, publicUrl: PUBLIC_URL, views: [view()] });
  const script = /<script nonce="[^"]+">([\s\S]*)<\/script>/.exec(html)?.[1] ?? "";
  const cards = Object.fromEntries(labels.map((label) => [label, fakeCard(label)]));
  const rig: Rig = {
    cards,
    offline: { ...fakePart(), hidden: true },
    reloads: 0,
    fetches: 0,
    intervalMs: 0,
    scrolled: 0,
    tick: async () => undefined,
  };
  let timer: () => void = () => undefined;
  const document = {
    hidden: false,
    querySelectorAll: () => Object.values(cards),
    getElementById: () => rig.offline,
    addEventListener: () => undefined,
    querySelector: () => (options.target ? { scrollIntoView: () => (rig.scrolled += 1) } : null),
  };
  const context = {
    document,
    location: { reload: () => (rig.reloads += 1) },
    setInterval: (fn: () => void, ms: number) => {
      timer = fn;
      rig.intervalMs = ms;
    },
    fetch: (_url: string, init: unknown) => {
      expect(init).toMatchObject({ cache: "no-store", credentials: "same-origin" });
      const answer = answers[Math.min(rig.fetches, answers.length - 1)];
      rig.fetches += 1;
      if (answer === "throw") return Promise.reject(new Error("offline"));
      return Promise.resolve({
        status: answer.status,
        ok: answer.status >= 200 && answer.status < 300,
        json: () => Promise.resolve(answer.body),
      });
    },
  };
  vm.runInNewContext(script, context);
  rig.tick = async () => {
    timer();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  };
  return rig;
}

function status(...views: InstanceView[]): Answer {
  return { status: 200, body: { instances: views } };
}

describe("the page's own script", () => {
  it("asks for the status every 2 seconds", () => {
    const rig = runScript(["empresa"], [status()]);

    expect(rig.intervalMs).toBe(2000);
  });

  it("patches a card from the status: state, words, description, digits", async () => {
    const rig = runScript(["empresa"], [status(view({ state: "connected" }))]);

    await rig.tick();

    const card = rig.cards.empresa;
    expect(card.dataset.state).toBe("connected");
    expect(card.parts["state-text"].textContent).toBe("Connected");
    expect(card.parts.desc.textContent).toBe("Company line");
    expect(card.parts.desc.hidden).toBe(false);
    expect(card.parts.digits.textContent).toBe("number ending 1234");
    expect(card.parts.digits.hidden).toBe(false);
    expect(card.parts.qr.hidden).toBe(true);
  });

  it("hides the description and the digits when the status has none", async () => {
    const rig = runScript(
      ["empresa"],
      [status(view({ state: "down", down_for_s: 0, description: null, phone_last4: null }))],
    );

    await rig.tick();

    expect(rig.cards.empresa.parts.desc.hidden).toBe(true);
    expect(rig.cards.empresa.parts.desc.textContent).toBe("");
    expect(rig.cards.empresa.parts.digits.hidden).toBe(true);
    expect(rig.cards.empresa.parts.digits.textContent).toBe("");
  });

  it.each([
    [0, "Down for less than a minute"],
    [59, "Down for less than a minute"],
    [60, "Down for 1 min"],
    [3599, "Down for 59 min"],
    [3600, "Down for 1 h 0 min"],
    [7500, "Down for 2 h 5 min"],
  ])("writes a number down for %i s as %s, the way the server does", async (seconds, text) => {
    const rig = runScript(["empresa"], [status(view({ state: "down", down_for_s: seconds }))]);

    await rig.tick();

    expect(rig.cards.empresa.parts["state-text"].textContent).toBe(text);
    expect(formatDuration(seconds)).toBe(text.replace("Down for ", ""));
  });

  it("shows a new QR as soon as its revision changes, and not again while it stays the same", async () => {
    const waiting = (rev: string) =>
      status(view({ state: "waiting_qr", qr_rev: rev, phone_last4: "1234" }));
    const rig = runScript(
      ["empresa"],
      [waiting("aaaaaaaaaaaa"), waiting("aaaaaaaaaaaa"), waiting("bbbbbbbbbbbb")],
    );
    const img = rig.cards.empresa.parts["qr-img"];
    const sets: string[] = [];
    const original = img.setAttribute;
    img.setAttribute = (name, value) => {
      sets.push(value);
      original(name, value);
    };

    await rig.tick();
    await rig.tick();
    await rig.tick();

    expect(rig.cards.empresa.parts.qr.hidden).toBe(false);
    expect(sets).toEqual([
      "/_hub/qr/empresa.png?rev=aaaaaaaaaaaa",
      "/_hub/qr/empresa.png?rev=bbbbbbbbbbbb",
    ]);
    expect(rig.cards.empresa.parts["qr-help"].textContent).toBe(
      'Pick up the phone for "empresa" (number ending 1234) and scan this code: WhatsApp → Settings → Linked devices → Link a device.',
    );
  });

  it("names the phone without digits when the status has none", async () => {
    const rig = runScript(
      ["empresa"],
      [status(view({ state: "waiting_qr", qr_rev: "aaaaaaaaaaaa", phone_last4: null }))],
    );

    await rig.tick();

    expect(rig.cards.empresa.parts["qr-help"].textContent).toBe(
      'Pick up the phone for "empresa" and scan this code: WhatsApp → Settings → Linked devices → Link a device.',
    );
  });

  it("hides the QR again once the number is connected", async () => {
    const rig = runScript(
      ["empresa"],
      [
        status(view({ state: "waiting_qr", qr_rev: "aaaaaaaaaaaa" })),
        status(view({ state: "connected" })),
      ],
    );

    await rig.tick();
    expect(rig.cards.empresa.parts.qr.hidden).toBe(false);
    await rig.tick();

    expect(rig.cards.empresa.parts.qr.hidden).toBe(true);
  });

  it("does not show a QR for a waiting number whose image is not there yet", async () => {
    const rig = runScript(["empresa"], [status(view({ state: "waiting_qr", qr_rev: null }))]);

    await rig.tick();

    expect(rig.cards.empresa.parts.qr.hidden).toBe(true);
  });

  it("ignores a status line for a number the page has no card for", async () => {
    const rig = runScript(
      ["empresa"],
      [status(view({ label: "stranger" }), view({ state: "starting" }))],
    );

    await rig.tick();

    expect(rig.cards.empresa.dataset.state).toBe("starting");
  });

  it("reloads the page when the session has ended, and patches nothing", async () => {
    const rig = runScript(["empresa"], [{ status: 401 }]);

    await rig.tick();

    expect(rig.reloads).toBe(1);
    expect(rig.cards.empresa.dataset.state).toBe("disconnected");
    expect(rig.offline.hidden).toBe(true);
  });

  it("shows the lost-contact banner on a failed request or an error status, and hides it after", async () => {
    const rig = runScript(
      ["empresa"],
      ["throw", { status: 500 }, status(view({ state: "connected" }))],
    );

    await rig.tick();
    expect(rig.offline.hidden).toBe(false);
    await rig.tick();
    expect(rig.offline.hidden).toBe(false);
    await rig.tick();

    expect(rig.offline.hidden).toBe(true);
    expect(rig.reloads).toBe(0);
    expect(rig.cards.empresa.dataset.state).toBe("connected");
  });

  it("has one request in flight at a time", async () => {
    let release: () => void = () => undefined;
    const html = renderHubPage({ nonce: NONCE, publicUrl: PUBLIC_URL, views: [view()] });
    const script = /<script nonce="[^"]+">([\s\S]*)<\/script>/.exec(html)?.[1] ?? "";
    let timer: () => void = () => undefined;
    let calls = 0;
    vm.runInNewContext(script, {
      document: {
        hidden: false,
        querySelectorAll: () => [],
        getElementById: () => ({ hidden: true }),
        addEventListener: () => undefined,
        querySelector: () => null,
      },
      location: { reload: () => undefined },
      setInterval: (fn: () => void) => {
        timer = fn;
      },
      fetch: () => {
        calls += 1;
        return new Promise((resolve) => {
          release = () =>
            resolve({ status: 200, ok: true, json: () => Promise.resolve({ instances: [] }) });
        });
      },
    });

    timer();
    timer();
    timer();
    expect(calls).toBe(1);
    release();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    timer();

    expect(calls).toBe(2);
  });

  it("scrolls to the card of the address when there is one, and only then", () => {
    expect(runScript(["empresa"], [status()], { target: true }).scrolled).toBe(1);
    expect(runScript(["empresa"], [status()]).scrolled).toBe(0);
  });
});
