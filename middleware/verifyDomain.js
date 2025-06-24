const fs = require('fs');
const path = require('path');

const DOMAIN_FILE = path.join(__dirname, '../data/allowed-domains.json');

function extractDomain(origin) {
  try {
    if (origin.includes('://')) {
      const url = new URL(origin);
      return url.hostname.replace(/^www\./, '').toLowerCase();
    }
    return origin.replace(/^www\./, '').toLowerCase();
  } catch (err) {
    console.error('Invalid origin header:', origin);
    return '';
  }
}

function getAllowedDomains() {
  try {
    const raw = fs.readFileSync(DOMAIN_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch (e) {
    console.error('Failed to read allowed-domains.json:', e.message);
    return [];
  }
}

function verifyDomain(req, res, next) {
  const originHeader = req.header('x-origin-domain') || req.header('referer') || '';
  const domain = extractDomain(originHeader);

  console.log('🔐 Verifying domain:', domain);

  const allowedDomains = getAllowedDomains();
  if (!domain || !allowedDomains.includes(domain)) {
    console.warn(`❌ Domain not allowed: ${domain}`);
    return res.status(403).json({ error: 'Unauthorized domain' });
  }

  req.site = domain;
  next();
}

module.exports = verifyDomain;
