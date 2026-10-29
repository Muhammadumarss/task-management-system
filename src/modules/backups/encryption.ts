import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { createReadStream, createWriteStream, promises as fs } from 'fs';
import { pipeline } from 'stream/promises';
import { Transform } from 'stream';

/**
 * Encrypted backup file format (authenticated, streaming):
 *   "PTBK" | version(1) | keyIdLen(1) | keyId | iv(12) | ciphertext... | tag(16)
 * The header bytes are bound as AES-GCM additional authenticated data.
 */
const MAGIC = Buffer.from('PTBK');
const VERSION = 1;
const TAG_LEN = 16;
export const ENCRYPTION_FORMAT = 'PTBK1/aes-256-gcm';

function header(keyId: string, iv: Buffer): Buffer {
  const kid = Buffer.from(keyId, 'utf8');
  if (kid.length === 0 || kid.length > 255) throw new Error('Invalid key id');
  return Buffer.concat([MAGIC, Buffer.from([VERSION, kid.length]), kid, iv]);
}

export async function encryptFile(src: string, dest: string, keyId: string, key: Buffer): Promise<void> {
  const iv = randomBytes(12);
  const head = header(keyId, iv);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(head);
  const out = createWriteStream(dest, { mode: 0o600 });
  out.write(head);
  await pipeline(createReadStream(src), cipher, out, { end: false });
  await new Promise<void>((resolve, reject) => {
    out.end(cipher.getAuthTag(), () => resolve());
    out.on('error', reject);
  });
}

export async function readKeyId(file: string): Promise<string> {
  const fh = await fs.open(file, 'r');
  try {
    const buf = Buffer.alloc(6);
    await fh.read(buf, 0, 6, 0);
    if (!buf.subarray(0, 4).equals(MAGIC) || buf[4] !== VERSION) throw new Error('Not a recognised backup file');
    const kid = Buffer.alloc(buf[5]!);
    await fh.read(kid, 0, kid.length, 6);
    return kid.toString('utf8');
  } finally {
    await fh.close();
  }
}

export async function decryptFile(src: string, dest: string, keys: Record<string, Buffer>): Promise<string> {
  const keyId = await readKeyId(src);
  const key = keys[keyId];
  if (!key) throw new Error(`Decryption key "${keyId}" is not available`);
  const stat = await fs.stat(src);
  const headLen = 6 + Buffer.byteLength(keyId) + 12;
  const fh = await fs.open(src, 'r');
  let head: Buffer;
  let tag: Buffer;
  try {
    head = Buffer.alloc(headLen);
    await fh.read(head, 0, headLen, 0);
    tag = Buffer.alloc(TAG_LEN);
    await fh.read(tag, 0, TAG_LEN, stat.size - TAG_LEN);
  } finally {
    await fh.close();
  }
  const iv = head.subarray(headLen - 12);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(head);
  decipher.setAuthTag(tag);
  // Write to a temp path and only rename after the tag verifies, so unauthenticated
  // plaintext is never left at the destination.
  const tmp = `${dest}.partial`;
  try {
    await pipeline(
      createReadStream(src, { start: headLen, end: stat.size - TAG_LEN - 1 }),
      decipher,
      createWriteStream(tmp, { mode: 0o600 }),
    );
    await fs.rename(tmp, dest);
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e;
  }
  return keyId;
}

export async function fileDigests(file: string): Promise<{ sha256: string; md5: string; size: number }> {
  const sha = createHash('sha256');
  const md5 = createHash('md5');
  let size = 0;
  await pipeline(
    createReadStream(file),
    new Transform({
      transform(chunk: Buffer, _enc, cb) {
        sha.update(chunk);
        md5.update(chunk);
        size += chunk.length;
        cb();
      },
    }),
  );
  return { sha256: sha.digest('hex'), md5: md5.digest('hex'), size };
}

/** Best-effort removal of temporary plaintext: overwrite with zeros, then delete. */
export async function secureDelete(file: string): Promise<void> {
  try {
    const { size } = await fs.stat(file);
    const fh = await fs.open(file, 'r+');
    try {
      const zero = Buffer.alloc(Math.min(size, 1 << 20));
      for (let pos = 0; pos < size; pos += zero.length) {
        await fh.write(zero, 0, Math.min(zero.length, size - pos), pos);
      }
    } finally {
      await fh.close();
    }
  } catch {
    /* file may not exist */
  }
  await fs.rm(file, { force: true });
}
