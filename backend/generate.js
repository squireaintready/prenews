// backend/generate.js — NOV 06 2025 09:36 PM EST — @sompiUP
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
const LIMIT = 10;

(async () => {
  console.log('PREDICTION PULSE GENERATOR STARTED — @sompiUP');
  console.log('Time:', new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));

  try {
    const { data } = await axios.get(
      'https://gamma-api.polymarket.com/public-search?q=q&limit_per_type=5&sort=%22volume1mo%22&ascending=true&optimized=true&events_status=%22active%22'
    );

    if (!data.events?.length) {
      console.log('No events found');
      return;
    }

    console.log(`Fetched ${data.events.length} markets → processing ${LIMIT}`);

    let added = 0;
    let exists = 0;
    let skipped = 0;

    for (const e of data.events.slice(0, LIMIT)) {
      console.log(`\nChecking: ${e.title}`);

      if (!e.id || !e.markets?.[0]) {
        console.log('   SKIP: malformed event');
        skipped++;
        continue;
      }

      const m = e.markets[0];

      // ORIGINAL API: outcomePrices is array of strings
      const prices = (m.outcomePrices || [])
        .map(p => parseFloat(p))
        .filter(n => !isNaN(n) && n > 0 && n < 1);

      if (prices.length === 0) {
        console.log('   SKIP: no valid prices');
        skipped++;
        continue;
      }

      const maxIdx = prices.indexOf(Math.max(...prices));
      const favored = m.outcomes[maxIdx] || 'Yes';
      const odds = (prices[maxIdx] * 100).toFixed(0) + '%';

      const docRef = db.collection('articles').doc(e.id);
      if (await docRef.get().then(d => d.exists)) {
        console.log('   ALREADY EXISTS');
        exists++;
        continue;
      }

      const prompt = `Joe Rogan voice, viral news post about: "${e.title}"
TONE: Professional, clear, analytical. Subtle Rogan vibe: curious, direct, conversational. NO swearing, NO "dude", NO exaggeration.
Cover: current odds, market dynamics, key drivers, future risks, final assessment.
End with a strong, thoughtful conclusion

Favored: ${favored} at ${odds}
Give me:
1. One-line hook (no quotes)
2. 300-word article – intense, curious, conversational
Today: November 06, 2025`;

      try {
        const res = await axios.post(GEMINI_URL, {
          contents: [{ role: "user", parts: [{ text: prompt }] }]
        });

        let rawText = '';
        try {
          const candidate = res.data.candidates?.[0];
          if (candidate?.content?.parts?.[0]?.text) {
            rawText = candidate.content.parts[0].text;
          } else {
            rawText = "Gemini returned no text.";
          }
        } catch (err) {
          rawText = "Parse error.";
        }

        rawText = rawText
          .replace(/raceName.*/gi, '')
          .replace(/```[\s\S]*?```/g, '')
          .replace(/^\s*[\r\n]/gm, '')
          .trim();

        const lines = rawText.split('\n\n').map(l => l.trim()).filter(Boolean);
        const hook = lines[0] || "This market is heating up.";
        const article = lines.slice(1).join('\n\n') || "No analysis available.";

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

        console.log(`   ADDED: ${favored} @ ${odds}`);
        added++;
      } catch (geminiErr) {
        console.log('   GEMINI FAILED');
        skipped++;
      }
    }

    console.log('\nRUN COMPLETE');
    console.log(`   Added: ${added}`);
    console.log(`   Exists: ${exists}`);
    console.log(`   Skipped: ${skipped}`);
    console.log(`   @sompiUP — Prediction Pulse is LIVE`);

  } catch (err) {
    console.error('FATAL:', err.response?.data || err.message);
  }
})();