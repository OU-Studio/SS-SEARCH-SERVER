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

const clients = new Map(); // track SSE clients by ID

// SSE progress route
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




// Search endpoint
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

        const score =
          matchTitle ? 0 :
          matchDescription ? 1 :
          matchContent ? 2 : 3;

        if (score === 3) return null;

        return { item, score };
      })
      .filter(Boolean)
      .sort((a, b) => a.score - b.score);

    results.sort((a, b) => {
      const getPriority = matchArray => {
        if (!matchArray) return 3;
        if (matchArray.some(m => m.key === 'title')) return 0;
        if (matchArray.some(m => m.key === 'description')) return 1;
        if (matchArray.some(m => m.key === 'content')) return 2;
        return 3;
      };
      return getPriority(a.matches) - getPriority(b.matches);
    });

    const finalResults = results.slice(0, 10).map(result => {
      const item = result.item;
      const loweredQuery = query.toLowerCase();
      let title = item.title;
      let snippet = '';

      // Highlight in title
      const titleLower = title.toLowerCase();
      const titleIndex = titleLower.indexOf(loweredQuery);
      if (titleIndex !== -1) {
        const before = title.slice(0, titleIndex);
        const match = title.slice(titleIndex, titleIndex + query.length);
        const after = title.slice(titleIndex + query.length);
        title = `${before}<mark>${match}</mark>${after}`;
      }

      // Highlight in content
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

      // Detect type
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

app.post('/api/generate-index', async (req, res) => {
  const { domain, id } = req.body;
  if (!domain || !domain.startsWith('http') || !id) {
    return res.status(400).json({ error: 'Invalid request' });
  }

  try {
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

    cache.set(domain, indexData);
    const filePath = getCacheFilePath(domain);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(indexData, null, 2));

    res.json({ pages: indexData });
  } catch (err) {
    console.error('Error:', err.message);
    res.status(500).json({ error: 'Failed to generate index' });
  }
});

app.post('/api/search-lite', async (req, res) => {
  const { query, domain } = req.body;
  if (!query || !domain || !domain.startsWith('http')) {
    return res.status(400).json({ error: 'Missing query or invalid domain' });
  }

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
    if (cache.has(domain)) {
      console.log('✅ Using cached memory index');
      return searchInIndex(cache.get(domain), query);
    }

    const filePath = getCacheFilePath(domain);
    if (fs.existsSync(filePath)) {
      console.log('✅ Loading cached index from file');
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      cache.set(domain, data);
      return searchInIndex(data, query);
    }

    res.status(404).json({ error: 'No index found for domain. Please generate it first.' });
  } catch (err) {
    console.error('Lite search error:', err.message);
    res.status(500).json({ error: 'Lite search failed' });
  }
});


app.listen(PORT, () => {
  console.log(`✅ Search API listening on port ${PORT}`);
});
