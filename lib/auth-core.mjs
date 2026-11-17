// Cœur cryptographique de l'accès public (mot de passe + code TOTP) : server.mjs et scripts/creer-acces.mjs.
// node:crypto uniquement : base32, TOTP (RFC 6238), mot de passe scrypt, jeton de session signé.
import { createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'

// ── Base32 (RFC 4648, sans remplissage) : format des secrets TOTP ───────────
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32Encode(buf) {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of buf) {
    value = ((value << 8) | byte) & 0xffff
    bits += 8
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31]
  return out
}

export function base32Decode(str) {
  let bits = 0
  let value = 0
  const out = []
  for (const c of String(str).toUpperCase().replace(/[\s=-]/g, '')) {
    const i = B32.indexOf(c)
    if (i < 0) throw new Error('secret base32 invalide')
    value = ((value << 5) | i) & 0xffff
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

// ── TOTP : SHA1, 6 chiffres, pas de 30 s ─────────────────────────────────────
export const TOTP_PERIOD = 30
export const TOTP_ISSUER = 'Meydan'

export function hotp(key, counter, digits = 6) {
  const msg = Buffer.alloc(8)
  msg.writeBigUInt64BE(BigInt(counter))
  const h = createHmac('sha1', key).update(msg).digest()
  const off = h[h.length - 1] & 0x0f
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3]
  return String(bin % 10 ** digits).padStart(digits, '0')
}

export const newTotpSecret = () => base32Encode(randomBytes(20))

export const otpauthUri = (user, secret) =>
  `otpauth://totp/${encodeURIComponent(TOTP_ISSUER)}:${encodeURIComponent(user)}?secret=${secret}&issuer=${encodeURIComponent(TOTP_ISSUER)}&algorithm=SHA1&digits=6&period=${TOTP_PERIOD}`

// Code valide à ±1 pas (dérive d'horloge) → numéro du pas validé, sinon null.
// afterStep : dernier pas déjà consommé ; un code de ce pas ou d'un pas antérieur est refusé (anti-rejeu).
export function verifyTotp(secret, code, { now = Date.now(), afterStep = -1 } = {}) {
  if (!/^\d{6}$/.test(String(code))) return null
  const key = base32Decode(secret)
  const step = Math.floor(now / 1000 / TOTP_PERIOD)
  let found = null
  for (let s = step - 1; s <= step + 1; s++) {
    if (timingSafeEqual(Buffer.from(hotp(key, s)), Buffer.from(String(code))) && s > afterStep && found === null) found = s
  }
  return found
}

// ── Mot de passe : scrypt N=2^15 r=8 p=3 (OWASP), format scrypt$N$r$p$sel$empreinte ──
const SCRYPT = { N: 2 ** 15, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }

const derive = (password, salt, len, opts) =>
  new Promise((resolve, reject) => scrypt(String(password).normalize('NFKC'), salt, len, opts, (e, k) => (e ? reject(e) : resolve(k))))

export async function hashPassword(password) {
  const salt = randomBytes(16)
  const key = await derive(password, salt, 32, SCRYPT)
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${key.toString('base64url')}`
}

export async function verifyPassword(password, stored) {
  const [kind, N, r, p, salt, hash] = String(stored).split('$')
  if (kind !== 'scrypt' || !hash) return false
  const expected = Buffer.from(hash, 'base64url')
  try {
    const key = await derive(password, Buffer.from(salt, 'base64url'), expected.length, { N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem })
    return key.length === expected.length && timingSafeEqual(key, expected)
  } catch {
    return false
  }
}

// ── Session : jeton « v1.<expiration>.<signature> », HMAC-SHA256 avec le secret de session ──
export const SESSION_TTL_S = 7 * 24 * 3600

// Un secret vide ou tronqué rendrait les jetons falsifiables : 32 octets hex exigés.
const sign = (secretHex, body) => {
  if (!/^[0-9a-f]{64}$/.test(String(secretHex))) throw new Error('secret de session invalide')
  return createHmac('sha256', Buffer.from(secretHex, 'hex')).update(body).digest()
}

export const newSessionSecret = () => randomBytes(32).toString('hex')

export function signSession(secretHex, ttlSeconds = SESSION_TTL_S, now = Date.now()) {
  const body = `v1.${Math.floor(now / 1000) + ttlSeconds}`
  return `${body}.${sign(secretHex, body).toString('base64url')}`
}

export function verifySession(secretHex, token, now = Date.now()) {
  const m = /^v1\.(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(String(token ?? ''))
  if (!m || Number(m[1]) * 1000 <= now) return false
  try {
    const expected = sign(secretHex, `v1.${m[1]}`)
    const got = Buffer.from(m[2], 'base64url')
    return got.length === expected.length && timingSafeEqual(got, expected)
  } catch {
    return false
  }
}

// ── Passerelle entre les apps : jeton « h1.<app>.<expiration>.<nonce>.<signature> », 60 s, une seule app ──
// L'application connectée le signe, l'app visée le vérifie puis ouvre sa propre session ; l'anti-rejeu (nonce consommé)
// est à la charge de l'app visée. Clé dérivée du secret de session : un jeton de passerelle n'est jamais une session.
export const HANDOFF_TTL_S = 60
const handoffKey = secretHex => sign(secretHex, 'handoff-v1').toString('hex')

export function signHandoff(secretHex, app, now = Date.now()) {
  if (!/^[a-z0-9]{1,16}$/.test(String(app))) throw new Error('app de passerelle invalide')
  const body = `h1.${app}.${Math.floor(now / 1000) + HANDOFF_TTL_S}.${randomBytes(12).toString('base64url')}`
  return `${body}.${sign(handoffKey(secretHex), body).toString('base64url')}`
}

// Jeton valable pour cette app → { nonce, exp } (exp en ms, pour oublier le nonce après) ; sinon null.
export function verifyHandoff(secretHex, token, app, now = Date.now()) {
  const m = /^h1\.([a-z0-9]{1,16})\.(\d{1,12})\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{43})$/.exec(String(token ?? ''))
  if (!m || m[1] !== app) return null
  const exp = Number(m[2]) * 1000
  // Expiré, ou plus lointain que ce que signHandoff produit (5 s de marge d'horloge) : refusé.
  if (exp <= now || exp > now + (HANDOFF_TTL_S + 5) * 1000) return null
  try {
    const expected = sign(handoffKey(secretHex), `h1.${m[1]}.${m[2]}.${m[3]}`)
    const got = Buffer.from(m[4], 'base64url')
    return got.length === expected.length && timingSafeEqual(got, expected) ? { nonce: m[3], exp } : null
  } catch {
    return null
  }
}
