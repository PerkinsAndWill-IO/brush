# brush

Monorepo for the Brush tools. Each folder is a self-contained app with its own `package.json`; run commands from inside it.

| Folder | What | Run |
|---|---|---|
| [`editor/`](editor/) | Brush Editor: sketch on PDF sheets with the contextual brush (predicts walls, doors, furniture while you draw). Instructions for agents: [`editor/AGENTS.md`](editor/AGENTS.md). Spec: [`editor/docs/spec.md`](editor/docs/spec.md). | `cd editor && pnpm install && pnpm dev` |
| [`schema/`](schema/) | The `.drawing` format (spec in [`schema/schema/`](schema/schema/)) and the browser viewer that reads it. See [`schema/README.md`](schema/README.md). | `cd schema && npm install && npm run dev` |
| [`revit/`](revit/) | Brush Link: Revit add-in the editor connects to live. Edits go in as editor commands and each sheet comes back as a new `.drawing` version. Protocol: [`revit/docs/protocol.md`](revit/docs/protocol.md). DevHost runs it without Revit. | `cd revit && dotnet test` |
