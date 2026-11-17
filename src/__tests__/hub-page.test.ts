import vm from "node:vm";
import { describe, expect, it } from "vitest";
import {
  escapeHtml,
  formatDuration,
  PAGE_POLL_INTERVAL_MS,
  renderHubPage,
  renderLockedPage,
  renderPinForm,
  stateText,
} from "../hub/page.ts";
import type { InstanceView } from "../hub/poller.ts";
import { en, fill, type Strings } from "../hub/strings.ts";

const NONCE = "bm9uY2Utbm9uY2Utbm9uY2U=";

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
    renderHubPage({ nonce: NONCE, views, ...extra });

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

    const html = renderHubPage({ nonce: NONCE, views: [view()], t: hostile });

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
  const html = renderHubPage({ nonce: NONCE, views: [view()] });
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
    const html = renderHubPage({ nonce: NONCE, views: [view()] });
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
