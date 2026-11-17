#!/usr/bin/env node
// Node seul ; fonctionne depuis Claude Code et Codex. Aucun appel réseau.
import { deposeSuggestion } from '../lib/suggestions.mjs'
const [type, ...mots] = process.argv.slice(2)
try {
  const session = process.env.MEYDAN_ID || process.env.CODEX_THREAD_ID || process.env.CLAUDE_SESSION_ID || process.env.MEYDAN_SUGGESTION_SESSION
  const x = deposeSuggestion({ type, texte: mots.join(' '), projet: process.env.MEYDAN_SUGGESTION_PROJECT || process.cwd(), session })
  console.log(`Entrée ${x.id} déposée.`)
} catch (e) {
  console.error(`Suggestion non déposée : ${e.message}`)
  process.exitCode = 1
}
