import { createHash } from "node:crypto";
import type { GitDetectedSshKey } from "@lcode/shared";
import { readGitDetectionFile } from "./gitDetectionFiles.js";

/** 仅接受公开的 SSH wire blob；私钥文件只作为路径引用，从不读取原文。 */
function publicKeyInfo(content: string) {
  const line = content.trim();
  if (line.includes("\n") || line.includes("\r")) return null;
  const match = line.match(
    /^(ssh-ed25519|ssh-rsa|ssh-dss|ecdsa-sha2-nistp(?:256|384|521)|sk-ssh-ed25519@openssh.com|sk-ecdsa-sha2-nistp256@openssh.com)\s+([A-Za-z0-9+/]+={0,2})(?:\s+.*)?$/,
  );
  if (!match) return null;
  const type = match[1]!,
    blob = Buffer.from(match[2]!, "base64");
  if (blob.toString("base64").replace(/=+$/, "") !== match[2]!.replace(/=+$/, "")) return null;
  let offset = 0;
  const field = () => {
    if (offset + 4 > blob.length) throw new Error("invalid-public-key");
    const size = blob.readUInt32BE(offset);
    offset += 4;
    if (!size || offset + size > blob.length) throw new Error("invalid-public-key");
    const data = blob.subarray(offset, offset + size);
    offset += size;
    return data;
  };
  try {
    if (field().toString("utf8") !== type) return null;
    if (type.includes("ed25519")) {
      if (field().length !== 32) return null;
    } else if (type.includes("ecdsa")) {
      const curve = field().toString("utf8");
      if (!type.includes(curve)) return null;
      const point = field();
      if (
        point[0] !== 4 ||
        point.length !==
          ({ nistp256: 65, nistp384: 97, nistp521: 133 } as Record<string, number>)[curve]
      )
        return null;
    } else {
      for (let i = 0; i < (type === "ssh-rsa" ? 2 : 4); i++) field();
    }
    if (type.startsWith("sk-")) field();
    if (offset !== blob.length) return null;
  } catch {
    return null;
  }
  return {
    keyType: type,
    fingerprint: "SHA256:" + createHash("sha256").update(blob).digest("base64").replace(/=+$/, ""),
    publicKey: line,
  };
}

export async function detectSshPublicKeys(paths: string[]): Promise<GitDetectedSshKey[]> {
  return Promise.all(
    paths.map(async (privateKeyPath) => {
      const publicKeyPath = privateKeyPath + ".pub";
      const content = await readGitDetectionFile(publicKeyPath, 16384).catch(() => null);
      const info = content === null ? null : publicKeyInfo(content);
      return {
        privateKeyPath,
        publicKeyPath,
        keyType: null,
        fingerprint: null,
        publicKey: null,
        ...info,
      };
    }),
  );
}
