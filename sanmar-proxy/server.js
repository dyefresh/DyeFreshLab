/**
 * DyeFresh × SanMar Proxy Server
 * ================================
 * Bridges DyeFresh (Products.html + Design Lab) to SanMar's SOAP Web Services API.
 *
 * Endpoints:
 *   GET /api/images?style=PC78H&color=Athletic+Heather
 *     → { front, back, side, threeQ, frontFlat, backFlat }
 *
 *   GET /api/inventory?style=PC78H&color=Athletic+Heather
 *     → { sizes: { S: { qty, status }, M: { qty, status }, ... } }
 *
 *   GET /api/colors?style=PC78H
 *     → [ { name, catalogColor, hex, front, back, side } ... ]
 *
 *   GET /health
 *     → { ok: true }
 *
 * Deploy to Railway / Render / Fly — set env vars and go.
 */

const express = require('express');
const cors    = require('cors');
const https   = require('https');
const http    = require('http');
const xml2js  = require('xml2js');
const NodeCache = require('node-cache');

const app = express();

// ─── CONFIG ──────────────────────────────────────────────────────────────────
// Set these as environment variables in Railway / Render / Fly.
// Never commit real credentials to git.
const CONFIG = {
  customerNumber : process.env.SANMAR_CUSTOMER_NUMBER || 'YOUR_CUSTOMER_NUMBER',
  username       : process.env.SANMAR_USERNAME        || 'YOUR_USERNAME',
  password       : process.env.SANMAR_PASSWORD        || 'YOUR_PASSWORD',
  port           : process.env.PORT                   || 3000,
  // Allowed origins — add your Webflow domain and GitHub Pages URL
  allowedOrigins : (process.env.ALLOWED_ORIGINS || 'https://dyefresh.com,https://jcampos13.github.io').split(','),
};

const SANMAR_WSDL = 'https://ws.sanmar.com:8080/SanMarWebService/SanMarProductInfoServicePort';
const SANMAR_INV  = 'https://ws.sanmar.com:8080/SanMarWebService/SanMarInventoryServicePort';

// Cache responses — product data for 6 hours, inventory for 15 minutes
const productCache   = new NodeCache({ stdTTL: 6 * 60 * 60 });
const inventoryCache = new NodeCache({ stdTTL: 15 * 60 });

// ─── CORS ─────────────────────────────────────────────────────────────────────
app.use(cors({
  origin: (origin, cb) => {
    // Allow requests with no origin (server-to-server, curl) and listed domains
    if (!origin || CONFIG.allowedOrigins.some(o => origin.startsWith(o.trim()))) {
      cb(null, true);
    } else {
      cb(new Error(`CORS blocked: ${origin}`));
    }
  }
}));
app.use(express.json());

