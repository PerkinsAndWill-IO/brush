// Converter hook: turns a file the viewer cannot read itself (anything but .drawing and .json) into .drawing bytes by
// asking a converter that is configured at runtime. The viewer knows nothing about the source formats; an adapter
// only knows how to reach one kind of converter. No DOM.
//
// Adding an adapter (say, a wasm module loaded from a URL) means writing a ConverterAdapter and appending it to
// `defaultAdapters`; nothing else changes.

export interface ConvertContext {
  /** Human-readable progress lines, e.g. "Receiving model.drawing ... 4.2 MB". */
  onProgress?: (message: string) => void;
  signal?: AbortSignal;
}

export interface Converter {
  /** Takes the dropped file, resolves to the bytes of a .drawing file. */
  convert(file: File, ctx?: ConvertContext): Promise<Uint8Array>;
}

/**
 * The `converter` entry of `public/config.json` (or the build-time VITE_CONVERTER_URL). A bare string is the URL of an
 * HTTP converter; an object picks an adapter with `type` (default "http") and carries that adapter's settings.
 */
export type ConverterConfig = string | { type?: string; url?: string; [setting: string]: unknown };

export interface RuntimeConfig {
  converter?: ConverterConfig;
}

export interface ConverterEnv {
  fetch: typeof fetch;
}

export interface ConverterAdapter {
  /** The `type` value this adapter answers to. */
  type: string;
  /** Builds a converter from the configured settings, or null when they do not suffice (e.g. no URL). */
  create(settings: Record<string, unknown>, env: ConverterEnv): Converter | null;
}

export class NoConverterError extends Error {}

/** Lower-case extension including the dot, "" when there is none. */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot).toLowerCase();
}

/** Formats the file name for the X-Filename header: plain when it is printable ASCII, percent-encoded otherwise. */
function filenameHeader(name: string): string {
  return /^[\x20-\x7e]*$/.test(name) && !name.includes("%") ? name : encodeURIComponent(name);
}

const megabytes = (n: number) => `${(n / 1e6).toFixed(1)} MB`;

/** POSTs the file to a URL and expects the .drawing bytes back. The contract is in the README. */
export const httpAdapter: ConverterAdapter = {
  type: "http",
  create(settings, env) {
    const url = settings.url;
    if (typeof url !== "string" || url === "") return null;
    return {
      async convert(file, ctx = {}) {
        ctx.onProgress?.(`Converting ${file.name} ...`);
        let res: Response;
        try {
          res = await env.fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/octet-stream", "X-Filename": filenameHeader(file.name) },
            body: file,
            signal: ctx.signal,
          });
        } catch (e) {
          throw new Error(`Could not reach the converter at ${url}: ${(e as Error).message}`);
        }
        if (!res.ok) {
          const detail = (await res.text().catch(() => "")).trim().slice(0, 300);
          throw new Error(`The converter answered ${res.status} ${res.statusText}`.trim() + (detail ? `: ${detail}` : ""));
        }
        if (!res.body) return new Uint8Array(await res.arrayBuffer());
        const chunks: Uint8Array[] = [];
        let received = 0;
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          received += value.length;
          ctx.onProgress?.(`Receiving the converted drawing ... ${megabytes(received)}`);
        }
        const out = new Uint8Array(received);
        let at = 0;
        for (const c of chunks) {
          out.set(c, at);
          at += c.length;
        }
        return out;
      },
    };
  },
};

export const defaultAdapters: ConverterAdapter[] = [httpAdapter];

/** The converter the configuration asks for, or null when none is configured. */
export function selectConverter(config: RuntimeConfig, env: ConverterEnv, adapters: ConverterAdapter[] = defaultAdapters): Converter | null {
  const c = config.converter;
  if (c === undefined || c === null || c === "") return null;
  const settings: Record<string, unknown> = typeof c === "string" ? { type: "http", url: c } : { type: "http", ...c };
  const adapter = adapters.find((a) => a.type === settings.type);
  if (!adapter) throw new NoConverterError(`The configured converter type ${JSON.stringify(settings.type)} is not supported`);
  return adapter.create(settings, env);
}

/** Converts a dropped file with the configured converter. Throws NoConverterError when there is none. */
export async function convertFile(file: File, config: RuntimeConfig, ctx: ConvertContext = {}, env: ConverterEnv = { fetch: (...a) => fetch(...a) }, adapters?: ConverterAdapter[]): Promise<Uint8Array> {
  const converter = selectConverter(config, env, adapters);
  if (!converter) {
    const ext = extensionOf(file.name);
    throw new NoConverterError(ext ? `No converter configured for ${ext} files` : `No converter configured for ${file.name}`);
  }
  return converter.convert(file, ctx);
}

/**
 * Runtime configuration: `config.json` next to the page wins over the build-time `buildTimeConverterUrl`
 * (VITE_CONVERTER_URL). A missing or unreadable config.json is not an error.
 */
export async function loadRuntimeConfig(configUrl: string, buildTimeConverterUrl: string | undefined, fetchFn: typeof fetch = (...a) => fetch(...a)): Promise<RuntimeConfig> {
  const config: RuntimeConfig = {};
  if (buildTimeConverterUrl) config.converter = buildTimeConverterUrl;
  try {
    const res = await fetchFn(configUrl);
    if (res.ok) {
      const json = (await res.json()) as unknown;
      if (typeof json === "object" && json !== null && "converter" in json) {
        const c = (json as RuntimeConfig).converter;
        if (typeof c === "string" || (typeof c === "object" && c !== null)) config.converter = c;
      }
    }
  } catch {
    /* no config.json (a dev server may answer with index.html): keep the build-time value */
  }
  return config;
}

/** The name a converted file is saved under: "model.rvt" -> "model.drawing". */
export function drawingName(sourceName: string): string {
  const ext = extensionOf(sourceName);
  return (ext ? sourceName.slice(0, -ext.length) : sourceName) + ".drawing";
}
