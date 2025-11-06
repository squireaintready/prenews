// src/App.jsx – FINAL FINAL FINAL
import { useState, useEffect, useRef } from "react";
import { db } from "./firebase";
import { collection, getDocs, query, orderBy } from "firebase/firestore";
import "./App.css";

function App() {
  const [articles, setArticles] = useState([]);
  const [expanded, setExpanded] = useState(null);
  const cardRefs = useRef({});

  useEffect(() => {
    const q = query(collection(db, "articles"), orderBy("volume24hr", "desc"));
    getDocs(q).then((snap) => {
      setArticles(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    });
  }, []);

  const handleExpand = (id) => {
    setExpanded(id);
    setTimeout(() => {
      cardRefs.current[id]?.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
    }, 100);
  };

  const handleCardClick = (id, e) => {
    // Don't expand if clicking a link or button
    if (e.target.closest("a") || e.target.closest("button")) return;
    if (expanded !== id) handleExpand(id);
  };

  if (articles.length === 0)
    return <div className="loading">Loading PolyPulse...</div>;

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
    return "Expiring now";
  };

  return (
    <div className="App">
      <header className="header">
        <h1>PolyPulse News</h1>
        <p className="tagline">Markets don't lie. We translate.</p>
      </header>

      <div className="grid">
        {articles.map((a) => (
          <article
            key={a.id}
            ref={(el) => (cardRefs.current[a.id] = el)}
            className={`card ${expanded === a.id ? "full" : ""}`}
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
                  <img
                    src={a.image || "/placeholder.png"}
                    alt=""
                    className="market-icon"
                  />
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
                    <button
                      onClick={() => setExpanded(null)}
                      className="btn-collapse"
                    >
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
                    {a.article.split(" ").slice(0, 120).join(" ")}
                    {a.article.split(" ").length > 120 && "…"}
                  </p>
                  <div
                    className="readmore-text"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleExpand(a.id);
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
