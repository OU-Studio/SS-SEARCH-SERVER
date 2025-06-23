// middleware/verifyDomain.js
const allowedSites = require('../config/allowedSites');

function extractDomain(origin) {
  try {
    const url = new URL(origin);
    return url.hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function verifyDomain(req, res, next) {
  const token = req.header('x-site-token');
  const originHeader = req.header('x-origin-domain') || req.header('referer');

  console.log('Token:', req.header('x-site-token'));
console.log('Origin/Referer:', req.header('x-origin-domain') || req.header('referer'));

  console.log('Resolved domain:', extractDomain(req.header('x-origin-domain') || req.header('referer')));



  if (!token || !originHeader) {
    return res.status(400).json({ error: 'Missing token or origin domain' });
  }

  const domain = extractDomain(originHeader);

  if (!allowedSites[domain] || allowedSites[domain] !== token) {
    return res.status(403).json({ error: 'Unauthorized domain or invalid token' });
  }

  req.verifiedSite = domain;
  next();
}

module.exports = verifyDomain;
