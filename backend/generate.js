// backend/generate.js — FINAL @sompiUP — NOV 06 2025 11:50 PM EST
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

const GEMINI_URL = `https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash:generateContent?key=${process.env.REACT_APP_GEMINI_KEY}`;
const LIMIT = 60;

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

      const today = new Date().toLocaleDateString('en-US', {
        month: 'long',
        day: 'numeric',
        year: 'numeric',
        timeZone: 'America/New_York'
      });

      const prompt = `You are a senior market analyst guest on JRE.

Write in third-person, surgical tone. Zero opinion.

Event: "${e.title}"
Market: ${favored} at ${odds}

Structure:
1. 11-word headline hook ending in ? … or ! — witty, unexpected, viral-ready
2. 150-word dispatch of:
   - Hard facts only, including other relevant hard facts (think hard about connections)
   - Key drivers/factors moving the market
   - Viral signals that actually matter (tweets, memes, headlines that moved money)
   - Clever second-order effects most miss
   - Hidden connections, behavioral tells, structural edges
   - Only if it's meaningful AND not obvious

No first-person. No markdown. No hashtags. No filler.

Pure signal. Date: ${today}`;

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

        rawText = rawText
          .replace(/raceName.*/gi, '')
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

        // STILL STORE volume/liquidity/openInterest — just not in prompt
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
          createdAt: new Date(),
          articleDate: today
        });

        console.log(`ADDED: ${e.title}`);
        console.log(`   Hook: "${hook}"`);
        console.log(`   Date: ${today}`);
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