// Ateliers (volet du 13/11) : la garde de lecture propre aux ateliers, en plus de `fichierPermis` (server.mjs, partagée
// avec la route /fichier et les cartes de fichiers). Tout ce qui sort d'un fichier vers l'écran ou un PDF passe ici.
// Brief : « `.env` et clés jamais affichés (motifs refusés) » ; clarification Q1 (13/11) : le contenu aussi est regardé.
import path from 'node:path'

const refus = (message, code = 400) => Object.assign(new Error(message), { code })

// Un chemin relatif dans un projet, tel qu'une carte le garde ou qu'une demande le donne : 500 caractères au plus, ni
// absolu, ni octet nul ou caractère de contrôle, ni « \ », ni segment « .. ». Rend la forme normalisée (« » = la racine).
export function cheminRelatif(v) {
  if (v === undefined || v === null || v === '') return ''
  if (typeof v !== 'string' || v.length > 500) throw refus('chemin : 500 caractères au plus')
  if (/[\u0000-\u001f\u007f\\]/.test(v)) throw refus('chemin : caractère refusé')
  if (v.startsWith('/') || v.startsWith('~')) throw refus('chemin relatif au projet attendu')
  const segments = v.split('/').filter((s) => s && s !== '.')
  if (segments.some((s) => s === '..')) throw refus('chemin : « .. » refusé')
  return segments.join('/')
}

// Un segment caché (« .env », « .git », « .ssh »…) dans un chemin relatif.
export const cache = (rel) => rel.split('/').some((s) => s.startsWith('.'))

// Noms de fichiers de clés et de secrets : jamais lus, même hors d'un dossier caché. Une extension de clé compte aussi
// suivie d'une autre (`serveur.pem.bak`) ; relecture de sécurité du 13/11 (F1) pour les formes ajoutées.
const SECRETS = [
  /\.(pem|key|p12|pfx|keystore|jks|kdbx|ppk|gpg|asc|der|crt|cer|csr|p8|ovpn)(\.|$)/i,
  /^id_(rsa|dsa|ecdsa|ed25519)/i,
  /^(credentials?|secrets?|client_secrets?)([._-]|$)/i,
  /^service[-_]?account.*\.json$/i,
  /^(token|tokens|msal[\w.-]*cache[\w.-]*|gcp[\w-]*-sa|sa[-_]key)\.json$/i,
  /^\.?env(\.|$)/i,
  /\.env$/i,
  /^\.?(pgpass|netrc|htpasswd|kubeconfig|my\.cnf)$/i,
  /\.cnf$/i,
]
export const nomSecret = (nom) => SECRETS.some((r) => r.test(nom))

// Un bloc de clé privée dans le contenu (fichier au nom anodin) : le fichier est refusé entier.
export const clePrivee = (texte) => /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/.test(texte)

// Binaire : un octet nul dans les 8 premiers Ko, ou un texte qui n'est pas de l'UTF-8 valide.
const utf8 = new TextDecoder('utf-8', { fatal: true })
export function decode(buf) {
  if (buf.subarray(0, 8192).includes(0)) return null
  try {
    return utf8.decode(buf)
  } catch {
    return null
  }
}

// Les jetons de forme connue, masqués AVANT l'envoi (ils ne quittent jamais le serveur). Ordre : du plus précis au
// plus large (une clé Anthropic commence aussi par « sk- »). `(?<![A-Za-z0-9])` plutôt que `\b` : une clé collée à un
// nom (`KEY_sk-…`) est masquée aussi (relecture M3). Module du serveur seulement (pas de vieux Safari ici).
const AVANT = '(?<![A-Za-z0-9])'
const JETONS = [
  'sk-ant-[A-Za-z0-9_-]{20,}', // Anthropic
  'sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}', // OpenAI
  '(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}', // Stripe
  'gh[pousr]_[A-Za-z0-9]{30,}', // GitHub
  'github_pat_[A-Za-z0-9_]{40,}',
  'glpat-[A-Za-z0-9_-]{20,}', // GitLab
  '(?:AKIA|ASIA)[0-9A-Z]{16}(?![0-9A-Z])', // AWS (identifiant)
  'xox[abprs]-[A-Za-z0-9-]{10,}', // Slack
  '\\d{8,10}:AA[A-Za-z0-9_-]{30,}', // Telegram (jeton de robot ; longueur tolérée)
  'AIza[0-9A-Za-z_-]{30,}', // Google
  'GOCSPX-[A-Za-z0-9_-]{20,}', // Google (secret client OAuth)
  'pplx-[A-Za-z0-9]{20,}', // Perplexity
  'hf_[A-Za-z0-9]{20,}', // Hugging Face
  'npm_[A-Za-z0-9]{30,}', // npm
  '[A-Za-z0-9_.-]{3}\\dQ~[A-Za-z0-9_.~-]{30,}', // Microsoft Entra (secret client)
  'eyJ[A-Za-z0-9_-]{10,}\\.eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}', // JWT
].map((m) => new RegExp(AVANT + m, 'g'))
// Mot de passe d'une adresse de base de données ou de service (`postgres://utilisateur:motdepasse@hôte`).
const DSN = /([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)([^\s@/]+)@/gi
// Une valeur affectée à un nom qui dit « secret » : littéral entre guillemets (6+) ou valeur nue d'au moins 12 signes
// (fichier .env, config pm2). `token = getToken()` reste lisible (ni guillemets ni valeur nue continue).
const AFFECTE = /((?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret|private[_-]?key|auth[_-]?token)[A-Za-z0-9_]*["']?\s*[:=]\s*)(?:(["'])([^"'\n]{6,})\2|([A-Za-z0-9_\-+/=.~]{12,}))/gi
export const MASQUE = '•••masqué•••'
export function masque(texte) {
  let s = texte
  for (const r of JETONS) s = s.replace(r, MASQUE)
  s = s.replace(DSN, (_, avant) => `${avant}${MASQUE}@`)
  s = s.replace(AFFECTE, (_, avant, guillemet, entre) => (guillemet ? `${avant}${guillemet}${MASQUE}${guillemet}` : `${avant}${MASQUE}`))
  return s
}

// Le genre d'un fichier, d'après son extension : `md` et `html` ont leur rendu, le reste est du texte (colorié par
// l'interface d'après le nom).
export function typeDe(nom) {
  const ext = path.extname(nom).toLowerCase()
  if (ext === '.md' || ext === '.markdown') return 'md'
  if (ext === '.html' || ext === '.htm') return 'html'
  return 'texte'
}
// Bornes de lecture : un document rendu (2 Mo), tout autre fichier texte (1 Mo).
export const borneDe = (type) => (type === 'md' || type === 'html' ? 2 * 1024 * 1024 : 1024 * 1024)

// Dossiers lourds connus : montrés dans l'arbre, jamais parcourus (ni par la recherche ni par le coffre).
export const LOURDS = new Set(['node_modules', 'dist', 'build', '__pycache__', 'venv', 'env', 'target', 'coverage', 'vendor', 'bower_components', 'dist-volet'])
