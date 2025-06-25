// adminRoutes.js
const express = require('express');
const fs = require('fs');
const path = require('path');
const { ADMIN_TOKEN } = require('./config/config');
const cheerio = require('cheerio');
const axios = require('axios');
const { parseStringPromise } = require('xml2js');

const DOMAIN_FILE = path.join(__dirname, 'data', 'allowed-domains.json');

function getCacheFilePath(domain) {
  const safe = domain.replace(/[^a-z0-9.-]/gi, '_');
  return path.join(__dirname, 'data', 'cached-indexes', `${safe}.json`);
}

function waitForClient(id, clients, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const interval = 100;
    let waited = 0;

    const check = () => {
      if (clients.has(id)) return resolve(clients.get(id));
      waited += interval;
      if (waited >= timeout) return reject(new Error('SSE client not connected'));
      setTimeout(check, interval);
    };

    check();
  });
}

module.exports = function createAdminRouter(cache, clients) {
  const adminRouter = express.Router();

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

  // Manual indexing endpoint
  adminRouter.post('/index', async (req, res) => {
    const { domain, id } = req.body;
    console.log('📥 Manual index triggered for', domain, 'ID:', id);
    console.log('🧾 Current SSE clients:', [...clients.keys()]);

    if (!domain || !id) return res.status(400).json({ error: 'Missing domain or ID' });

    const input = domain.trim().replace(/^https?:\/\//, '');
const clean = input.toLowerCase();
const url = `https://${clean}`;
const sitemapUrl = `${url}/sitemap.xml`;


    try {
      const emitter = await waitForClient(id, clients);
      console.log(`🔗 SSE client ready for ID: ${id}`);

      const sitemapResponse = await axios.get(sitemapUrl);
      const sitemapData = await parseStringPromise(sitemapResponse.data);
      const urls = sitemapData.urlset.url.map(entry => entry.loc[0]).filter(link => link.startsWith(url));
      console.log(`🔍 Sitemap returned ${urls.length} URLs for ${domain}`);
urls.forEach(u => console.log('🧭', u));
      const indexData = [];

      for (let i = 0; i < urls.length; i++) {
        const pageUrl = urls[i];
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
        } catch (err) {
  console.warn(`❌ Failed to scrape ${pageUrl}:`, err.message);
}

        emitter.emit('update', { done: i + 1, total: urls.length });
        console.log(`📡 Progress: ${i + 1}/${urls.length}`);
      }

      const filePath = getCacheFilePath(clean);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(indexData, null, 2));
      cache.set(clean, indexData);

      res.json({ message: 'Indexing completed' });
    } catch (err) {
      console.error('❌ Manual index error:', err.message);
      res.status(500).json({ error: 'Failed to index domain' });
    }
  });

  return adminRouter;
};
