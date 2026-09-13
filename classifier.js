// classifier.js
// Zero-cost message classifier: subject, information type and entity
// extraction. Heuristic (FR/EN) on purpose — no LLM calls at ingestion time,
// which keeps graph building essentially free (see GraphRAG cost strategies).

const SUBJECT_RULES = [
  { subject: 'work',     kw: ['travail', 'boulot', 'réunion', 'meeting', 'projet', 'client', 'deadline', 'contrat', 'facture', 'work', 'meeting', 'project', 'invoice', 'report', 'rapport'] },
  { subject: 'tech',     kw: ['bug', 'erreur', 'server', 'serveur', 'code', 'api', 'deploy', 'déploiement', 'docker', 'database', 'base de données', 'wifi', 'internet', 'pc', 'email', 'mot de passe'] },
  { subject: 'money',    kw: ['paiement', 'payer', 'facture', 'prix', 'euros', 'eur', 'fcfa', 'budget', 'virement', 'money', 'pay', 'price', 'cost', 'bank', 'banque'] },
  { subject: 'meeting',  kw: ['rendez-vous', 'rdv', 'dispo', 'disponible', 'créneau', 'à quelle heure', 'quand est-ce', 'appointment', 'schedule', 'calendar', 'agenda', 'call', 'appel', 'visio'] },
  { subject: 'travel',   kw: ['vol', 'train', 'voyage', 'hôtel', 'hotel', 'avion', 'trafic', 'itinéraire', 'flight', 'travel', 'trip', 'ticket'] },
  { subject: 'health',   kw: ['malade', 'maladie', 'médecin', 'docteur', 'pharmacie', 'ordonnance', 'sick', 'doctor', 'health', 'santé', 'hopital', 'hôpital'] },
  { subject: 'family',   kw: ['maman', 'papa', 'fils', 'fille', 'famille', 'enfants', 'mariage', 'anniversaire', 'family', 'wife', 'mari', 'femme', 'bébé'] },
  { subject: 'shopping', kw: ['acheter', 'commande', 'livraison', 'colis', 'magasin', 'shopping', 'order', 'buy', 'delivery', 'packaged', 'amazon'] },
];

const TYPE_RULES = [
  { type: 'question',    re: /\?|^(qui|que|quoi|quand|où|comment|pourquoi|combien|which|what|when|where|how|why|how much)\b/i },
  { type: 'request',     re: /\b(peux-tu|pourrais-tu|pouvez-vous|merci de|prière de|envoie|envoyez|donne|m'appelles|rappelle|please|could you|can you|send me|call me)\b/i },
  { type: 'confirmation', re: /^(ok|oké|d'accord|dac|ça marche|parfait|c'est noté|oui|non|yes|no|sure|fine|done|c'est fait|vu)\b/i },
  { type: 'greeting',    re: /^(bonjour|bonsoir|salut|coucou|hello|hi|hey|good morning|good evening)\b/i },
  { type: 'scheduling',  re: /\b(demain|aujourd'hui|hier|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|\d{1,2}h\d{2}|\d{1,2}:\d{2}|tomorrow|today|monday|am|pm)\b/i },
];

const PHONE_RE = /(\+?\d[\d\s.\-]{7,16}\d)/g;
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.]+/g;
const URL_RE = /https?:\/\/\S+/g;
const MENTION_RE = /@([\w.]{3,30})/g;
const DATE_RE = /\b(\d{1,2}[\/.-]\d{1,2}([\/.-]\d{2,4})?|(lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|janvier|février|mars|avril|mai|juin|juillet|août|septembre|octobre|novembre|décembre|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s*\d?)\b/gi;

function uniq(list) {
  return [...new Set(list)];
}

export function extractEntities(text) {
  if (!text) return { phones: [], emails: [], urls: [], mentions: [], dates: [] };
  const phones = uniq((text.match(PHONE_RE) || [])
    .map(p => p.replace(/[\s.\-()]/g, '')))
    .filter(p => p.length >= 8 && p.length <= 15);
  return {
    phones,
    emails: uniq(text.match(EMAIL_RE) || []),
    urls: uniq((text.match(URL_RE) || []).map(u => u.slice(0, 200))),
    mentions: uniq(text.match(MENTION_RE) || []).map(m => m.slice(1)),
    dates: uniq((text.match(DATE_RE) || []).map(d => d.toLowerCase().trim())),
  };
}

export function classifySubject(text) {
  if (!text) return 'general';
  const lower = text.toLowerCase();
  let best = { subject: 'general', hits: 0 };
  for (const { subject, kw } of SUBJECT_RULES) {
    const hits = kw.reduce((n, k) => n + (lower.includes(k) ? 1 : 0), 0);
    if (hits > best.hits) best = { subject, hits };
  }
  return best.subject;
}

export function classifyInfoType(text) {
  if (!text) return 'other';
  for (const { type, re } of TYPE_RULES) {
    if (re.test(text)) return type;
  }
  return 'info';
}

/**
 * Full classification of a message.
 * @returns {{subject: string, infoType: string, entities: object}}
 */
export function classifyMessage(text) {
  return {
    subject: classifySubject(text),
    infoType: classifyInfoType(text),
    entities: extractEntities(text),
  };
}

// For query routing: detect the information type the caller is looking for
export function routeQuery(query) {
  const entities = extractEntities(query);
  const hints = {};
  if (entities.phones.length || entities.emails.length || entities.urls.length) {
    hints.entities = entities;
  }
  return { subject: classifySubject(query), infoType: classifyInfoType(query), ...hints };
}
