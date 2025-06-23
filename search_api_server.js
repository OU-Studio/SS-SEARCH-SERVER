// search_api_server.js
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const Fuse = require('fuse.js');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Allow all origins for testing
app.use(cors({ origin: '*' }));
app.use(express.json());

app.post('/api/search', async (req, res) => {
  const { query, url } = req.body;
  if (!query || !url) {
    return res.status(400).json({ error: 'Missing query or index URL' });
  }

  try {
    const response = await axios.get(url, { timeout: 5000 });
    const index = response.data;

    const fuse = new Fuse(index, {
      keys: ['title', 'description', 'content'],
      includeScore: true,
      includeMatches: true,
      threshold: 0.0, // Require exact order of characters
      ignoreLocation: true,
      useExtendedSearch: true
    });

    const searchQuery = query.toLowerCase();
    let results = fuse.search(`=${searchQuery}`); // Force exact token match but still ignore case

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
      let snippet = '';
      let title = item.title;

      if (result.matches) {
        const contentMatch = result.matches.find(m => m.key === 'content');
        if (contentMatch && contentMatch.indices.length > 0) {
          const [start, end] = contentMatch.indices[0];
          const contextBefore = Math.max(start - 40, 0);
          const contextAfter = Math.min(end + 40, item.content.length);
          let excerpt = item.content.slice(contextBefore, contextAfter);

          contentMatch.indices.forEach(([s, e]) => {
            const matchedText = item.content.slice(s, e + 1);
            excerpt = excerpt.replace(matchedText, `<mark>${matchedText}</mark>`);
          });

          snippet = (contextBefore > 0 ? '...' : '') + excerpt + (contextAfter < item.content.length ? '...' : '');
        } else {
          snippet = item.content.slice(0, 160) + '...';
        }

        const titleMatch = result.matches.find(m => m.key === 'title');
        if (titleMatch && titleMatch.indices.length > 0) {
          let highlighted = '';
          let lastIndex = 0;
          titleMatch.indices.forEach(([start, end]) => {
            highlighted += title.slice(lastIndex, start);
            highlighted += `<mark>${title.slice(start, end + 1)}</mark>`;
            lastIndex = end + 1;
          });
          highlighted += title.slice(lastIndex);
          title = highlighted;
        }
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

app.listen(PORT, () => {
  console.log(`✅ Search API listening on port ${PORT}`);
});
