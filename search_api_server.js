// search_api_server.js
const verifyDomain = require('./middleware/verifyDomain');

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const { parseStringPromise } = require('xml2js');
const Fuse = require('fuse.js');
const path = require('path');
const EventEmitter = require('events');
const fs = require('fs');

const allowedLiteDomains = require('./config/allowedSites');

const allowedOrigins = allowedLiteDomains.flatMap(domain => [
  `https://${domain}`,
  `https://www.${domain}`
]);

app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error('Not allowed by CORS'));
  }
}));


app.get('/api/lite-allowed', (req, res) => {
  const raw = req.query.domain;
  if (!raw) return res.status(400).json({ allowed: false });

  const clean = raw.replace(/^https?:\/\//, '').replace(/^www\./, '');
  const isAllowed = allowedLiteDomains.includes(clean);
  res.json({ allowed: isAllowed });
});

const cache = new Map();

function getCacheFilePath(domain) {
  const safe = domain.replace(/[^a-z0-9.-]/gi, '_');
  return path.join(__dirname, 'cached-indexes', `${safe}.json`);
}

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const clients = new Map();

app.get('/api/progress/:id', (req, res) => {
  const id = req.params.id;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const emitter = new EventEmitter();
  clients.set(id, emitter);

  emitter.on('update', (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  });

  req.on('close', () => {
    clients.delete(id);
  });
});

app.post('/api/search', verifyDomain, async (req, res) => {
  const { query, url } = req.body;
  if (!query || !url) {
    return res.status(400).json({ error: 'Missing query or index URL' });
  }

  try {
    const response = await axios.get(url, { timeout: 5000 });
    const index = response.data;

    const loweredQuery = query.toLowerCase();

    let results = index
      .map(item => {
        const matchTitle = item.title.toLowerCase().includes(loweredQuery);
        const matchDescription = item.description.toLowerCase().includes(loweredQuery);
        const matchContent = item.content.toLowerCase().includes(loweredQuery);

        const score = matchTitle ? 0 : matchDescription ? 1 : matchContent ? 2 : 3;
        if (score === 3) return null;
        return { item, score };
      })
      .filter(Boolean)
      .sort((a, b) => a.score - b.score);

    const finalResults = results.slice(0, 10).map(result => {
      const item = result.item;
      let title = item.title;
      let snippet = '';

      const titleLower = title.toLowerCase();
      const titleIndex = titleLower.indexOf(loweredQuery);
      if (titleIndex !== -1) {
        const before = title.slice(0, titleIndex);
        const match = title.slice(titleIndex, titleIndex + query.length);
        const after = title.slice(titleIndex + query.length);
        title = `${before}<mark>${match}</mark>${after}`;
      }

      const contentLower = item.content.toLowerCase();
      const contentIndex = contentLower.indexOf(loweredQuery);
      if (contentIndex !== -1) {
        const contextBefore = Math.max(contentIndex - 40, 0);
        const contextAfter = Math.min(contentIndex + query.length + 40, item.content.length);
        let excerpt = item.content.slice(contextBefore, contextAfter);
        const match = item.content.slice(contentIndex, contentIndex + query.length);
        excerpt = excerpt.replace(match, `<mark>${match}</mark>`);
        snippet = (contextBefore > 0 ? '...' : '') + excerpt + (contextAfter < item.content.length ? '...' : '');
      } else {
        snippet = item.content.slice(0, 160) + '...';
      }

      let type = 'other';
      if (item.url.includes('/blog/')) type = 'blog';
      else if (item.url.includes('/product/')) type = 'product';
      else if (item.url.includes('/pages/') || item.url.includes('/page/')) type = 'page';

      return {
        url: item.url,
        title,
        snippet,
        type
      };
    });

    res.json({ results: finalResults });
  } catch (error) {
    console.error('Search error:', error.message);
    res.status(500).json({ error: 'Failed to fetch or search index' });
  }
});

app.post('/api/search-lite', async (req, res) => {
  let { query, domain, id } = req.body;
  if (!domain) return res.status(400).json({ error: 'Missing domain' });
  if (!domain.startsWith('http')) domain = 'https://' + domain;
  if (!query) return res.status(400).json({ error: 'Missing query' });

  const cleanDomain = domain.replace(/^https?:\/\//, '');

  function searchInIndex(index, q) {
    const loweredQuery = q.toLowerCase();
    const results = index
      .map(item => {
        const matchTitle = item.title.toLowerCase().includes(loweredQuery);
        const matchDescription = item.description.toLowerCase().includes(loweredQuery);
        const matchContent = item.content.toLowerCase().includes(loweredQuery);
        const score = matchTitle ? 0 : matchDescription ? 1 : matchContent ? 2 : 3;
        if (score === 3) return null;
        return { item, score };
      })
      .filter(Boolean)
      .sort((a, b) => a.score - b.score)
      .slice(0, 10)
      .map(({ item }) => ({
        url: item.url,
        title: item.title,
        snippet: item.content.slice(0, 160) + '...',
        type: item.url.includes('/blog/') ? 'blog' : item.url.includes('/product/') ? 'product' : 'page'
      }));
    res.json({ results });
  }

  try {
    if (cache.has(cleanDomain)) {
      console.log('✅ Using cached memory index');
      return searchInIndex(cache.get(cleanDomain), query);
    }

    const filePath = getCacheFilePath(cleanDomain);
    if (fs.existsSync(filePath)) {
      console.log('✅ Loading cached index from file');
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      cache.set(cleanDomain, data);
      return searchInIndex(data, query);
    }

    // If no index, begin background generation
    if (!id) return res.status(404).json({ error: 'No index found and no ID for generation.' });
    console.log(`📥 No cache found for ${cleanDomain}. Triggering fresh scrape.`);

    const sitemapUrl = domain + '/sitemap.xml';
    const sitemapResponse = await axios.get(sitemapUrl);
    const sitemapData = await parseStringPromise(sitemapResponse.data);

    const urls = sitemapData.urlset.url.map(entry => entry.loc[0]).filter(url => url.startsWith(domain));
    const total = urls.length;
    let done = 0;
    const indexData = [];

    for (const url of urls) {
      try {
        const pageRes = await axios.get(url);
        const $ = cheerio.load(pageRes.data);
        const title = $('title').text().trim();
        const description = $('meta[name="description"]').attr('content') || '';
        const content = $('main').text().replace(/\s+/g, ' ').trim();
        if (title || description || content) {
          indexData.push({ url: url.replace(domain, ''), title, description, content });
        }
      } catch (_) {}
      done++;
      const emitter = clients.get(id);
      if (emitter) emitter.emit('update', { done, total });
    }

    cache.set(cleanDomain, indexData);
    const filePathSave = getCacheFilePath(cleanDomain);
    fs.mkdirSync(path.dirname(filePathSave), { recursive: true });
    fs.writeFileSync(filePathSave, JSON.stringify(indexData, null, 2));
    console.log(`✅ Fresh cache built and saved for ${cleanDomain}`);

    return searchInIndex(indexData, query);
  } catch (err) {
    console.error('Lite search error:', err.message);
    res.status(500).json({ error: 'Lite search failed' });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Search API listening on port ${PORT}`);
});
