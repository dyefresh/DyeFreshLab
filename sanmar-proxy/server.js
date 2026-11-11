/**
 * DyeFresh × SanMar Proxy Server
 * ================================
 * Bridges DyeFresh (Products.html + Design Lab) to SanMar's SOAP Web Services API.
 *
 * API structure confirmed from WSDL + XSD at:
 *   https://ws.sanmar.com:8080/SanMarWebService/SanMarProductInfoServicePort?wsdl
 *   https://ws.sanmar.com:8080/SanMarWebService/SanMarProductInfoServicePort?xsd=1
 *
 * Key facts:
 *   - Namespace: http://impl.webservice.integration.sanmar.com/
 *   - Style: document/literal (arg0/arg1 wrappers, not flat fields)
 *   - SOAPAction: "" (empty string)
 *   - getProductBulkInfo: takes only arg0 (webServiceUser) — returns ALL products
 *   - getProductInfoByStyleColorSize: takes arg0[] (product) + arg1 (webServiceUser)
 *   - Response: return.listResponse[] with productBasicInfo, productImageInfo, productPriceInfo
 *
 * Endpoints:
 *   GET /api/images?style=PC78H&color=Athletic+Heather&size=M
 *   GET /api/inventory?style=PC78H&color=Athletic+Heather
 *   GET /api/colors?style=PC78H
 *   GET /api/img-proxy?url=https://cdnp.sanmar.com/...
 *   GET /health
 */

const express   = require('express');
const cors      = require('cors');
const https     = require('https');
const http      = require('http');
const xml2js    = require('xml2js');
const NodeCache = require('node-cache');

const app = express();

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const CONFIG = {
  customerNumber : process.env.SANMAR_CUSTOMER_NUMBER || 'YOUR_CUSTOMER_NUMBER',
  username       : process.env.SANMAR_USERNAME        || 'YOUR_USERNAME',
  password       : process.env.SANMAR_PASSWORD        || 'YOUR_PASSWORD',
  port           : process.env.PORT                   || 3000,
  allowedOrigins : (process.env.ALLOWED_ORIGINS || 'https://dyefresh.com,https://jcampos13.github.io,https://dyefresh.github.io').split(','),
};

// SanMar SOAP endpoints — HTTPS port 8080 (confirmed from WSDL)
const SANMAR_WSDL = 'https://ws.sanmar.com:8080/SanMarWebService/SanMarProductInfoServicePort';
const SANMAR_INV  = 'https://ws.sanmar.com:8080/SanMarWebService/SanMarWebServicePort';

// Cache: product data 6h, inventory 15min
const productCache   = new NodeCache({ stdTTL: 6 * 60 * 60 });
const inventoryCache = new NodeCache({ stdTTL: 15 * 60 });

// ─── CORS ─────────────────────────────────────────────────────────────────────
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || CONFIG.allowedOrigins.some(o => origin.startsWith(o.trim()))) {
      cb(null, true);
    } else {
      cb(new Error(`CORS blocked: ${origin}`));
    }
  }
}));
app.use(express.json());

// ─── SOAP HELPER ─────────────────────────────────────────────────────────────
// SOAPAction must be empty string per WSDL binding definition
function soapRequest(endpoint, bodyXml) {
  return new Promise((resolve, reject) => {
    const envelope = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope
  xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:tns="http://impl.webservice.integration.sanmar.com/">
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
        'SOAPAction'     : '""',
        'Content-Length' : Buffer.byteLength(envelope),
      }
    };

    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        xml2js.parseString(data, { explicitArray: false, ignoreAttrs: true }, (err, result) => {
          if (err) return reject(new Error('XML parse error: ' + err.message));
          // Check for SOAP fault
          const body = soapBody(result);
          const fault = body?.['S:Fault'] || body?.['soapenv:Fault'] || body?.Fault;
          if (fault) {
            const msg = fault.faultstring || fault.faultcode || JSON.stringify(fault);
            return reject(new Error('SOAP Fault: ' + msg));
          }
          resolve(result);
        });
      });
    });

    req.setTimeout(25000, () => {
      req.destroy(new Error('SanMar SOAP request timed out after 25s'));
    });

    req.on('error', reject);
    req.write(envelope);
    req.end();
  });
}

