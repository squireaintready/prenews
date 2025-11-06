const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());

app.get('/markets', async (req, res) => {
  try {
    const { data } = await axios.get(
      'https://gamma-api.polymarket.com/public-search?q=q&events_status=active&limit_per_type=100&sort=endDate&optimized=true'
    );
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: 'API down' });
  }
});

app.listen(4000, () => console.log('Backend live on 4000'));