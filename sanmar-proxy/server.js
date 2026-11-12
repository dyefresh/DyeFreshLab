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
// Namespace for inventory service (different from product info service!)
const INV_NS = 'http://webservice.integration.sanmar.com/';

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
function soapRequest(endpoint, bodyXml, tnsNamespace = 'http://impl.webservice.integration.sanmar.com/') {
  return new Promise((resolve, reject) => {
    const envelope = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope
  xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:tns="${tnsNamespace}">
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
  return env?.['S:Body'] || env?.['soapenv:Body'] || env?.['SOAP-ENV:Body'] || env?.Body || env;
}

// ─── AUTH XML (arg0 = webServiceUser per XSD) ────────────────────────────────
// document/literal: top-level op uses tns: prefix, inner complex-type elements are unqualified
function authArg(argName = 'arg0') {
  return `
    <${argName}>
      <sanMarCustomerNumber>${CONFIG.customerNumber}</sanMarCustomerNumber>
      <sanMarUserName>${CONFIG.username}</sanMarUserName>
      <sanMarUserPassword>${CONFIG.password}</sanMarUserPassword>
    </${argName}>`;
}

// ─── RESPONSE PARSERS ────────────────────────────────────────────────────────
// XSD: getProductInfoByStyleColorSizeResponse.return = productInfoResponseBean
//      productInfoResponseBean.listResponse[] = productInfo
//      productInfo.productImageInfo, productInfo.productBasicInfo
function extractFromResponse(result) {
  const body = soapBody(result);
  // Try both response element names (with and without ns2: prefix)
  const resp = body?.getProductInfoByStyleColorSizeResponse
            || body?.['ns2:getProductInfoByStyleColorSizeResponse']
            || body?.getProductBulkInfoResponse
            || body?.['ns2:getProductBulkInfoResponse']
            || body?.getProductInfoByBrandResponse
            || body?.['ns2:getProductInfoByBrandResponse'];
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

/**
 * Parse inventory response from getInventoryQtyForStyleColorSize (style-only query).
 * When called with style+color only (no size), SanMar returns a <response xsi:type="ns2:Inventory">
 * containing <skus><sku> entries each with <color>, <size>, <whse> blocks.
 * We sum all warehouse quantities per size.
 *
 * Also handles style+color+size response which returns flat <listResponse> integers (one per warehouse).
 */
function extractInventory(invResponse, targetColor) {
  try {
    const body = soapBody(invResponse);
    const resp = body?.getInventoryQtyForStyleColorSizeResponse
              || body?.['ns2:getInventoryQtyForStyleColorSizeResponse'];
    if (!resp) return { sizes: {} };

    const ret = resp?.return;
    if (!ret) return { sizes: {} };

    // Style-only or style+color query returns structured <response> with <skus>
    const structured = ret?.response;
    if (structured) {
      const skusEl = structured?.skus;
      let skuList = skusEl?.sku;
      if (!skuList) return { sizes: {} };
      if (!Array.isArray(skuList)) skuList = [skuList];

      const sizes = {};
      skuList.forEach(sku => {
        const skuColor = (sku.color || '').toLowerCase().trim();
        const skuSize  = (sku.size  || '').trim();
        if (!skuSize) return;
        // Filter to target color if provided
        if (targetColor && skuColor && skuColor !== targetColor.toLowerCase().trim()) return;

        // Sum qty across all warehouses
        let whseList = sku.whse;
        if (!whseList) return;
        if (!Array.isArray(whseList)) whseList = [whseList];
        const totalQty = whseList.reduce((sum, w) => sum + (parseInt(w.qty, 10) || 0), 0);

        if (!sizes[skuSize]) {
          sizes[skuSize] = { qty: totalQty, status: totalQty === 0 ? 'out_of_stock' : totalQty < 12 ? 'low_stock' : 'in_stock' };
        } else {
          sizes[skuSize].qty += totalQty;
          sizes[skuSize].status = sizes[skuSize].qty === 0 ? 'out_of_stock' : sizes[skuSize].qty < 12 ? 'low_stock' : 'in_stock';
        }
      });
      return { sizes };
    }

    // Fallback: flat listResponse (style+color+size single lookup) — returns warehouse quantities
    // Not used by our /api/inventory route but kept for safety
    return { sizes: {} };
  } catch (e) {
    console.error('extractInventory error:', e.message);
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
        <arg0>
          <color>${color}</color>
          <size>${size}</size>
          <style>${style}</style>
        </arg0>
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
    // Inventory service uses flat args (not complex objects) and a different namespace.
    // arg0=customerNumber, arg1=username, arg2=password, arg3=style, arg4=color, arg5=size(empty=all)
    const body = `
      <tns:getInventoryQtyForStyleColorSize>
        <arg0>${CONFIG.customerNumber}</arg0>
        <arg1>${CONFIG.username}</arg1>
        <arg2>${CONFIG.password}</arg2>
        <arg3>${style}</arg3>
        <arg4>${color}</arg4>
        <arg5></arg5>
      </tns:getInventoryQtyForStyleColorSize>`;

    const result = await soapRequest(SANMAR_INV, body, INV_NS);
    const inventory = extractInventory(result, color);
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
        <arg0>
          <color></color>
          <size></size>
          <style>${style}</style>
        </arg0>
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
          <arg0>
            <color></color>
            <size></size>
            <style>${style}</style>
          </arg0>
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
                <arg0>${CONFIG.customerNumber}</arg0>
                <arg1>${CONFIG.username}</arg1>
                <arg2>${CONFIG.password}</arg2>
                <arg3>${style}</arg3>
                <arg4>${color.catalogColor}</arg4>
                <arg5></arg5>
              </tns:getInventoryQtyForStyleColorSize>`;
            const result = await soapRequest(SANMAR_INV, body, INV_NS);
            inv = extractInventory(result, color.catalogColor);
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
 * GET /api/colors-bulk?style=PC460
 * Uses getProductBulkInfo (returns ALL products, no style filter) then filters by style.
 * Slower but gets exact SanMar color names for styles that reject empty color queries.
 */
app.get('/api/colors-bulk', async (req, res) => {
  const { style } = req.query;
  if (!style) return res.status(400).json({ error: 'style is required' });

  const cacheKey = `colors-bulk:${style}`.toLowerCase();
  const cached = productCache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const body = `
      <tns:getProductBulkInfo>
        ${authArg('arg0')}
      </tns:getProductBulkInfo>`;

    const result = await soapRequest(SANMAR_WSDL, body);
    const sBody = soapBody(result);
    const resp = sBody?.getProductBulkInfoResponse
              || sBody?.['ns2:getProductBulkInfoResponse'];
    const ret = resp?.return;
    const all = ret?.listResponse;
    const items = Array.isArray(all) ? all : (all ? [all] : []);

    const styleUpper = style.toUpperCase();
    const colorMap = {};
    items.forEach(item => {
      const info = item?.productBasicInfo || {};
      if ((info.style || '').toUpperCase() !== styleUpper) return;
      const img = item?.productImageInfo || {};
      const colorName = info.color || info.catalogColor;
      if (!colorName || colorMap[colorName]) return;
      colorMap[colorName] = {
        name: colorName, catalogColor: info.catalogColor || colorName,
        front: img.frontModel || img.colorProductImage || null,
        back: img.backModel || null, side: img.sideModel || null,
        colorSwatch: img.colorSquareImage || img.colorSwatchImage || null,
      };
    });

    const colors = Object.values(colorMap);
    if (colors.length === 0) return res.status(404).json({ error: 'No colors found for style ' + style, totalItems: items.length });
    productCache.set(cacheKey, colors);
    res.json(colors);
  } catch (err) {
    console.error('colors-bulk error:', err.message);
    res.status(500).json({ error: 'SanMar API error', detail: err.message });
  }
});

/**
 * GET /api/colors-named?style=PC460&colors=Jet+Black,White,Club+Navy,...
 * Queries each named color individually (for styles where empty color query fails).
 * Uses size=M for the lookup; images are color-level, not size-level.
 */
app.get('/api/colors-named', async (req, res) => {
  const { style, colors: colorsParam } = req.query;
  if (!style || !colorsParam) return res.status(400).json({ error: 'style and colors are required' });

  const colorNames = colorsParam.split(',').map(c => c.trim()).filter(Boolean);
  const cacheKey = `colors-named:${style}:${colorNames.join('|')}`.toLowerCase();
  const cached = productCache.get(cacheKey);
  if (cached) return res.json(cached);

  const results = {};
  await Promise.all(colorNames.map(async colorName => {
    try {
      const body = `
        <tns:getProductInfoByStyleColorSize>
          <arg0>
            <color>${colorName}</color>
            <size>M</size>
            <style>${style}</style>
          </arg0>
          ${authArg('arg1')}
        </tns:getProductInfoByStyleColorSize>`;
      const result = await soapRequest(SANMAR_WSDL, body);
      const items = extractFromResponse(result) || [];
      if (items.length > 0) {
        const item = items[0];
        const img  = item?.productImageInfo || {};
        const info = item?.productBasicInfo || {};
        results[colorName] = {
          name        : info.color || colorName,
          catalogColor: info.catalogColor || colorName,
          front       : img.frontModel    || img.colorProductImage || null,
          back        : img.backModel     || null,
          side        : img.sideModel     || null,
          frontFlat   : img.frontFlat     || null,
          colorSwatch : img.colorSquareImage || img.colorSwatchImage || null,
        };
      } else {
        // Expose raw parsed response for debugging
        const body2 = soapBody(result);
        const resp2 = body2?.getProductInfoByStyleColorSizeResponse
                   || body2?.['ns2:getProductInfoByStyleColorSizeResponse'];
        const ret2  = resp2?.return;
        const sanmarMsg = ret2?.message || ret2?.errorMessage || null;
        const sanmarRaw = ret2 ? JSON.stringify(ret2).substring(0, 300) : JSON.stringify(body2).substring(0, 300);
        results[colorName] = { name: colorName, error: 'not found', sanmarMsg, sanmarRaw };
      }
    } catch (e) {
      // e.message often contains the raw SanMar fault string
      results[colorName] = { name: colorName, error: e.message };
    }
  }));

  productCache.set(cacheKey, results);
  res.json(results);
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
 * GET /api/rawdebug — returns exact XML sent and exact XML received from SanMar
 */
app.get('/api/rawdebug', async (req, res) => {
  const style = req.query.style || 'PC54';
  const color = req.query.color || 'Navy';
  const size  = req.query.size  || 'M';

  const bodyXml = `
      <tns:getProductInfoByStyleColorSize>
        <arg0>
          <color>${color}</color>
          <size>${size}</size>
          <style>${style}</style>
        </arg0>
        <arg1>
          <sanMarCustomerNumber>${CONFIG.customerNumber}</sanMarCustomerNumber>
          <sanMarUserName>${CONFIG.username}</sanMarUserName>
          <sanMarUserPassword>${CONFIG.password}</sanMarUserPassword>
        </arg1>
      </tns:getProductInfoByStyleColorSize>`;

  const sentEnvelope = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope
  xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:tns="http://impl.webservice.integration.sanmar.com/">
  <soapenv:Header/>
  <soapenv:Body>
    ${bodyXml}
  </soapenv:Body>
</soapenv:Envelope>`;

  try {
    const url = new URL(SANMAR_WSDL);
    const rawXml = await new Promise((resolve, reject) => {
      const opts = {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml;charset=UTF-8',
          'SOAPAction': '""',
          'Content-Length': Buffer.byteLength(sentEnvelope),
        }
      };
      const r = https.request(opts, resp => {
        let d = '';
        resp.on('data', c => d += c);
        resp.on('end', () => resolve(d));
      });
      r.on('error', reject);
      r.write(sentEnvelope);
      r.end();
    });
    res.set('Content-Type', 'application/json');
    res.json({ sent: sentEnvelope, received: rawXml.substring(0, 3000) });
  } catch(e) {
    res.json({ error: e.message, sent: sentEnvelope });
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
