// Opens the bytes of a .drawing or a scene .json, whichever they are. No DOM.
import { parseDrawing, sceneAsDoc, type DrawingDoc } from "./drawing-file";
import { parseScene } from "./scene";

/** A gzip stream is a .drawing; anything else must be a scene JSON. The content decides, not the file name. */
export async function openDocument(bytes: Uint8Array): Promise<DrawingDoc> {
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) return parseDrawing(bytes);
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder("utf-8").decode(bytes));
  } catch (e) {
    throw new Error(`Not a .drawing (no gzip stream) and not scene JSON: ${(e as Error).message}`);
  }
  return sceneAsDoc(parseScene(json));
}
