import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  constants,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
  scrypt as scryptCallback,
} from "node:crypto";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { atomicWritePrivateTextFile } from "@lcode/shared/node";
// v1 恢复工具包固定 KDF 参数，不能随 Node 默认参数变化使已有工具包无法解锁。
const scrypt = (password: string, salt: Uint8Array, length: number) =>
  new Promise<Buffer>((resolve, reject) =>
    scryptCallback(
      password,
      salt,
      length,
      { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (error, key) => (error ? reject(error) : resolve(key)),
    ),
  );
export function backupKeyId(publicKey: string): string {
  return createHash("sha256")
    .update(createPublicKey(publicKey).export({ type: "spki", format: "der" }))
    .digest("hex");
}
function encrypt(value: unknown, key: Buffer, aad: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad));
  return {
    iv: iv.toString("base64"),
    data: Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]).toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}
function decrypt(
  value: { iv: string; data: string; tag: string },
  key: Buffer,
  aad: string,
): unknown {
  const cipher = createDecipheriv("aes-256-gcm", key, Buffer.from(value.iv, "base64"));
  cipher.setAAD(Buffer.from(aad));
  cipher.setAuthTag(Buffer.from(value.tag, "base64"));
  return JSON.parse(
    Buffer.concat([cipher.update(Buffer.from(value.data, "base64")), cipher.final()]).toString(
      "utf8",
    ),
  );
}
export function createBackupCrypto(
  dataDir: string,
  keys: () => Promise<{ publicKey: string; privateKey: string }>,
) {
  const keyDir = join(dataDir, "imported-keys");
  return {
    async seal(value: unknown) {
      const pair = await keys();
      const keyId = backupKeyId(pair.publicKey);
      const key = randomBytes(32);
      const wrapped = publicEncrypt(
        { key: pair.publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
        key,
      ).toString("base64");
      return {
        bytes: Buffer.from(
          JSON.stringify({
            version: 2,
            keyId,
            wrapped,
            ...encrypt(value, key, `lcode-backup/v2:${keyId}`),
          }),
        ),
        keyId,
      };
    },
    async open(bytes: Uint8Array): Promise<unknown> {
      try {
        if (bytes.length > 768 * 1024 * 1024) throw new Error();
        const envelope = JSON.parse(Buffer.from(bytes).toString("utf8"));
        if (envelope.version !== 2 || !/^[a-f0-9]{64}$/.test(envelope.keyId)) throw new Error();
        const pair = await keys();
        const privateKey =
          backupKeyId(pair.publicKey) === envelope.keyId
            ? pair.privateKey
            : await readFile(join(keyDir, `${envelope.keyId}.pem`), "utf8");
        const key = privateDecrypt(
          { key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
          Buffer.from(envelope.wrapped, "base64"),
        );
        return decrypt(envelope, key, `lcode-backup/v2:${envelope.keyId}`);
      } catch {
        throw new Error("Backup authentication failed or the recovery key is missing");
      }
    },
    async exportKeys(password: string) {
      if (password.length < 8)
        throw new Error("Recovery password must contain at least 8 characters");
      const pair = await keys();
      const keyId = backupKeyId(pair.publicKey);
      const ring = [pair];
      try {
        for (const file of (await readdir(keyDir))
          .filter((file) => /^[a-f0-9]{64}\.pem$/.test(file))
          .slice(0, 99)) {
          const privateKey = await readFile(join(keyDir, file), "utf8");
          const publicKey = createPublicKey(privateKey)
            .export({ type: "spki", format: "pem" })
            .toString();
          if (backupKeyId(publicKey) !== keyId) ring.push({ privateKey, publicKey });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const salt = randomBytes(16);
      const key = (await scrypt(password, salt, 32)) as Buffer;
      return JSON.stringify({
        version: 1,
        kdf: "scrypt",
        keyId,
        salt: salt.toString("base64"),
        ...encrypt({ keys: ring }, key, `lcode-recovery/v1:${keyId}`),
      });
    },
    async importKeys(text: string, password: string) {
      let pairs: { privateKey: string; publicKey: string }[];
      try {
        if (text.length > 1024 * 1024) throw new Error();
        if (text.trim().startsWith("-----BEGIN")) {
          const privateKey = createPrivateKey(text)
            .export({ type: "pkcs8", format: "pem" })
            .toString();
          pairs = [
            {
              privateKey,
              publicKey: createPublicKey(privateKey)
                .export({ type: "spki", format: "pem" })
                .toString(),
            },
          ];
        } else {
          const kit = JSON.parse(text);
          const keyId = kit.keyId;
          if (kit.version !== 1 || kit.kdf !== "scrypt" || !/^[a-f0-9]{64}$/.test(keyId))
            throw new Error();
          const salt = Buffer.from(kit.salt, "base64");
          if (salt.length !== 16) throw new Error();
          const key = (await scrypt(password, salt, 32)) as Buffer;
          const payload = decrypt(kit, key, "lcode-recovery/v1:" + keyId) as {
            keys?: { privateKey: string; publicKey: string }[];
            privateKey: string;
            publicKey: string;
          };
          pairs = payload.keys ?? [payload];
          if (!pairs.length || pairs.length > 100 || backupKeyId(pairs[0]!.publicKey) !== keyId)
            throw new Error();
        }
        for (const pair of pairs)
          if (
            backupKeyId(pair.publicKey) !==
            backupKeyId(
              createPublicKey(createPrivateKey(pair.privateKey))
                .export({ type: "spki", format: "pem" })
                .toString(),
            )
          )
            throw new Error();
      } catch {
        throw new Error("Invalid recovery kit or password");
      }
      await mkdir(keyDir, { recursive: true });
      for (const pair of pairs)
        await atomicWritePrivateTextFile(
          join(keyDir, backupKeyId(pair.publicKey) + ".pem"),
          pair.privateKey,
        );
    },
    async openLegacy(encryptedKey: Uint8Array, iv: Uint8Array, data: Uint8Array) {
      const pair = await keys();
      const candidates = [pair.privateKey];
      try {
        for (const file of (await readdir(keyDir))
          .filter((file) => /^[a-f0-9]{64}\.pem$/.test(file))
          .slice(0, 100))
          candidates.push(await readFile(join(keyDir, file), "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      for (const privateKey of candidates) {
        try {
          const key = privateDecrypt(
            { key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
            encryptedKey,
          );
          const cipher = createDecipheriv("aes-256-ctr", key, iv);
          return Buffer.concat([cipher.update(data), cipher.final()]);
        } catch {
          /* 未匹配的旧私钥只继续尝试，不生成替代密钥。 */
        }
      }
      throw new Error("Legacy backup recovery key is missing");
    },
  };
}
