// Petits fichiers d'état du lot « serveur » des décisions du 17/11 (DATA/espaces.json, DATA/comptes-noms.json) : lecture
// au démarrage et écriture atomique, sous garde. Relecture de sécurité du 17/11 sur le lot : une FIFO posée à la place
// du fichier bloquait le démarrage du moteur ; un lien était lu à travers ; un dossier à la place du `.tmp` rendait un
// 400 avec le chemin absolu du serveur.
//
// Contrat :
//   lisJson(fichier, { etiquette, max }) → la valeur JSON lue, ou `undefined` si le fichier est absent (premier
//     lancement), ou `null` s'il était là mais illisible : il a alors été MIS DE CÔTÉ sous un autre nom (jamais écrasé
//     ensuite par une liste vide) et c'est dit au journal. N'est lu qu'un fichier ordinaire (ni lien, ni FIFO, ni
//     dossier), de `max` octets au plus (4 Mio par défaut), ouvert sans suivre de lien et sans bloquer.
//   deCote(fichier, raison, { etiquette, copie }) : met le fichier de côté (`<fichier>.illisible-<date>`), le déplace,
//     ou le copie (`copie: true` : l'original reste en service) ; dit au journal.
//   ecritAtomique(fichier, contenu, { etiquette }) : fichier temporaire neuf (0600) puis renommage. Un `.tmp` qui n'est
//     pas un fichier ordinaire est mis de côté d'abord. Un échec lève une erreur { code: 500 } à la phrase simple, sans
//     chemin du serveur ; le détail va au journal.
import fs from 'node:fs'
import path from 'node:path'

export const MAX_OCTETS = 4 << 20
const dateCote = () => new Date().toISOString().replace(/[:.]/g, '-')

export function deCote(fichier, raison, { etiquette = 'état', copie = false } = {}) {
  const cote = `${fichier}.illisible-${dateCote()}`
  try {
    if (copie) fs.copyFileSync(fichier, cote, fs.constants.COPYFILE_EXCL)
    else fs.renameSync(fichier, cote)
    console.error(`[${etiquette}] ${path.basename(fichier)} ${raison} : ${copie ? 'copié' : 'mis de côté'} dans ${path.basename(cote)}`)
  } catch (e) {
    console.error(`[${etiquette}] ${path.basename(fichier)} ${raison}, et impossible à mettre de côté (${e.message})`)
  }
}

export function lisJson(fichier, { etiquette = 'état', max = MAX_OCTETS } = {}) {
  let fd
  try {
    // O_NOFOLLOW : un lien n'est pas suivi (ELOOP) ; O_NONBLOCK : une FIFO ne bloque pas l'ouverture.
    fd = fs.openSync(fichier, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
  } catch (e) {
    if (e.code === 'ENOENT') return undefined
    deCote(fichier, `illisible (${e.code === 'ELOOP' ? 'lien symbolique' : e.message})`, { etiquette })
    return null
  }
  let raison = ''
  let valeur = null
  try {
    const st = fs.fstatSync(fd)
    if (!st.isFile()) raison = `pas un fichier ordinaire (${st.isFIFO() ? 'FIFO' : st.isDirectory() ? 'dossier' : 'autre'})`
    else if (st.size > max) raison = `trop gros (${st.size} octets, ${max} au plus)`
    else valeur = JSON.parse(fs.readFileSync(fd, 'utf8'))
  } catch (e) {
    raison = `illisible (${e.message})`
  } finally {
    fs.closeSync(fd)
  }
  if (!raison) return valeur
  deCote(fichier, raison, { etiquette })
  return null
}

export function ecritAtomique(fichier, contenu, { etiquette = 'état' } = {}) {
  const tmp = `${fichier}.tmp`
  try {
    let st = null
    try {
      st = fs.lstatSync(tmp)
    } catch (e) {
      if (e.code !== 'ENOENT') throw e
    }
    if (st && !st.isFile()) deCote(tmp, 'pas un fichier ordinaire', { etiquette })
    else if (st) fs.rmSync(tmp)
    fs.writeFileSync(tmp, contenu, { flag: 'wx', mode: 0o600 })
    fs.renameSync(tmp, fichier)
  } catch (e) {
    console.error(`[${etiquette}] écriture de ${path.basename(fichier)} impossible : ${e.message}`)
    throw Object.assign(new Error('le serveur n’a pas pu écrire sur son disque (le détail est dans son journal)'), { code: 500 })
  }
}
