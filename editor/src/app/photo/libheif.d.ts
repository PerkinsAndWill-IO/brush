/** The part of libheif-js (1.23.5, the WASM bundle as an ES module) that ./heic.ts uses. */
declare module 'libheif-js/libheif-wasm/libheif-bundle.mjs' {
  interface HeifImage {
    get_width(): number
    get_height(): number
    is_primary(): boolean
    /** Decodes into `target.data` (RGBA); the callback gets `target`, or null on failure. */
    display(target: { data: Uint8ClampedArray; width: number; height: number }, done: (result: unknown) => void): void
    free(): void
  }
  interface LibHeif {
    HeifDecoder: new () => { decode(bytes: Uint8Array): HeifImage[] }
  }
  const factory: (options?: object) => LibHeif | Promise<LibHeif>
  export default factory
}
