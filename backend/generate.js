// backend/generate.js
require('dotenv').config();
const axios = require('axios');
const admin = require('firebase-admin');

const serviceAccount = JSON.parse(process.env.FIREBASE_ADMIN_SDK);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });

const GEMINI_URL = `https://generativelanguage.googleapis.com/v1/models/gemini-2.5-pro:generateContent?key=${process.env.REACT_APP_GEMINI_KEY}`;
const LIMIT = 10;

(async () => {
  try {
    const { data } = await axios.get(
      'https://gamma-api.polymarket.com/public-search?q=q&sort=volume24hr&keep_closed_markets=1&limit_per_type=50&events_status=active&cache=true&optimized=true'
    );

    console.log(`Fetched ${data.events?.length || 0} events`);

    for (const e of (data.events || []).slice(0, LIMIT)) {
      // BASIC SAFETY
      if (!e.id || !e.markets?.[0]) {
        console.log('SKIP: bad event structure');
        continue;
      }

      const m = e.markets[0];

      // PRICE & OUTCOME VALIDATION
      if (!Array.isArray(m.outcomePrices) || !Array.isArray(m.outcomes)) {
        console.log('SKIP: missing prices/outcomes', e.title);
        continue;
      }

      const prices = m.outcomePrices
        .map(p => parseFloat(p))
        .filter(n => !isNaN(n));

      if (prices.length === 0) {
        console.log('SKIP: no valid prices', e.title);
        continue;
      }

      const maxIdx = prices.indexOf(Math.max(...prices));
      if (!m.outcomes[maxIdx]) {
        console.log('SKIP: no outcome for highest price', e.title);
        continue;
      }

      const docRef = db.collection('articles').doc(e.id);
      if (await docRef.get().then(d => d.exists)) {
        console.log('Already exists:', e.title);
        continue;
      }

      const favored = m.outcomes[maxIdx];
      const odds = (prices[maxIdx] * 100).toFixed(0) + '%';

      const prompt = `Joe Rogan voice, viral news post about: "${e.title}"
Favored: ${favored} at ${odds}
Give me:
1. One-line hook (no quotes)
2. 150-word article – intense, curious, conversational
Today: November 06, 2025`;

      const res = await axios.post(GEMINI_URL, {
        contents: [{ role: "user", parts: [{ text: prompt }] }]
      });

      const [hook, ...body] = res.data.candidates[0].content.parts[0].text.split('\n\n');

      await docRef.set({
        id: e.id,
        title: e.title,
        slug: e.slug,
        image: e.image || '',
        hook: hook.trim(),
        article: body.join('\n\n').trim(),
        favored,
        odds,
        volume24hr: e.volume24hr || 0,
        endDate: e.endDate,
        createdAt: new Date()
      });

      console.log('ADDED:', e.title, '|', favored, odds);
    }

    console.log('FINISHED – All clean');
  } catch (err) {
    console.error('FATAL:', err.response?.data || err.message);
  }
})();