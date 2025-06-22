// search_api_server.js
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const Fuse = require('fuse.js');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
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
    const results = fuse.search(searchQuery).slice(0, 10).map(result => {
      const item = result.item;
      let snippet = item.content.slice(0, 160) + '...';

      if (result.matches) {
        result.matches.forEach(match => {
          const value = match.value;
          match.indices.forEach(([start, end]) => {
            const matchedText = value.slice(start, end + 1);
            const highlighted = `<mark>${matchedText}</mark>`;
            snippet = snippet.replace(matchedText, highlighted);
          });
        });
      }

      return {
        url: item.url,
        title: item.title,
        snippet
      };
    });

    res.json({ results });
  } catch (error) {
    console.error('Search error:', error.message);
    res.status(500).json({ error: 'Failed to fetch or search index' });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Search API listening on port ${PORT}`);
});