// ─── SOAP ENVELOPE HELPER ────────────────────────────────────────────────────
function soapBody(result) {
  const env = result?.['S:Envelope'] || result?.['soapenv:Envelope'] || result?.['SOAP-ENV:Envelope'] || result;
  return env?.['S:Body'] || env?.['soapenv:Body'] || env?.['SOAP-ENV:Body'] || env;
}

// ─── AUTH XML (arg0 = webServiceUser per XSD) ────────────────────────────────
// XSD: webServiceUser has sanMarCustomerNumber, sanMarUserName, sanMarUserPassword
function authArg(argName = 'arg0') {
  return `
    <tns:${argName}>
      <tns:sanMarCustomerNumber>${CONFIG.customerNumber}</tns:sanMarCustomerNumber>
      <tns:sanMarUserName>${CONFIG.username}</tns:sanMarUserName>
      <tns:sanMarUserPassword>${CONFIG.password}</tns:sanMarUserPassword>
    </tns:${argName}>`;
}

// ─── RESPONSE PARSERS ────────────────────────────────────────────────────────
// XSD: getProductInfoByStyleColorSizeResponse.return = productInfoResponseBean
//      productInfoResponseBean.listResponse[] = productInfo
//      productInfo.productImageInfo, productInfo.productBasicInfo
function extractFromResponse(result) {
  const body = soapBody(result);
  // Try both response element names
  const resp = body?.getProductInfoByStyleColorSizeResponse
            || body?.getProductBulkInfoResponse
            || body?.getProductInfoByBrandResponse;
  if (!resp) return null;

  const ret = resp?.return;
  if (!ret) return null;

  // listResponse is the array of productInfo objects
  const items = ret.listResponse;
  return Array.isArray(items) ? items : (items ? [items] : []);
}

function mapProductToImages(item) {
  const img = item?.productImageInfo || {};
  const info = item?.productBasicInfo || {};
  return {
    front        : img.frontModel         || null,
    back         : img.backModel          || null,
    side         : img.sideModel          || null,
    threeQ       : img.threeQModel        || null,
    frontFlat    : img.frontFlat          || null,
    backFlat     : img.backFlat           || null,
    colorName    : info.color             || null,
    catalogColor : info.catalogColor      || null,
    colorSwatch  : img.colorSquareImage   || img.colorSwatchImage || null,
  };
}

