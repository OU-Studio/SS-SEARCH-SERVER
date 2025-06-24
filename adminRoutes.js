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
  const { domain, id } = req.body;
  if (!domain || !id) return res.status(400).json({ error: 'Missing domain or ID' });

  const clean = domain.replace(/^https?:\/\//, '').replace(/^www\./, '');
  const url = `https://${clean}`;
  const sitemapUrl = `${url}/sitemap.xml`;

  try {
    const sitemapResponse = await axios.get(sitemapUrl);
    const sitemapData = await parseStringPromise(sitemapResponse.data);
    const urls = sitemapData.urlset.url.map(entry => entry.loc[0]).filter(link => link.startsWith(url));
    const indexData = [];
    
    for (const pageUrl of urls) {
      try {
        const pageRes = await axios.get(pageUrl);
        const $ = cheerio.load(pageRes.data);
        const title = $('title').text().trim();
        const description = $('meta[name="description"]').attr('content') || '';
        const content = $('main').text().replace(/\s+/g, ' ').trim();
        if (title || description || content) {
          indexData.push({
            url: pageUrl.replace(url, ''),
            title,
            description,
            content
          });
        }
      } catch (_) {}
      const emitter = clients.get(id);
      if (emitter) emitter.emit('update', { done: indexData.length, total: urls.length });
    }

    const filePath = getCacheFilePath(clean);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(indexData, null, 2));
    cache.set(clean, indexData);

    res.json({ message: 'Indexing completed' });
  } catch (err) {
    console.error('Manual index error:', err.message);
    res.status(500).json({ error: 'Failed to index domain' });
  }
});



module.exports = adminRouter;
