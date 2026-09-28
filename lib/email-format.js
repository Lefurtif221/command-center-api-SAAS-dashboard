// Validation stricte du format d'email.
// - forme RFC basique (pas d'espace, un seul @, points valides)
// - TLD : soit un code pays a 2 lettres, soit un gTLD courant
//   (evite les fautes de frappe comme "gmail.col")

const COMMON_TLDS = new Set([
  'com', 'net', 'org', 'info', 'biz', 'edu', 'gov', 'mil', 'io', 'ai', 'co',
  'me', 'app', 'dev', 'xyz', 'site', 'online', 'store', 'shop', 'cloud',
  'tech', 'live', 'club', 'fun', 'icu', 'link', 'pro', 'blog', 'agency',
  'team', 'digital', 'world', 'news', 'email', 'group', 'page', 'host',
  'space', 'website', 'top', 'vip', 'one', 'design', 'studio', 'media',
  'health', 'finance', 'energy', 'solutions', 'services', 'group', 'zone',
  'today', 'life', 'love', 'wiki', 'zone', 'art', 'audio', 'video',
  // domaines RFC reserves (tests)
  'test', 'local', 'example',
]);

const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;

function isValidEmail(email) {
  if (typeof email !== 'string') return false;
  const value = email.trim();
  if (value.length === 0 || value.length > 254) return false;
  if (!EMAIL_RE.test(value)) return false;
  const tld = value.split('.').pop().toLowerCase();
  if (tld.length === 2) return true; // codes pays : fr, sn, ci, ...
  return COMMON_TLDS.has(tld);
}

module.exports = { isValidEmail, COMMON_TLDS };