function extractInventory(invResponse) {
  try {
    const body = soapBody(invResponse);
    const items = body?.getInventoryQtyForStyleColorSizeResponse?.return?.listOfInventorySwing?.inventorySwing;
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

app.get('/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

/**
 * GET /api/images?style=PC78H&color=Athletic+Heather&size=M
 * XSD: getProductInfoByStyleColorSize takes arg0[](product) + arg1(webServiceUser)
 * product: { color, size, style }
 */
app.get('/api/images', async (req, res) => {
  const { style, color, size = 'M' } = req.query;
  if (!style || !color) return res.status(400).json({ error: 'style and color are required' });

  const cacheKey = `img:${style}:${color}:${size}`.toLowerCase();
  const cached = productCache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const body = `
      <tns:getProductInfoByStyleColorSize>
        <tns:arg0>
          <tns:color>${color}</tns:color>
          <tns:size>${size}</tns:size>
          <tns:style>${style}</tns:style>
        </tns:arg0>
        ${authArg('arg1')}
      </tns:getProductInfoByStyleColorSize>`;

    const result = await soapRequest(SANMAR_WSDL, body);
    const items = extractFromResponse(result);
    if (!items || items.length === 0) return res.status(404).json({ error: 'Product not found' });

    const images = mapProductToImages(items[0]);
    productCache.set(cacheKey, images);
    res.json(images);
  } catch (err) {
    console.error('Images error:', err.message);
    res.status(500).json({ error: 'SanMar API error', detail: err.message });
  }
});

/**
 * GET /api/inventory?style=PC78H&color=Athletic+Heather
 */
app.get('/api/inventory', async (req, res) => {
  const { style, color } = req.query;
  if (!style || !color) return res.status(400).json({ error: 'style and color are required' });

  const cacheKey = `inv:${style}:${color}`.toLowerCase();
  const cached = inventoryCache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const body = `
      <tns:getInventoryQtyForStyleColorSize>
        ${authArg('arg0')}
        <tns:style>${style}</tns:style>
        <tns:color>${color}</tns:color>
      </tns:getInventoryQtyForStyleColorSize>`;

    const result = await soapRequest(SANMAR_INV, body);
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
 * Uses getProductInfoByStyleColorSize with just style (all colors, size M).
 * getProductBulkInfo returns ALL products (no style filter) so we avoid it.
 * Instead we request each known size to get all colors — or use a known color
 * wildcard. Actually we use getProductInfoByStyleColorSize with empty color to
 * get all colors for a style. SanMar returns all matching rows.
 */
app.get('/api/colors', async (req, res) => {
  const { style } = req.query;
  if (!style) return res.status(400).json({ error: 'style is required' });

  const cacheKey = `colors:${style}`.toLowerCase();
  const cached = productCache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    // Request style with empty color/size to get all colors
    const body = `
      <tns:getProductInfoByStyleColorSize>
        <tns:arg0>
          <tns:color></tns:color>
          <tns:size></tns:size>
          <tns:style>${style}</tns:style>
        </tns:arg0>
        ${authArg('arg1')}
      </tns:getProductInfoByStyleColorSize>`;

    const result = await soapRequest(SANMAR_WSDL, body);
    const items = extractFromResponse(result);

    if (!items || items.length === 0) {
      return res.status(404).json({ error: 'No products found for style ' + style });
    }

    // Deduplicate by color
    const colorMap = {};
    items.forEach(item => {
      const info = item?.productBasicInfo || {};
      const img  = item?.productImageInfo || {};
      const colorName = info.color || info.catalogColor;
      if (!colorName || colorMap[colorName]) return;
      colorMap[colorName] = {
        name         : colorName,
        catalogColor : info.catalogColor || colorName,
        front        : img.frontModel      || null,
        back         : img.backModel       || null,
        side         : img.sideModel       || null,
        threeQ       : img.threeQModel     || null,
        frontFlat    : img.frontFlat       || null,
        backFlat     : img.backFlat        || null,
        colorSwatch  : img.colorSquareImage || img.colorSwatchImage || null,
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
 */
app.get('/api/colors-with-inventory', async (req, res) => {
  const { style } = req.query;
  if (!style) return res.status(400).json({ error: 'style is required' });

  try {
    const colorCacheKey = `colors:${style}`.toLowerCase();
    let colors = productCache.get(colorCacheKey);
    if (!colors) {
      const body = `
        <tns:getProductInfoByStyleColorSize>
          <tns:arg0>
            <tns:color></tns:color>
            <tns:size></tns:size>
            <tns:style>${style}</tns:style>
          </tns:arg0>
          ${authArg('arg1')}
        </tns:getProductInfoByStyleColorSize>`;
      const result = await soapRequest(SANMAR_WSDL, body);
      const items = extractFromResponse(result) || [];
      const colorMap = {};
      items.forEach(item => {
        const info = item?.productBasicInfo || {};
        const img  = item?.productImageInfo || {};
        const colorName = info.color || info.catalogColor;
        if (!colorName || colorMap[colorName]) return;
        colorMap[colorName] = {
          name: colorName, catalogColor: info.catalogColor || colorName,
          front: img.frontModel || null, back: img.backModel || null,
          side: img.sideModel || null, frontFlat: img.frontFlat || null,
          backFlat: img.backFlat || null, colorSwatch: img.colorSquareImage || null,
        };
      });
      colors = Object.values(colorMap);
      productCache.set(colorCacheKey, colors);
    }

    const withInventory = await Promise.all(
      colors.map(async color => {
        try {
          const invCacheKey = `inv:${style}:${color.catalogColor}`.toLowerCase();
          let inv = inventoryCache.get(invCacheKey);
          if (!inv) {
            const body = `
              <tns:getInventoryQtyForStyleColorSize>
                ${authArg('arg0')}
                <tns:style>${style}</tns:style>
                <tns:color>${color.catalogColor}</tns:color>
              </tns:getInventoryQtyForStyleColorSize>`;
            const result = await soapRequest(SANMAR_INV, body);
            inv = extractInventory(result);
            inventoryCache.set(invCacheKey, inv);
          }
          const sizes = inv.sizes || {};
          const anyInStock = Object.values(sizes).some(s => s.status !== 'out_of_stock');
          const anyLow     = Object.values(sizes).some(s => s.status === 'low_stock');
          return { ...color, inventory: sizes, availabilityStatus: anyInStock ? (anyLow ? 'low_stock' : 'in_stock') : 'out_of_stock' };
        } catch {
          return { ...color, inventory: {}, availabilityStatus: 'unknown' };
        }
      })
    );

    res.json(withInventory);
  } catch (err) {
    console.error('colors-with-inventory error:', err.message);
    res.status(500).json({ error: 'SanMar API error', detail: err.message });
  }
});

/**
 * GET /api/img-proxy?url=https://cdnp.sanmar.com/...
 */
const ALLOWED_IMG_HOSTS = ['cdnp.sanmar.com', 'cdn.sanmar.com', 'www.sanmar.com', 'sanmar.com'];
const imgCache = new NodeCache({ stdTTL: 6 * 60 * 60, useClones: false });

app.get('/api/img-proxy', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url is required' });

  let parsed;
  try { parsed = new URL(url); } catch { return res.status(400).json({ error: 'invalid url' }); }
  if (!ALLOWED_IMG_HOSTS.some(h => parsed.hostname === h || parsed.hostname.endsWith('.' + h))) {
    return res.status(403).json({ error: 'domain not allowed' });
  }

  const cached = imgCache.get(url);
  if (cached) {
    res.set('Content-Type', cached.contentType);
    res.set('Cache-Control', 'public, max-age=21600');
    res.set('Access-Control-Allow-Origin', '*');
    return res.send(cached.data);
  }

  try {
    const chunks = [];
    const fetchUrl = (targetUrl, redirectCount = 0) => new Promise((resolve, reject) => {
      if (redirectCount > 5) return reject(new Error('Too many redirects'));
      const u = new URL(targetUrl);
      const mod = u.protocol === 'https:' ? https : http;
      const opts = { hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search, method: 'GET', headers: { 'User-Agent': 'Mozilla/5.0' } };
      const r = mod.request(opts, imgRes => {
        if (imgRes.statusCode >= 300 && imgRes.statusCode < 400 && imgRes.headers.location) {
          return resolve(fetchUrl(imgRes.headers.location, redirectCount + 1));
        }
        resolve(imgRes);
      });
      r.on('error', reject);
      r.end();
    });

    const imgRes = await fetchUrl(url);
    const contentType = imgRes.headers['content-type'] || 'image/jpeg';
    if (!contentType.startsWith('image/')) return res.status(400).json({ error: 'not an image' });

    await new Promise((resolve, reject) => {
      imgRes.on('data', chunk => chunks.push(chunk));
      imgRes.on('end', resolve);
      imgRes.on('error', reject);
    });

    const data = Buffer.concat(chunks);
    imgCache.set(url, { data, contentType });
    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'public, max-age=21600');
    res.set('Access-Control-Allow-Origin', '*');
    res.send(data);
  } catch (err) {
    console.error('img-proxy error:', err.message);
    res.status(502).json({ error: 'Failed to fetch image', detail: err.message });
  }
});

/**
 * GET /api/debug?style=PC54 — raw response inspection
 */
app.get('/api/debug', async (req, res) => {
  const { style = 'PC54' } = req.query;
  try {
    const body = `
      <tns:getProductInfoByStyleColorSize>
        <tns:arg0>
          <tns:color></tns:color>
          <tns:size>M</tns:size>
          <tns:style>${style}</tns:style>
        </tns:arg0>
        ${authArg('arg1')}
      </tns:getProductInfoByStyleColorSize>`;
    const result = await soapRequest(SANMAR_WSDL, body);
    const bodyObj = soapBody(result);
    const keys = Object.keys(bodyObj || {});
    const firstKey = keys[0];
    const response = bodyObj?.[firstKey];
    const retObj = response?.return || response;
    res.json({
      envKeys: Object.keys(result || {}),
      bodyKeys: keys,
      responseKey: firstKey,
      returnKeys: Object.keys(retObj || {}).slice(0, 20),
      listResponseLength: Array.isArray(retObj?.listResponse) ? retObj.listResponse.length : (retObj?.listResponse ? 1 : 0),
      sample: JSON.stringify(retObj?.listResponse?.[0] || retObj).substring(0, 2000)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── START ────────────────────────────────────────────────────────────────────
app.listen(CONFIG.port, () => {
  console.log(`\n🎨 DyeFresh × SanMar Proxy running on port ${CONFIG.port}`);
  console.log(`   Customer: ${CONFIG.customerNumber}`);
  console.log(`   Health:   http://localhost:${CONFIG.port}/health\n`);
});
