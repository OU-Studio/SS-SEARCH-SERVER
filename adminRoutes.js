// api to update allowed-domains.json
const express = require('express');
const fs = require('fs');
const path = require('path');
const { ADMIN_TOKEN } = require('./config/config');

const adminRouter = express.Router();
const DOMAIN_FILE = path.join(__dirname, 'data', 'allowed-domains.json');

// Middleware to verify admin token
adminRouter.use((req, res, next) => {
  const token = req.headers['x-admin-token'];
  if (token !== ADMIN_TOKEN) return res.status(403).json({ error: 'Forbidden' });
  next();
});

// Get current domains
adminRouter.get('/domains', (req, res) => {
  const data = fs.readFileSync(DOMAIN_FILE, 'utf-8');
  res.json({ domains: JSON.parse(data) });
});

// Update domains
adminRouter.post('/domains', (req, res) => {
  const { domains } = req.body;
  if (!Array.isArray(domains)) return res.status(400).json({ error: 'Invalid data' });

  fs.writeFileSync(DOMAIN_FILE, JSON.stringify(domains, null, 2));
  res.json({ message: 'Updated successfully' });
});

const cheerio = require('cheerio');
const axios = require('axios');
const { parseStringPromise } = require('xml2js');

const getCacheFilePath = (domain) => {
  const safe = domain.replace(/[^a-z0-9.-]/gi, '_');
  return path.join(__dirname, 'data', 'cached-indexes', `${safe}.json`);
};

adminRouter.post('/index', async (req, res) => {
  const { domain } = req.body;
  if (!domain) return res.status(400).json({ error: 'Missing domain' });

  const cleanDomain = domain.replace(/^https?:\/\//, '');
  const fullDomain = `https://${cleanDomain}`;

  try {
    const sitemapUrl = fullDomain + '/sitemap.xml';
    const sitemapRes = await axios.get(sitemapUrl);
    const sitemapData = await parseStringPromise(sitemapRes.data);

    const urls = sitemapData.urlset.url.map(u => u.loc[0]).filter(u => u.startsWith(fullDomain));
    const indexData = [];

    for (const url of urls) {
      try {
        const pageRes = await axios.get(url);
        const $ = cheerio.load(pageRes.data);
        const title = $('title').text().trim();
        const description = $('meta[name="description"]').attr('content') || '';
        const content = $('main').text().replace(/\s+/g, ' ').trim();
        if (title || description || content) {
          indexData.push({
            url: url.replace(fullDomain, ''),
            title,
            description,
            content
          });
        }
      } catch (_) {}
    }

    const filePath = getCacheFilePath(cleanDomain);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(indexData, null, 2));
    res.json({ message: 'Index created', pages: indexData.length });
  } catch (err) {
    console.error('Manual indexing error:', err.message);
    res.status(500).json({ error: 'Failed to index domain' });
  }
});


module.exports = adminRouter;
