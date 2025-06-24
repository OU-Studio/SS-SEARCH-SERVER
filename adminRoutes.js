// api to update allowed-domains.json
const express = require('express');
const fs = require('fs');
const path = require('path');
const { ADMIN_TOKEN } = require('./config');

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

module.exports = adminRouter;
