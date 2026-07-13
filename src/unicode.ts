/** JSON Schema maxLength counts Unicode scalar values, not UTF-16 code units. */
export function unicodeScalarLength(value: string): number {
  return Array.from(value).length;
}
