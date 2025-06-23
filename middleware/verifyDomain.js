const allowedSites = require('../config/allowedSites');

function extractDomain(origin) {
  try {
    // If it's a full URL (has protocol), parse normally
    if (origin.includes('://')) {
      const url = new URL(origin);
      return url.hostname.replace(/^www\./, '').toLowerCase();
    }
    // Otherwise treat it as a raw domain
    return origin.replace(/^www\./, '').toLowerCase();
  } catch (err) {
    console.error('Invalid origin header:', origin);
    return '';
  }
}

function verifyDomain(req, res, next) {
  const token = req.header('x-site-token');
  const originHeader = req.header('x-origin-domain') || req.header('referer') || '';

  console.log('Token:', token);
  console.log('Origin/Referer:', originHeader);

  const domain = extractDomain(originHeader);
  console.log('Resolved domain:', domain);

  if (!token || !domain) {
    return res.status(400).json({ error: 'Missing token or invalid origin domain' });
  }

  if (!allowedSites[domain] || allowedSites[domain] !== token) {
    return res.status(403).json({ error: 'Unauthorized domain or token mismatch' });
  }

  req.site = domain;
  next();
}

module.exports = verifyDomain;
