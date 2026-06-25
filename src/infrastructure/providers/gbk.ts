/**
 * Tencent market endpoints (qt.gtimg.cn) return GBK-encoded bytes. Decoding them as
 * UTF-8 — the default of `Response.text()` — turns every Chinese stock / index name
 * into mojibake (e.g. "综艺股份" -> "�ۺ�п��"), which then leaks into notifications,
 * logs and reports. This reads the raw bytes and decodes them as GBK when possible.
 *
 * Falls back to `response.text()` when the response cannot expose its raw bytes (e.g.
 * a test mock that only implements `text()`) or when the runtime's ICU build lacks the
 * GBK label — so behaviour degrades gracefully instead of throwing.
 */

/** `undefined` = not resolved yet; `null` = resolved as unavailable. */
let cachedGbkDecoder: TextDecoder | null | undefined;

function resolveGbkDecoder(): TextDecoder | null {
  if (cachedGbkDecoder === undefined) {
    try {
      cachedGbkDecoder = new TextDecoder("gbk");
    } catch {
      try {
        // gb18030 is a superset of GBK and a more widely available ICU label.
        cachedGbkDecoder = new TextDecoder("gb18030");
      } catch {
        cachedGbkDecoder = null;
      }
    }
  }

  return cachedGbkDecoder;
}

export interface GbkDecodableResponse {
  text(): Promise<string>;
  arrayBuffer?(): Promise<ArrayBuffer>;
}

/** Reads a Tencent response body as GBK text (UTF-8/`text()` fallback). */
export async function readGbkText(response: GbkDecodableResponse): Promise<string> {
  const decoder = resolveGbkDecoder();

  if (decoder !== null && typeof response.arrayBuffer === "function") {
    const buffer = await response.arrayBuffer();
    return decoder.decode(new Uint8Array(buffer));
  }

  return response.text();
}
