/**
 * Every word the hub shows a person, in one table per language. A second language is a second
 * table with exactly the same keys (the `Strings` type makes a missing or extra key a compile
 * error); the templates and the page script take the table as an argument.
 *
 * `{name}` marks a value filled in at render time.
 */
export const en = {
  htmlLang: "en",
  title: "WhatsApp numbers",
  liveNote: "This page updates by itself.",
  offline: "Lost contact with the hub. Trying again…",
  states: {
    connected: "Connected",
    waiting_qr: "Waiting for you to scan the QR code",
    starting: "Connecting…",
    disconnected: "Disconnected",
    down: "Down for {duration}",
    mismatch: "Misconfigured: this address answers as another number",
  },
  durations: {
    lessThanMinute: "less than a minute",
    minutes: "{n} min",
    hoursMinutes: "{h} h {m} min",
  },
  numberEnding: "number ending {last4}",
  scan: {
    withDigits:
      'Pick up the phone for "{label}" (number ending {last4}) and scan this code: WhatsApp → Settings → Linked devices → Link a device.',
    withoutDigits:
      'Pick up the phone for "{label}" and scan this code: WhatsApp → Settings → Linked devices → Link a device.',
    imageAlt: 'QR code to link the WhatsApp number "{label}"',
  },
  unknownLabel: 'There is no number called "{label}". These are the numbers this hub shows.',
  pin: {
    title: "Enter the PIN",
    field: "PIN",
    submit: "Open",
    wrong: "That PIN did not work.",
    lockedTitle: "Too many wrong PINs",
    locked: "Try again later.",
  },
  connect: {
    summary: "Connect a client",
    addressTitle: "MCP address",
    jsonTitle: "Config entry (add it under mcpServers)",
    commandTitle: "Command for Claude Code",
    tokenNote: "The token is in this number's env file on the server. It is never shown here.",
    copy: "Copy",
    copied: "Copied",
    selected: "Selected. Press Ctrl+C to copy.",
  },
  unlink: {
    open: "Unlink this number",
    title: "Unlink {label}",
    warningTitle: "Wait if the phone shows a restriction countdown",
    warning:
      "Never unlink or re-link a number while WhatsApp shows a restriction countdown on that phone. Linking again under a restriction makes it worse: a temporary restriction can turn into a longer one. Wait until the countdown ends.",
    effect:
      "What happens: {label} disconnects from this server. Agents lose access to it until someone scans a new QR code with that phone.",
    pinField: "PIN",
    labelField: 'Type "{label}" to confirm',
    submit: "Unlink {label}",
    cancel: "Cancel",
    expired: "This page expired. Open it again and retry.",
    locked: "Too many wrong PINs. Try again later.",
    wrongPin: "That PIN did not work.",
    wrongLabel: "The name you typed does not match.",
    unlinkedTitle: "Number unlinked",
    unlinked: '"{label}" was disconnected. Its card will show a new QR code shortly.',
    notConnectedTitle: "Nothing to unlink",
    notConnected: '"{label}" was not connected, so nothing changed.',
    failedTitle: "Could not unlink",
    failed:
      'The server for "{label}" did not accept the request or did not answer, so we cannot say it was unlinked. Check its card and try again if it is still connected.',
    back: "Back to the numbers",
  },
};

type Widen<T> = { [K in keyof T]: T[K] extends string ? string : Widen<T[K]> };

export type Strings = Widen<typeof en>;

const ptBR: Strings = {
  htmlLang: "pt-BR",
  title: "Números de WhatsApp",
  liveNote: "Esta página se atualiza sozinha.",
  offline: "Sem contato com o hub. Tentando de novo…",
  states: {
    connected: "Conectado",
    waiting_qr: "Aguardando você escanear o QR code",
    starting: "Conectando…",
    disconnected: "Desconectado",
    down: "Fora do ar há {duration}",
    mismatch: "Configuração errada: este endereço responde como outro número",
  },
  durations: {
    lessThanMinute: "menos de um minuto",
    minutes: "{n} min",
    hoursMinutes: "{h} h {m} min",
  },
  numberEnding: "número terminado em {last4}",
  scan: {
    withDigits:
      'Pegue o celular do número "{label}" (terminado em {last4}) e escaneie este código: WhatsApp → Configurações → Dispositivos conectados → Conectar dispositivo.',
    withoutDigits:
      'Pegue o celular do número "{label}" e escaneie este código: WhatsApp → Configurações → Dispositivos conectados → Conectar dispositivo.',
    imageAlt: 'QR code para vincular o número de WhatsApp "{label}"',
  },
  unknownLabel:
    'Não existe nenhum número chamado "{label}". Estes são os números que este hub mostra.',
  pin: {
    title: "Digite o PIN",
    field: "PIN",
    submit: "Abrir",
    wrong: "Esse PIN não funcionou.",
    lockedTitle: "Muitos PINs errados",
    locked: "Tente de novo mais tarde.",
  },
  connect: {
    summary: "Conectar um cliente",
    addressTitle: "Endereço MCP",
    jsonTitle: "Entrada de configuração (coloque dentro de mcpServers)",
    commandTitle: "Comando para o Claude Code",
    tokenNote:
      "O token está no arquivo de variáveis (env) deste número, no servidor. Ele nunca aparece aqui.",
    copy: "Copiar",
    copied: "Copiado",
    selected: "Selecionado. Aperte Ctrl+C para copiar.",
  },
  unlink: {
    open: "Desvincular este número",
    title: "Desvincular {label}",
    warningTitle: "Espere se o celular mostrar uma contagem de restrição",
    warning:
      "Nunca desvincule nem vincule de novo um número enquanto o WhatsApp mostrar uma contagem regressiva de restrição no celular desse número. Vincular de novo durante a restrição piora a situação: uma restrição temporária pode virar uma restrição mais longa. Espere a contagem terminar.",
    effect:
      "O que acontece: {label} é desconectado deste servidor. Os agentes perdem o acesso a ele até alguém escanear um novo QR code com esse celular.",
    pinField: "PIN",
    labelField: 'Digite "{label}" para confirmar',
    submit: "Desvincular {label}",
    cancel: "Cancelar",
    expired: "Esta página expirou. Abra de novo e tente outra vez.",
    locked: "Muitos PINs errados. Tente de novo mais tarde.",
    wrongPin: "Esse PIN não funcionou.",
    wrongLabel: "O nome digitado não confere.",
    unlinkedTitle: "Número desvinculado",
    unlinked: '"{label}" foi desconectado. O cartão dele vai mostrar um novo QR code em instantes.',
    notConnectedTitle: "Nada para desvincular",
    notConnected: '"{label}" não estava conectado, então nada mudou.',
    failedTitle: "Não foi possível desvincular",
    failed:
      'O servidor de "{label}" não aceitou o pedido ou não respondeu, então não dá para dizer que foi desvinculado. Veja o cartão dele e tente de novo se ainda estiver conectado.',
    back: "Voltar aos números",
  },
};

/** The languages `HUB_LANG` accepts. The first is the default. */
export const HUB_LANGS = ["en", "pt-BR"] as const;

export type HubLang = (typeof HUB_LANGS)[number];

export function stringsFor(lang: HubLang): Strings {
  return lang === "pt-BR" ? ptBR : en;
}

/** Fills the `{name}` markers of a template. Unknown markers are left as written. */
export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (marker, name: string) =>
    name in values ? String(values[name]) : marker,
  );
}
