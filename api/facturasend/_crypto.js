// ════════════════════════════════════════════════════════════════════
// Cripto server-only para la API key de FacturaSend — AES-256-GCM.
// ────────────────────────────────────────────────────────────────────
// Master key: FACTURASEND_ENC_KEY (32 bytes en base64), env de Vercel. NUNCA en
// DB ni en repo. La DB guarda sólo {ciphertext, iv, tag} (todos base64). El
// descifrado ocurre SÓLO en el server.
//
// Generar la master key (una vez):  openssl rand -base64 32
//
// NUNCA se loguea el plaintext ni la master key.
// ════════════════════════════════════════════════════════════════════
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;   // GCM: 96 bits recomendado

function masterKey() {
  const b64 = (process.env.FACTURASEND_ENC_KEY || '').trim();
  if (!b64) throw new Error('Falta FACTURASEND_ENC_KEY (master key de cifrado, 32 bytes base64)');
  const key = Buffer.from(b64, 'base64');
  if (key.length !== 32) throw new Error('FACTURASEND_ENC_KEY inválida: debe ser 32 bytes en base64');
  return key;
}

// plaintext (string) -> { ciphertext, iv, tag } (base64). Lanza si la key falta/es inválida.
export function encryptApiKey(plaintext) {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new Error('encryptApiKey: el plaintext es requerido');
  }
  const key = masterKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ciphertext: ct.toString('base64'), iv: iv.toString('base64'), tag: tag.toString('base64') };
}

// { ciphertext, iv, tag } (base64) -> plaintext (string). Lanza si el tag no valida
// (dato alterado / key equivocada) — error VISIBLE, nunca catch vacío.
export function decryptApiKey({ ciphertext, iv, tag } = {}) {
  if (!ciphertext || !iv || !tag) throw new Error('decryptApiKey: faltan ciphertext/iv/tag');
  const key = masterKey();
  const decipher = createDecipheriv(ALGO, key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  const pt = Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]);
  return pt.toString('utf8');
}
