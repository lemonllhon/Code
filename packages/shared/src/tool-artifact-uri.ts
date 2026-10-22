/** 历史 zcode 引用与当前 lcode 引用属于同一存储协议，所有读取入口共用此识别规则。 */
export function isToolArtifactUri(
  value: unknown,
): value is `${"lcode" | "zcode"}-artifact://${string}` {
  return typeof value === "string" && /^(?:lcode|zcode)-artifact:\/\//u.test(value);
}

export function parseToolArtifactUri(uri: string): { artifactId: string; sessionId: string } {
  if (!isToolArtifactUri(uri)) throw new Error(`Unsupported tool artifact URI: ${uri}`);
  const match = /^(?:lcode|zcode)-artifact:\/\/([^/?#]+)\/([^/?#]+)$/u.exec(uri);
  try {
    if (!match) throw new Error("Expected session and artifact identifiers");
    const sessionId = decodeURIComponent(match[1]!);
    const artifactId = decodeURIComponent(match[2]!);
    for (const id of [sessionId, artifactId]) {
      if (
        !id ||
        id === "." ||
        id === ".." ||
        /[/\\]/u.test(id) ||
        [...id].some((character) => character.charCodeAt(0) < 32)
      ) {
        throw new Error("Invalid artifact identifier");
      }
    }
    return { artifactId, sessionId };
  } catch (cause) {
    throw new Error(`Invalid tool artifact URI: ${uri}`, { cause });
  }
}

export function createToolArtifactUri(sessionId: string, artifactId: string): string {
  return `lcode-artifact://${encodeURIComponent(sessionId)}/${encodeURIComponent(artifactId)}`;
}
