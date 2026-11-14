import { describe, expect, it } from "vitest";
import { convertFile, drawingName, extensionOf, loadRuntimeConfig, NoConverterError, selectConverter, type ConverterAdapter } from "./converter";

const model = () => new File([new Uint8Array([1, 2, 3, 4])], "model.rvt");

/** A fetch that records its call and answers with the given response. */
function fakeFetch(respond: () => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return respond();
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

describe("convertFile", () => {
  it("posts the file to the configured HTTP converter and returns the .drawing bytes", async () => {
    const { fetchFn, calls } = fakeFetch(() => new Response(new Uint8Array([0x1f, 0x8b, 7, 7])));
    const progress: string[] = [];
    const bytes = await convertFile(model(), { converter: "https://conv.example/convert" }, { onProgress: (m) => progress.push(m) }, { fetch: fetchFn });

    expect(Array.from(bytes)).toEqual([0x1f, 0x8b, 7, 7]);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://conv.example/convert");
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers).toEqual({ "Content-Type": "application/octet-stream", "X-Filename": "model.rvt" });
    expect((calls[0].init.body as File).name).toBe("model.rvt");
    expect(progress[0]).toBe("Converting model.rvt ...");
  });

  it("accepts the converter as an object with a type", async () => {
    const { fetchFn, calls } = fakeFetch(() => new Response(new Uint8Array([5])));
    await convertFile(model(), { converter: { type: "http", url: "/convert" } }, {}, { fetch: fetchFn });
    expect(calls[0].url).toBe("/convert");
  });

  it("percent-encodes a file name that is not plain ASCII", async () => {
    const { fetchFn, calls } = fakeFetch(() => new Response(new Uint8Array([5])));
    await convertFile(new File([new Uint8Array([1])], "Zażółć 100%.rvt"), { converter: "/c" }, {}, { fetch: fetchFn });
    expect((calls[0].init.headers as Record<string, string>)["X-Filename"]).toBe("Za%C5%BC%C3%B3%C5%82%C4%87%20100%25.rvt");
  });

  it("reports that no converter is configured, without calling the network", async () => {
    const { fetchFn, calls } = fakeFetch(() => new Response(new Uint8Array([5])));
    const failure = await convertFile(model(), {}, {}, { fetch: fetchFn }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(NoConverterError);
    expect((failure as Error).message).toBe("No converter configured for .rvt files");
    expect(calls).toHaveLength(0);
  });

  it("reports the converter's error status and message", async () => {
    const { fetchFn } = fakeFetch(() => new Response("model is corrupt", { status: 422, statusText: "Unprocessable Entity" }));
    await expect(convertFile(model(), { converter: "/c" }, {}, { fetch: fetchFn })).rejects.toThrow("The converter answered 422 Unprocessable Entity: model is corrupt");
  });

  it("reports an unreachable converter", async () => {
    const fetchFn = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    await expect(convertFile(model(), { converter: "http://localhost:1/c" }, {}, { fetch: fetchFn })).rejects.toThrow("Could not reach the converter at http://localhost:1/c: Failed to fetch");
  });

  it("names a configured converter type it does not have", async () => {
    await expect(convertFile(model(), { converter: { type: "wasm", url: "/x.wasm" } }, {}, { fetch: fetch })).rejects.toThrow(/"wasm" is not supported/);
  });

  it("lets another adapter answer to its own type", async () => {
    const upper: ConverterAdapter = { type: "upper", create: () => ({ convert: async (file) => new TextEncoder().encode(file.name.toUpperCase()) }) };
    const bytes = await convertFile(model(), { converter: { type: "upper" } }, {}, { fetch }, [upper]);
    expect(new TextDecoder().decode(bytes)).toBe("MODEL.RVT");
  });
});

describe("selectConverter", () => {
  it("finds no converter in an empty configuration or an object without a URL", () => {
    expect(selectConverter({}, { fetch })).toBeNull();
    expect(selectConverter({ converter: "" }, { fetch })).toBeNull();
    expect(selectConverter({ converter: { type: "http" } }, { fetch })).toBeNull();
  });
});

describe("loadRuntimeConfig", () => {
  const answer = (body: string, status = 200) => (async () => new Response(body, { status })) as unknown as typeof fetch;

  it("takes config.json over the build-time URL", async () => {
    const config = await loadRuntimeConfig("/config.json", "https://build.example/c", answer('{"converter": "https://runtime.example/c"}'));
    expect(config).toEqual({ converter: "https://runtime.example/c" });
  });

  it("falls back to the build-time URL when config.json is missing or is not JSON", async () => {
    expect(await loadRuntimeConfig("/config.json", "https://build.example/c", answer("", 404))).toEqual({ converter: "https://build.example/c" });
    expect(await loadRuntimeConfig("/config.json", "https://build.example/c", answer("<!doctype html>"))).toEqual({ converter: "https://build.example/c" });
  });

  it("is empty with neither", async () => {
    expect(await loadRuntimeConfig("/config.json", undefined, answer("{}"))).toEqual({});
  });
});

describe("file names", () => {
  it("reads the extension in lower case", () => {
    expect(extensionOf("Model.RVT")).toBe(".rvt");
    expect(extensionOf("noext")).toBe("");
    expect(extensionOf(".hidden")).toBe("");
  });

  it("renames a converted file to .drawing", () => {
    expect(drawingName("model.rvt")).toBe("model.drawing");
    expect(drawingName("a.b.RVT")).toBe("a.b.drawing");
    expect(drawingName("noext")).toBe("noext.drawing");
  });
});
