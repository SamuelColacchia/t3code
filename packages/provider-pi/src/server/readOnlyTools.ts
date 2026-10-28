export const T3_PI_EXTRA_READ_ONLY_TOOLS_ENV = "T3_PI_EXTRA_READ_ONLY_TOOLS";

// Embedded into the Pi extension through toString(), so it must stay self-contained.
export function parseExtraReadOnlyTools(
  value: string | undefined,
  fileChangeTools: ReadonlyArray<string>,
): string[] {
  if (value === undefined) return [];
  return value
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0 && !fileChangeTools.includes(name));
}
