/**
 * Longest prefix of `text` whose UTF-8 encoding fits in `maxBytes`, never
 * splitting a code point. Lone surrogates count as 3 bytes, as Node encodes
 * them (U+FFFD).
 */
export function utf8Prefix(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  // A UTF-16 code unit never takes more than 3 UTF-8 bytes; the common case
  // (the text already fits) returns without walking it.
  if (text.length * 3 <= maxBytes || Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let bytes = 0;
  let end = 0;
  for (const character of text) {
    const codePoint = character.codePointAt(0)!;
    const size = codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += character.length;
  }
  return text.slice(0, end);
}
