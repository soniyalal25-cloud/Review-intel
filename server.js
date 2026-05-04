const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const GROQ_KEY = process.env.GROQ_KEY;
const GOOGLE_KEY = process.env.GOOGLE_KEY;
const GOOGLE_CX = process.env.GOOGLE_CX;

if (!GROQ_KEY) { console.error('GROQ_KEY env variable missing'); process.exit(1); }

function httpsGet(reqUrl) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(reqUrl);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ReviewIntel/1.0)' }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

function httpsPost(hostname, pathname, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const req = https.request({
      hostname, path: pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr), ...headers }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(bodyStr);
    req.end();
  });
}

async function googleSearch(query) {
  if (!GOOGLE_KEY || !GOOGLE_CX) return [];
  try {
    const u = `https://www.googleapis.com/customsearch/v1?key=${GOOGLE_KEY}&cx=${GOOGLE_CX}&q=${encodeURIComponent(query)}&num=10`;
    const r = await httpsGet(u);
    if (r.status !== 200) { console.log('Google error:', r.status); return []; }
    const d = JSON.parse(r.body);
    return (d.items || []).map(i => ({ title: i.title || '', snippet: i.snippet || '', url: i.link || '', displayUrl: i.displayLink || '' }));
  } catch (e) { console.log('Google failed:', e.message); return []; }
}

function detectPlatform(u) {
  if (u.includes('amazon.in')) return 'amazon';
  if (u.includes('flipkart.com')) return 'flipkart';
  if (u.includes('nykaa.com')) return 'nykaa';
  if (u.includes('myntra.com')) return 'myntra';
  if (u.includes('swiggy.com')) return 'swiggy';
  if (u.includes('zepto')) return 'zepto';
  return 'other';
}

async function callGroq(messages) {
  const r = await httpsPost('api.groq.com', '/openai/v1/chat/completions',
    { model: 'llama-3.3-70b-versatile', temperature: 0.1, max_tokens: 2000, response_format: { type: 'json_object' }, messages },
    { 'Authorization': `Bearer ${GROQ_KEY}` }
  );
  if (r.status !== 200) throw new Error('Groq error ' + r.status);
  const raw = JSON.parse(r.body).choices?.[0]?.message?.content || '{}';
  return JSON.parse(raw.replace(/```json|```/g, '').trim());
}

async function handleAnalyse(query, sources) {
  const reviewPlatforms = sources.filter(s => ['amazon','flipkart','nykaa','myntra'].includes(s));
  const domains = { amazon:'amazon.in', flipkart:'flipkart.com', nykaa:'nykaa.com', myntra:'myntra.com' };
  const siteFilter = reviewPlatforms.map(s => `site:${domains[s]}`).join(' OR ');
  const searchQuery = `${query} reviews price india (${siteFilter})`;
  
  console.log('Searching:', searchQuery);
  const results = await googleSearch(searchQuery);
  console.log('Results:', results.length);

  let realContext = '';
  if (results.length > 0) {
    realContext = 'REAL WEB SEARCH DATA:\n\n';
    results.forEach((r, i) => {
      realContext += `[${i+1}] Platform: ${detectPlatform(r.url)}\nURL: ${r.url}\nTitle: ${r.title}\nContent: ${r.snippet}\n\n`;
    });
  }

  const prompt = `You are a product review analyst for the Indian e-commerce market.

PRODUCT: "${query}"
PLATFORMS: ${sources.join(', ')}

${realContext || 'NO LIVE DATA — use training knowledge, be honest about confidence.'}

Return ONLY valid JSON:
{
  "product_name": "full name",
  "brand": "brand",
  "category": "category",
  "confidence": "${results.length > 0 ? 'high' : 'medium'}",
  "data_source": "${results.length > 0 ? 'live_web_search' : 'ai_training_data'}",
  "overall_rating": 4.3,
  "total_reviews": 12500,
  "rating_basis": "basis note",
  "sentiment_scores": { "quality": 8.0, "value_for_money": 6.5, "efficacy": 8.2 },
  "sentiment_breakdown": { "positive": 70, "neutral": 20, "negative": 10 },
  "overall_summary": "2-3 sentences from real data",
  "best_for": "who this suits",
  "pros": ["from real reviews"],
  "cons": ["from real reviews"],
  "neutral_points": ["neutral observations"],
  "review_snippets": [
    {"text": "real quote from search results above", "platform": "amazon", "sentiment": "positive"},
    {"text": "real quote", "platform": "nykaa", "sentiment": "positive"},
    {"text": "critical quote", "platform": "flipkart", "sentiment": "negative"}
  ],
  "source_data": {
    "amazon":   { "available": true,  "price": "₹1,521", "rating": 4.4, "reviews": 8200, "verified": ${results.some(r=>r.url.includes('amazon'))}, "note": "" },
    "flipkart": { "available": true,  "price": "₹1,499", "rating": 4.2, "reviews": 3100, "verified": ${results.some(r=>r.url.includes('flipkart'))}, "note": "" },
    "nykaa":    { "available": true,  "price": "₹1,690", "rating": 4.5, "reviews": 9787, "verified": ${results.some(r=>r.url.includes('nykaa'))}, "note": "" },
    "myntra":   { "available": false, "price": null, "rating": null, "reviews": null, "verified": false, "note": "" },
    "swiggy":   { "available": false, "price": null, "rating": null, "reviews": null, "verified": false, "note": "" },
    "zepto":    { "available": false, "price": null, "rating": null, "reviews": null, "verified": false, "note": "" }
  },
  "alternatives": [
    { "name": "real product", "brand": "Brand", "reason": "specific reason", "rating": 4.5, "price": "₹X", "stores": ["amazon","nykaa"], "recommended": true },
    { "name": "real product", "brand": "Brand", "reason": "budget pick",     "rating": 4.2, "price": "₹X", "stores": ["flipkart"],          "recommended": false },
    { "name": "real product", "brand": "Brand", "reason": "premium option",  "rating": 4.4, "price": "₹X", "stores": ["amazon"],             "recommended": false }
  ],
  "verdict": "honest one-line verdict"
}

RULES: review_snippets must use actual text from search results above. verified:true only if price came from search results. Myntra=fashion only. Nykaa=beauty only. Swiggy/Zepto=FMCG/grocery only.`;

  return await callGroq([
    { role: 'system', content: 'Strict product analyst. Use only provided search data. Return valid JSON only.' },
    { role: 'user', content: prompt }
  ]);
}

const MIME = { '.html':'text/html', '.js':'application/javascript', '.json':'application/json' };

http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method === 'POST' && req.url === '/analyse') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { query, sources } = JSON.parse(body);
        if (!query || query.length > 500) { res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid query' })); return; }
        const result = await handleAnalyse(query, sources || ['amazon','flipkart','nykaa','myntra']);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (e) {
        console.error(e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', groq: !!GROQ_KEY, google: !!GOOGLE_KEY }));
    return;
  }

  let filePath = req.url === '/' ? '/index.html' : req.url;
  filePath = path.join(__dirname, filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'text/plain' });
    res.end(data);
  });
}).listen(PORT, () => console.log(`Review Intel running on port ${PORT}`));
