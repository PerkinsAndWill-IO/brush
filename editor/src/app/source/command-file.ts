/**
 * The command export file `<name>.commands.json` (decision 0005): the neutral command list the future Applier reads.
 * Serializer and parser are pure; the writer takes the platform's save function.
 */
import type { Command, CommandOp, Sheet } from '@core/types'

export const COMMAND_FILE_VERSION = 1
export const COMMAND_FILE_KIND = 'brush-commands'

export interface CommandFile {
  schemaVersion: typeof COMMAND_FILE_VERSION
  kind: typeof COMMAND_FILE_KIND
  source: { name: string; kind: 'pdf' | 'package'; project?: string }
  sheets: Array<{ id: string; number?: string; name: string; scale?: number }>
  commands: Command[]
  /** Epoch ms; omitted for deterministic output. */
  exportedAt?: number
}

const OPS: readonly CommandOp[] = ['create_wall', 'place_door', 'place_instance', 'delete']

export function buildCommandFile(args: {
  source: CommandFile['source']
  sheets: readonly Sheet[]
  commands: readonly Command[]
  exportedAt?: number
}): CommandFile {
  const f: CommandFile = {
    schemaVersion: COMMAND_FILE_VERSION,
    kind: COMMAND_FILE_KIND,
    source: { ...args.source },
    sheets: args.sheets.map((s) => {
      const o: CommandFile['sheets'][number] = { id: s.id, name: s.name }
      if (s.number !== undefined) o.number = s.number
      if (s.scale !== undefined) o.scale = s.scale
      return o
    }),
    commands: args.commands.map((c) => JSON.parse(JSON.stringify(c)) as Command),
  }
  if (args.exportedAt !== undefined) f.exportedAt = args.exportedAt
  return f
}

export function serializeCommandFile(file: CommandFile): string {
  return JSON.stringify(file, null, 2) + '\n'
}

/** Parse and validate; throws on a wrong kind/version or an unknown op. */
export function parseCommandFile(text: string): CommandFile {
  const f = JSON.parse(text) as Partial<CommandFile>
  if (f.kind !== COMMAND_FILE_KIND) throw new Error('not a brush command file')
  if (f.schemaVersion !== COMMAND_FILE_VERSION) throw new Error(`unsupported command file version ${String(f.schemaVersion)}`)
  if (!Array.isArray(f.commands) || !f.source || !Array.isArray(f.sheets)) throw new Error('malformed command file')
  for (const c of f.commands) if (!OPS.includes(c.op)) throw new Error(`unknown command op ${String((c as { op: unknown }).op)}`)
  return f as CommandFile
}

/** `plan.pdf` -> `plan.commands.json`; `plan.drawing` -> `plan.commands.json`. */
export function commandFileName(sourceName: string): string {
  return sourceName.replace(/\.(pdf|drawing)$/i, '') + '.commands.json'
}

/** Write through the platform (`platform.saveTextFile` today; a next-to-the-PDF write once the adapter has one). */
export async function writeCommandFile(save: (name: string, text: string) => Promise<void>, file: CommandFile): Promise<string> {
  const name = commandFileName(file.source.name)
  await save(name, serializeCommandFile(file))
  return name
}
