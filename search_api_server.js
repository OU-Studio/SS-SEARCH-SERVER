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
  const { query, url } = req.body;
  if (!query || !url) {
    return res.status(400).json({ error: 'Missing query or index URL' });
  }

  try {
    // Fetch the search index JSON file from the Squarespace site
    const response = await axios.get(url, { timeout: 5000 });
    const index = response.data;

    // Set up Fuse.js options
    const fuse = new Fuse(index, {
      keys: ['title', 'description', 'content'],
      includeScore: true,
      threshold: 0.4,
      minMatchCharLength: 2
    });

    // Run search
    const results = fuse.search(query).slice(0, 10).map(result => ({
      url: result.item.url,
      title: result.item.title,
      snippet: result.item.content.slice(0, 160) + '...'
    }));

    res.json({ results });
  } catch (error) {
    console.error('Search error:', error.message);
    res.status(500).json({ error: 'Failed to fetch or search index' });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Search API listening on port ${PORT}`);
});