// ─── SOAP HELPER ─────────────────────────────────────────────────────────────
function soapRequest(endpoint, action, bodyXml) {
  return new Promise((resolve, reject) => {
    const envelope = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope
  xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:san="http://www.sanmar.com/webservice">
  <soapenv:Header/>
  <soapenv:Body>
    ${bodyXml}
  </soapenv:Body>
</soapenv:Envelope>`;

    const url     = new URL(endpoint);
    const options = {
      hostname : url.hostname,
      port     : url.port || 443,
      path     : url.pathname,
      method   : 'POST',
      headers  : {
        'Content-Type'   : 'text/xml;charset=UTF-8',
        'SOAPAction'     : action,
        'Content-Length' : Buffer.byteLength(envelope),
      }
    };

    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        xml2js.parseString(data, { explicitArray: false, ignoreAttrs: true }, (err, result) => {
          if (err) return reject(err);
          resolve(result);
        });
      });
    });

    req.on('error', reject);
    req.write(envelope);
    req.end();
  });
}

// ─── AUTH XML (reused in every call) ─────────────────────────────────────────
function authXml() {
  return `
    <san:sanMarCustomerNumber>${CONFIG.customerNumber}</san:sanMarCustomerNumber>
    <san:sanMarUserName>${CONFIG.username}</san:sanMarUserName>
    <san:sanMarUserPassword>${CONFIG.password}</san:sanMarUserPassword>`;
}

// ─── PARSE IMAGE RESPONSE ────────────────────────────────────────────────────
function extractImages(productInfo) {
  // SanMar returns these fields in getProductInfoByStyleColorSize response
  try {
    const pi = productInfo?.['soapenv:Envelope']?.['soapenv:Body']
      ?.getProductInfoByStyleColorSizeResponse?.return?.listOfProductInfoSwing?.productInfoSwing;

    const first = Array.isArray(pi) ? pi[0] : pi;
    if (!first) return null;

    return {
      front     : first.FRONT_MODEL_IMAGE_URL  || null,
      back      : first.BACK_MODEL_IMAGE_URL   || null,
      side      : first.SIDE_MODEL             || null,
      threeQ    : first.THREE_Q_MODEL          || null,
      frontFlat : first.FRONT_FLAT_IMAGE_URL   || null,
      backFlat  : first.BACK_FLAT_IMAGE_URL    || null,
      colorName : first.COLOR_NAME             || null,
      colorHex  : null, // SanMar doesn't provide hex — we map separately
    };
  } catch (e) {
    return null;
  }
}

// ─── PARSE INVENTORY RESPONSE ────────────────────────────────────────────────
function extractInventory(invResponse) {
  try {
    const items = invResponse?.['soapenv:Envelope']?.['soapenv:Body']
      ?.getInventoryQtyForStyleColorSizeResponse?.return?.listOfInventorySwing?.inventorySwing;

    const list = Array.isArray(items) ? items : [items];
    const sizes = {};

    list.forEach(item => {
      if (!item) return;
      const size = item.SIZE || item.size;
      const qty  = parseInt(item.QTY || item.qty || '0', 10);
      sizes[size] = {
        qty,
        status: qty === 0 ? 'out_of_stock' : qty < 12 ? 'low_stock' : 'in_stock'
      };
    });

    return { sizes };
  } catch (e) {
    return { sizes: {} };
  }
}

// ─── ROUTES ──────────────────────────────────────────────────────────────────

// Health check
app.get('/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

/**
 * GET /api/images?style=PC78H&color=Athletic+Heather&size=M
 * Returns front/back/side CDN URLs for a specific style + color.
 * Size defaults to M (we only need one size to get image URLs).
 */
app.get('/api/images', async (req, res) => {
  const { style, color, size = 'M' } = req.query;
  if (!style || !color) return res.status(400).json({ error: 'style and color are required' });

  const cacheKey = `img:${style}:${color}:${size}`.toLowerCase();
  const cached = productCache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const body = `
      <san:getProductInfoByStyleColorSize>
        ${authXml()}
        <san:style>${style}</san:style>
        <san:color>${color}</san:color>
        <san:size>${size}</san:size>
      </san:getProductInfoByStyleColorSize>`;

    const result = await soapRequest(SANMAR_WSDL, 'getProductInfoByStyleColorSize', body);
    const images = extractImages(result);

    if (!images) return res.status(404).json({ error: 'Product not found or no images available' });

    productCache.set(cacheKey, images);
    res.json(images);
  } catch (err) {
    console.error('Images error:', err.message);
    res.status(500).json({ error: 'SanMar API error', detail: err.message });
  }
});

/**
 * GET /api/inventory?style=PC78H&color=Athletic+Heather
 * Returns per-size inventory qty and status (in_stock / low_stock / out_of_stock).
 */
app.get('/api/inventory', async (req, res) => {
  const { style, color } = req.query;
  if (!style || !color) return res.status(400).json({ error: 'style and color are required' });

  const cacheKey = `inv:${style}:${color}`.toLowerCase();
  const cached = inventoryCache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const body = `
      <san:getInventoryQtyForStyleColorSize>
        ${authXml()}
        <san:style>${style}</san:style>
        <san:color>${color}</san:color>
      </san:getInventoryQtyForStyleColorSize>`;

    const result = await soapRequest(SANMAR_INV, 'getInventoryQtyForStyleColorSize', body);
    const inventory = extractInventory(result);

    inventoryCache.set(cacheKey, inventory);
    res.json(inventory);
  } catch (err) {
    console.error('Inventory error:', err.message);
    res.status(500).json({ error: 'SanMar API error', detail: err.message });
  }
});

/**
 * GET /api/colors?style=PC78H
 * Returns ALL colors for a style with their front image URLs.
 * Uses getProductBulkInfo — one call, all colors.
 * Cached for 6 hours.
 */
app.get('/api/colors', async (req, res) => {
  const { style } = req.query;
  if (!style) return res.status(400).json({ error: 'style is required' });

  const cacheKey = `colors:${style}`.toLowerCase();
  const cached = productCache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const body = `
      <san:getProductBulkInfo>
        ${authXml()}
        <san:style>${style}</san:style>
      </san:getProductBulkInfo>`;

    const result = await soapRequest(SANMAR_WSDL, 'getProductBulkInfo', body);

    // getProductBulkInfo returns one row per style/color/size combo
    // We deduplicate by color to get one entry per color
    const items = result?.['soapenv:Envelope']?.['soapenv:Body']
      ?.getProductBulkInfoResponse?.return?.listOfProductInfoSwing?.productInfoSwing;

    const list = Array.isArray(items) ? items : [items];
    const colorMap = {};

    list.forEach(item => {
      if (!item) return;
      const colorName = item.COLOR_NAME;
      if (!colorName || colorMap[colorName]) return; // deduplicate by color

      colorMap[colorName] = {
        name         : colorName,
        catalogColor : item.CATALOG_COLOR || colorName,
        front        : item.FRONT_MODEL_IMAGE_URL  || null,
        back         : item.BACK_MODEL_IMAGE_URL   || null,
        side         : item.SIDE_MODEL             || null,
        threeQ       : item.THREE_Q_MODEL          || null,
        frontFlat    : item.FRONT_FLAT_IMAGE_URL   || null,
        backFlat     : item.BACK_FLAT_IMAGE_URL    || null,
      };
    });

    const colors = Object.values(colorMap);
    productCache.set(cacheKey, colors);
    res.json(colors);
  } catch (err) {
    console.error('Colors error:', err.message);
    res.status(500).json({ error: 'SanMar API error', detail: err.message });
  }
});

/**
 * GET /api/colors-with-inventory?style=PC78H
 * Returns all colors with their images AND a summary of overall availability.
 * Useful for showing which color swatches to gray out.
 */
app.get('/api/colors-with-inventory', async (req, res) => {
  const { style } = req.query;
  if (!style) return res.status(400).json({ error: 'style is required' });

  // Fetch colors first
  const colorsRes = await fetch(`http://localhost:${CONFIG.port}/api/colors?style=${style}`);
  const colors = await colorsRes.json();

  // Fetch inventory for each color in parallel
  const withInventory = await Promise.all(
    colors.map(async color => {
      try {
        const invRes = await fetch(
          `http://localhost:${CONFIG.port}/api/inventory?style=${style}&color=${encodeURIComponent(color.catalogColor)}`
        );
        const inv = await invRes.json();

        // Summarize: is ANY size in stock?
        const sizes = inv.sizes || {};
        const anyInStock = Object.values(sizes).some(s => s.status !== 'out_of_stock');
        const anyLow     = Object.values(sizes).some(s => s.status === 'low_stock');

        return {
          ...color,
          inventory: sizes,
          availabilityStatus: anyInStock ? (anyLow ? 'low_stock' : 'in_stock') : 'out_of_stock'
        };
      } catch {
        return { ...color, inventory: {}, availabilityStatus: 'unknown' };
      }
    })
  );

  res.json(withInventory);
});

// ─── START ────────────────────────────────────────────────────────────────────
app.listen(CONFIG.port, () => {
  console.log(`\n🎨 DyeFresh × SanMar Proxy running on port ${CONFIG.port}`);
  console.log(`   Customer: ${CONFIG.customerNumber}`);
  console.log(`   Health:   http://localhost:${CONFIG.port}/health\n`);
});
