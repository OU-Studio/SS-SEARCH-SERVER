// search_api_server.js
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const Fuse = require('fuse.js');

const app = express();
const PORT = process.env.PORT || 3000;

// Allow all origins for testing
app.use(cors({ origin: '*' }));
app.use(express.json());

app.post('/api/search', async (req, res) => {
  const { query, url, exact } = req.body;
  if (!query || !url) {
    return res.status(400).json({ error: 'Missing query or index URL' });
  }

  try {
    // Fetch the search index JSON file from the Squarespace site
    const response = await axios.get(url, { timeout: 5000 });
    const index = response.data;

    // Set up Fuse.js options
    const isExact = exact === true;
    const fuse = new Fuse(index, {
      keys: ['title', 'description', 'content'],
      includeScore: true,
      includeMatches: true,
      threshold: isExact ? 0.0 : 0.4,
      ignoreLocation: !isExact,
      useExtendedSearch: isExact
    });

    const searchQuery = isExact ? `'${query}` : query;
    let results = fuse.search(searchQuery);

    // Sort to prioritize matches in title first, then description, then content
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
      } else {
        snippet = item.content.slice(0, 160) + '...';
      }

      return {
        url: item.url,
        title: item.title,
        snippet
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
