// backend/generate.js — FINAL @sompiUP — NOV 06 2025 10:15 PM EST
require('dotenv').config();
const axios = require('axios');
const admin = require('firebase-admin');

let serviceAccount;
if (process.env.FIREBASE_ADMIN_SDK) {
  serviceAccount = JSON.parse(process.env.FIREBASE_ADMIN_SDK);
} else {
  serviceAccount = require('./adminsdk.json');
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });

const GEMINI_URL = `https://generativelanguage.googleapis.com/v1/models/gemini-2.5-pro:generateContent?key=${process.env.REACT_APP_GEMINI_KEY}`;
const LIMIT = 11;

(async () => {
  console.log('PREDICTION PULSE — @sompiUP — USA');
  console.log('Time:', new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));

  try {
    const { data } = await axios.get(
      `https://gamma-api.polymarket.com/public-search?q=q&limit_per_type=${LIMIT}&sort=%22volume1mo%22&ascending=true&optimized=true&events_status=%22active%22`
    );

    if (!data.events?.length) {
      console.log('No events');
      return;
    }

    console.log(`Fetched ${data.events.length} → ${LIMIT} new`);

    let added = 0;

    for (const e of data.events) {
      if (!e.id || !e.markets?.[0]) continue;

      const m = e.markets[0];
      const prices = (m.outcomePrices || []).map(p => parseFloat(p)).filter(n => !isNaN(n));
      if (prices.length === 0) continue;

      const maxIdx = prices.indexOf(Math.max(...prices));
      const favored = m.outcomes[maxIdx] || 'Yes';
      const odds = (prices[maxIdx] * 100).toFixed(0) + '%';

      const docRef = db.collection('articles').doc(e.id);
      if (await docRef.get().then(d => d.exists)) {
        console.log('EXISTS:', e.title);
        continue;
      }

      // FULL EVENT DATA
      let volume = e.volume || 0;
      let liquidity = 0;
      let openInterest = 0;
      try {
        const eventRes = await axios.get(`https://gamma-api.polymarket.com/events/${e.id}`);
        const full = eventRes.data;
        volume = full.volume || volume;
        liquidity = full.liquidity || 0;
        openInterest = full.openInterest || 0;
      } catch (err) {
        console.log('EVENT API FAILED');
      }

      const prompt = `Joe Rogan voice, viral news post about: "${e.title}"
TONE: Professional, clear, analytical. Subtle Rogan vibe: curious, direct, conversational.
NO swearing, NO "dude", NO exaggeration, NO asterisks, NO hashtags, NO markdown.

Cover: current odds, market dynamics, key drivers, future risks, final assessment.
End with a strong, thoughtful conclusion.

Favored: ${favored} at ${odds}

Give me:
1. ONE-LINE HEADLINE HOOK (no quotes, max 12 words) — MUST end with:
   - "?" if question
   - "…" if incomplete thought
   - "!" if bold statement
   Make it punchy, viral, impossible to ignore.
2. 250-word article – intense, curious, conversational
Today: November 06, 2025`;

      try {
        const res = await axios.post(GEMINI_URL, {
          contents: [{ role: "user", parts: [{ text: prompt }] }]
        });

        const candidate = res.data.candidates?.[0];
        if (candidate?.functionCall) {
          console.log('BLOCKED: functionCall');
          continue;
        }

        let rawText = candidate?.content?.parts?.[0]?.text || "No response.";

        // KILL ALL SYMBOLS
        rawText = rawText
          .replace(/[*#]/g, '')
          .replace(/```[\s\S]*?```/g, '')
          .replace(/^\s*[\r\n]/gm, '')
          .trim();

        const splitIndex = rawText.search(/\n\s*2[\.\)\-]\s/i);
        let hook = "This market is heating up.";
        let article = "No analysis available.";

        if (splitIndex !== -1) {
          hook = rawText.substring(0, splitIndex).trim();
          article = rawText.substring(splitIndex).trim();
        } else {
          hook = rawText.split('\n')[0] || hook;
          article = rawText;
        }

        await docRef.set({
          id: e.id,
          title: e.title,
          slug: e.slug,
          image: e.image || '',
          hook: hook.trim(),
          article: article.trim(),
          favored,
          odds,
          volume24hr: volume,
          liquidity,
          openInterest,
          endDate: e.endDate,
          createdAt: new Date()
        });

        console.log(`ADDED: ${e.title}`);
        console.log(`   Hook: "${hook}"`);
        console.log(`   Volume: $${volume.toLocaleString()}`);
        console.log(`   Liquidity: $${liquidity.toLocaleString()}`);
        console.log(`   Open Interest: $${openInterest.toLocaleString()}`);
        added++;
      } catch (err) {
        console.log('GEMINI FAILED:', e.title);
      }
    }

    console.log(`\nFINISHED — ${added} NEW ARTICLES`);
    console.log(`@sompiUP — https://prenews.vercel.app`);

  } catch (err) {
    console.error('FATAL:', err.response?.data || err.message);
  }
})();