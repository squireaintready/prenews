// src/App.jsx – FULL FINAL VERSION WITH LIVE TABS & AUTO-REFRESH
import { useState, useEffect } from 'react';
import { db } from './firebase';
import { collection, query, orderBy, onSnapshot } from 'firebase/firestore';
import './App.css';

function App() {
  const [active, setActive] = useState([]);
  const [expired, setExpired] = useState([]);
  const [tab, setTab] = useState('active');

  useEffect(() => {
    const q = query(collection(db, 'articles'), orderBy('volume24hr', 'desc'));
    const unsub = onSnapshot(q, (snapshot) => {
      const now = Date.now();
      const activeList = [];
      const expiredList = [];

      snapshot.docs.forEach(doc => {
        const data = { id: doc.id, ...doc.data() };
        if (data.endDate && new Date(data.endDate) < now) {
          expiredList.push(data);
        } else {
          activeList.push(data);
        }
      });

      setActive(activeList);
      setExpired(expiredList.sort((a, b) => new Date(b.endDate) - new Date(a.endDate)));
    });

    return () => unsub();
  }, []);

  const articles = tab === 'active' ? active : expired;

  const formatDate = (dateStr) => {
    const d = new Date(dateStr);
    const now = new Date();
    const diffMs = d - now;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffDays > 0) return `Expires in ${diffDays}d`;
    if (diffHours > 0) return `Expires in ${diffHours}h`;
    if (diffMins > 0) return `Expires in ${diffMins}m`;
    return 'Expiring now';
  };

  const handleCardClick = (id, e) => {
    if (e.target.closest('a') || e.target.closest('button') || e.target.closest('.readmore-text')) return;
    setTab('active');
    setTimeout(() => {
      document.getElementById(`card-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 100);
    setExpanded(id);
  };

  const [expanded, setExpanded] = useState(null);

  if (active.length + expired.length === 0) {
    return <div className="loading">Loading PolyPulse...</div>;
  }

  return (
    <div className="App">
      <header className="header">
        <h1>PolyPulse News</h1>
        <p className="tagline">Markets don't lie.</p>
      </header>

      <div className="tabs">
        <button
          onClick={() => setTab('active')}
          className={tab === 'active' ? 'active' : ''}
        >
          Active ({active.length})
        </button>
        <button
          onClick={() => setTab('expired')}
          className={tab === 'expired' ? 'active' : ''}
        >
          Expired ({expired.length})
        </button>
      </div>

      <div className="grid">
        {articles.map(a => (
          <article
            key={a.id}
            id={`card-${a.id}`}
            className={`card ${expanded === a.id ? 'full' : ''}`}
            onClick={(e) => handleCardClick(a.id, e)}
          >
            <a
              href={`https://polymarket.com/event/${a.slug}`}
              target="_blank"
              rel="noopener noreferrer"
              className="header-link"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="card-header">
                <div className="header-row">
                  <img src={a.image || '/placeholder.png'} alt="" className="market-icon" />
                  <div className={`odds-badge ${a.favored.toLowerCase()}`}>
                    <span className="favored">{a.favored}</span>
                    <span className="odds">{a.odds}</span>
                  </div>
                  <h3 className="question">{a.title}</h3>
                </div>
                <div className="prob-bar">
                  <div className="fill" style={{ width: a.odds }} />
                </div>
                <div className="expire-timer">
                  {a.endDate && formatDate(a.endDate)}
                </div>
              </div>
            </a>

            <div className="content">
              <h2 className="hook">{a.hook}</h2>

              {expanded === a.id ? (
                <>
                  <p className="article">{a.article}</p>
                  <div className="btn-group">
                    <button onClick={(e) => { e.stopPropagation(); setExpanded(null); }} className="btn-collapse">
                      Collapse
                    </button>
                    <a
                      href={`https://polymarket.com/event/${a.slug}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="btn-bet"
                      onClick={(e) => e.stopPropagation()}
                    >
                      Bet Now
                    </a>
                  </div>
                </>
              ) : (
                <>
                  <p className="teaser">
                    {a.article.split(' ').slice(0, 120).join(' ')}
                    {a.article.split(' ').length > 120 && '…'}
                  </p>
                  <div
                    className="readmore-text"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleCardClick(a.id, e);
                    }}
                  >
                    Read More
                  </div>
                </>
              )}
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

export default App;