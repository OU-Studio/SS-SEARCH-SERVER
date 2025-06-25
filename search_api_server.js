const express = require('express');
const app = express(); // ✅ MUST be before any app.use()
const PORT = process.env.PORT || 3000;




const verifyDomain = require('./middleware/verifyDomain');

const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const { parseStringPromise } = require('xml2js');
const Fuse = require('fuse.js');
const path = require('path');
const EventEmitter = require('events');
const fs = require('fs');
const cron = require('node-cron');


function getAllowedDomains() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'data', 'allowed-domains.json'), 'utf-8');
    return JSON.parse(raw);
  } catch (e) {
    console.error('Failed to read allowed-domains.json:', e.message);
    return [];
  }
}

function getAllowedOrigins() {
  return getAllowedDomains().flatMap(domain => [
    `https://${domain}`,
    `https://www.${domain}`
  ]);
}


// ✅ This must come after `app` is defined
app.use(cors({
  origin: function (origin, callback) {
    const allowedDomains = getAllowedDomains();

    const allowedOrigins = allowedDomains.flatMap(domain => [
      `https://${domain}`,
      `https://www.${domain}`
    ]);

    // ✅ Add admin panel domains manually:
    const adminOrigins = [
      'https://ou.studio',
      'https://www.ou.studio'
    ];

    const fullAllowList = [...allowedOrigins, ...adminOrigins];

    if (!origin || fullAllowList.includes(origin)) {
      return callback(null, true);
    }

    console.warn('❌ Blocked by CORS:', origin);
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true
}));



// ✅ Then apply other middlewares
app.use(express.json());

const cache = new Map();
const clients = new Map();





app.get('/api/lite-allowed', (req, res) => {
  const raw = req.query.domain;
  if (!raw) return res.status(400).json({ allowed: false });

  const clean = raw.replace(/^https?:\/\//, '').replace(/^www\./, '');
  const allowedLiteDomains = getAllowedDomains();
  const isAllowed = allowedLiteDomains.includes(clean);
  res.json({ allowed: isAllowed });
});




function getCacheFilePath(domain) {
  const safe = domain.replace(/[^a-z0-9.-]/gi, '_');
  return path.join(__dirname, 'data', 'cached-indexes', `${safe}.json`);
}




app.get('/api/progress/:id', (req, res) => {
  const id = req.params.id;

  console.log(`📡 SSE connection opened for ID: ${id}`);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  // 🚨 Required to immediately flush headers for Railway/Node
  res.flushHeaders?.();

  // ✅ Keep-alive ping every 15s to avoid idle disconnects
  const keepAlive = setInterval(() => {
    res.write(`: ping\n\n`);
  }, 15000);

  // ✅ Store emitter in global map
  const emitter = new EventEmitter();
  clients.set(id, emitter);

  emitter.on('update', (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    console.log(`📤 Sent update to ${id}: ${JSON.stringify(data)}`);
  });

  req.on('close', () => {
    clearInterval(keepAlive);
    clients.delete(id);
    console.log(`❌ SSE connection closed for ID: ${id}`);
  });
});


const createAdminRouter = require('./adminRoutes');
app.use('/admin', createAdminRouter(cache, clients));

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
  let { query, domain } = req.body;
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
    console.log('🔍 Clean domain:', cleanDomain);
console.log('📂 Looking for cached file at:', filePath);
console.log('📦 Folder contents:', fs.readdirSync(path.join(__dirname, 'data', 'cached-indexes')));
console.log('📄 File exists:', fs.existsSync(filePath));

    if (fs.existsSync(filePath)) {
      console.log('✅ Loading cached index from file');
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      cache.set(cleanDomain, data);
      return searchInIndex(data, query);
    }

    // 🚫 No automatic indexing anymore
    console.log(`🟡 Index not found for ${cleanDomain} – manual indexing required.`);
    return res.status(404).json({ error: 'No index found. Please run manual indexing.' });

  } catch (err) {
    console.error('Lite search error:', err.message);
    res.status(500).json({ error: 'Lite search failed' });
  }
});


// Daily crawl at 3am
cron.schedule('0 23 * * *', async () => {
  console.log('🕒 Starting daily crawl at 3am');
  const allowedDomains = getAllowedDomains();

  for (const domain of allowedDomains) {
    try {
      const cleanDomain = domain.replace(/^https?:\/\//, '');
      const url = `https://${cleanDomain}`;
      const sitemapUrl = `${url}/sitemap.xml`;
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
        } catch (err) {
          console.warn(`❌ Failed to scrape ${pageUrl}:`, err.message);
        }
      }

      cache.set(cleanDomain, indexData);
      const filePath = getCacheFilePath(cleanDomain);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(indexData, null, 2));
      console.log(`✅ Daily crawl completed and cached for ${cleanDomain}`);
    } catch (err) {
      console.error(`❌ Error crawling ${domain}:`, err.message);
    }
  }
});


app.listen(PORT, () => {
  console.log(`✅ Search API listening on port ${PORT}`);
});
