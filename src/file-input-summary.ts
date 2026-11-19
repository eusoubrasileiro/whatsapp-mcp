/**
 * send_file's `file_path` as a log may show it. A data: URL is the file itself, and a URL can
 * carry credentials or a signed query, so neither goes to the log whole.
 */
export function summarizeFileInput(input: string): string {
  const data = /^data:([^;,]*)/i.exec(input);
  if (data) return `data:${data[1] || "?"} URL (${input.length} chars)`;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) return input;
  try {
    const url = new URL(input);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return "(malformed URL)";
  }
}
