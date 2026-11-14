declare module 'virtual:brush-samples' {
  /** Sample `.drawing` files from `schema/public/examples` (see `sampleDrawings` in vite.config.ts). */
  const samples: { name: string; label: string; url: string; size: number }[]
  export default samples
}
