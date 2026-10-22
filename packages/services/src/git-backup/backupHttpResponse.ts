export async function readBackupResponse(
  response: Response,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const limit = 768 * 1024 * 1024;
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel();
    throw new Error("Backup response exceeds size limit");
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > limit) throw new Error("Backup response exceeds size limit");
      chunks.push(chunk.value);
    }
    signal.throwIfAborted();
    return Buffer.concat(chunks, size);
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}
