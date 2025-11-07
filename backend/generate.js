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

    if (!data.events || !Array.isArray(data.events)) {
      console.log('No events from Polymarket');
      return;
    }

    console.log(`Processing ${data.events.length} markets → ${LIMIT} new`);

    for (const e of data.events.slice(0, LIMIT)) {
      if (!e.id || !e.markets?.[0]) {
        console.log('SKIP: malformed event');
        continue;
      }

      const m = e.markets[0];

      if (!Array.isArray(m.outcomePrices) || !Array.isArray(m.outcomes)) {
        console.log('SKIP: no prices/outcomes', e.title);
        continue;
      }

      const prices = m.outcomePrices
        .map(p => parseFloat(p))
        .filter(n => !isNaN(n) && n > 0 && n < 1);

      if (prices.length === 0) {
        console.log('SKIP: invalid prices', e.title);
        continue;
      }

      const maxIdx = prices.indexOf(Math.max(...prices));
      const favored = m.outcomes[maxIdx] || 'Yes';
      const odds = (prices[maxIdx] * 100).toFixed(0) + '%';

      const docRef = db.collection('articles').doc(e.id);
      if (await docRef.get().then(d => d.exists)) {
        console.log('EXISTS:', e.title);
        continue;
      }

      const prompt = `Joe Rogan voice, viral news post about: "${e.title}"
      TONE: Professional, clear, analytical. Subtle Rogan vibe: curious, direct, conversational. NO swearing, NO "dude", NO exaggeration. Don't use asterisk and remove all asterisk.
      Cover: current odds, market dynamics, key drivers, future risks, final assessment.
      End with a strong, thoughtful conclusion.

      Favored: ${favored} at ${odds}
      Give me:
      1. One-line hook (no quotes)
      2. 300-word article – intense, curious, conversational
      Today: November 06, 2025`;
      try {
        const res = await axios.post(GEMINI_URL, {
          contents: [{ role: "user", parts: [{ text: prompt }] }]
        });

        let raw = res.data.candidates[0].content.parts[0].text;

        // KILL GEMINI'S "raceName" HALLUCINATION FOREVER
        raw = raw.replace(/raceName.*/gi, '').replace(/^\s*[\r\n]/gm, '').trim();

        const lines = raw.split('\n\n').map(l => l.trim()).filter(Boolean);
        const hook = lines[0] || "This market is WILD.";
        const article = lines.slice(1).join('\n\n') || "Gemini went full rogue, but the odds don't lie.";

        await docRef.set({
          id: e.id,
          title: e.title,
          slug: e.slug,
          image: e.image || '',
          hook: hook.trim(),
          article: article.trim(),
          favored,
          odds,
          volume24hr: e.volume24hr || 0,
          endDate: e.endDate,
          createdAt: new Date()
        });

        console.log('ADDED:', e.title, '|', favored, odds);
      } catch (geminiErr) {
        console.log('Gemini failed on:', e.title);
      }
    }

    console.log('FINISHED — Prediction Pulse is LIVE');
  } catch (err) {
    console.error('FATAL:', err.response?.data || err.message);
  }
})();