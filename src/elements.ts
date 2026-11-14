// Element card logic: tag resolution and readable parameter labels. No DOM.
import type { ElementInfo } from "./scene";

export interface Resolved {
  /** Element whose card is shown (the tagged element for a tag). */
  id: number;
  info: ElementInfo | undefined;
  /** Set when the hovered element refers to another one (a tag): its class as words. */
  tagLabel: string | null;
  /** Elements whose items are highlighted: the hovered one first, then the tagged one. */
  highlight: number[];
}

/** "RoomTag" -> "Room tag". */
export function classLabel(cls: string): string {
  const s = cls.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function resolveElement(elements: Record<string, ElementInfo>, id: number): Resolved {
  const own = elements[String(id)];
  const target = own?.tagged != null ? elements[String(own.tagged)] : undefined;
  if (!own || own.tagged == null || !target) return { id, info: own, tagLabel: null, highlight: [id] };
  return { id: own.tagged, info: target, tagLabel: classLabel(own.class ?? "Tag"), highlight: [id, own.tagged] };
}

/** Card category line: category, else class. */
export function categoryOf(info: ElementInfo | undefined): string {
  return info?.category || (info?.class ? classLabel(info.class) : "") || "Element";
}

/** "SNAKE_CASE" -> "Snake case". Names that are not all caps and underscores pass through. */
export function paramLabel(name: string): string {
  if (!/^[A-Z0-9_]+$/.test(name)) return name;
  const n = name.replace(/_+/g, ' ').trim().toLowerCase();
  return n.charAt(0).toUpperCase() + n.slice(1);
}
