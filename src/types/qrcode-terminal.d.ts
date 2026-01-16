declare module 'qrcode-terminal' {
  interface Options {
    small?: boolean;
  }
  function generate(data: string, options?: Options, callback?: (qr: string) => void): void;
  function generate(data: string, callback?: (qr: string) => void): void;
  export = { generate };
}
