// search_api_server.js
const verifyDomain = require('./middleware/verifyDomain');

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const { parseStringPromise } = require('xml2js');
const Fuse = require('fuse.js');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Allow all origins for testing
app.use(cors({ origin: '*' }));
app.use(express.json());

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

// Generate index endpoint
app.post('/api/generate-index', async (req, res) => {
  const { domain } = req.body;
  if (!domain || !domain.startsWith('http')) {
    return res.status(400).json({ error: 'Invalid or missing domain (must include https://)' });
  }

  try {
    const sitemapUrl = domain + '/sitemap.xml';
    const sitemapResponse = await axios.get(sitemapUrl);
    const sitemapData = await parseStringPromise(sitemapResponse.data);

    const urls = sitemapData.urlset.url.map(entry => entry.loc[0]).filter(url => url.startsWith(domain));

    const indexData = [];

    for (const url of urls) {
      try {
        const pageRes = await axios.get(url);
        const $ = cheerio.load(pageRes.data);

        const title = $('title').text().trim();
        const description = $('meta[name="description"]').attr('content') || '';
        const content = $('main').text().replace(/\s+/g, ' ').trim();

        indexData.push({
          url: url.replace(domain, ''),
          title,
          description,
          content
        });
      } catch (pageErr) {
        console.warn('Failed to parse page:', url);
      }
    }

    res.setHeader('Content-Disposition', 'attachment; filename="site-index.json"');
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify(indexData, null, 2));
  } catch (err) {
    console.error('Error generating index:', err.message);
    res.status(500).json({ error: 'Failed to generate index' });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Search API listening on port ${PORT}`);
});
