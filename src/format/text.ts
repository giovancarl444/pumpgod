/**
 * Cutting text to length, correctly, in the one place that knows how.
 *
 * Deliberately a leaf with no imports of its own, because both the pipeline and the Telegram
 * transport need this and neither should have to depend on the other to get it.
 */

/**
 * Shortens `text` to at most `limit`, ending it with an ellipsis when anything was removed.
 *
 * The subtlety this exists for: a naive `slice` counts UTF-16 units, and every emoji is two of
 * them. Cutting between the two halves leaves a lone surrogate — not a character, not valid
 * text, and not something that survives being encoded on the way to an API. It does not look
 * wrong in a debugger either; it looks like nothing at all.
 *
 * So the cut is made on character boundaries by iterating, while the width is still counted in
 * UTF-16 units. Counting units is the conservative reading of "32 characters" in someone
 * else's API docs, and being a little under a limit costs nothing while being over it fails
 * the whole request.
 *
 * Memecoin names and symbols are the reason this matters here. They are chosen to be eye
 * catching, which in practice means long and full of emoji, and they arrive from a stranger's
 * contract rather than from us.
 */
export function clip(text: string, limit: number): string {
  if (text.length <= limit) return text;
  let out = '';
  for (const character of text) {
    // `character` is a whole code point, so this either takes all of an emoji or none of it.
    if (out.length + character.length > limit - 1) break;
    out += character;
  }
  return `${out.trimEnd()}…`;
}
