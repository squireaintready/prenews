// src/App.jsx — FINAL WORKING SNAP-BACK
import { useState, useEffect, useRef } from "react";
import { db } from "./firebase";
import { collection, query, orderBy, onSnapshot } from "firebase/firestore";
import "./App.css";

function App() {
  const [active, setActive] = useState([]);
  const [expired, setExpired] = useState([]);
  const [tab, setTab] = useState("active");
  const [expanded, setExpanded] = useState(null);
  const cardRefs = useRef({});
  const preCollapseScroll = useRef({});

  useEffect(() => {
    const q = query(collection(db, "articles"), orderBy("volume24hr", "desc"));
    const unsub = onSnapshot(q, (snapshot) => {
      const now = Date.now();
      const act = [];
      const exp = [];
      snapshot.docs.forEach((doc) => {
        const data = { id: doc.id, ...doc.data() };
        if (data.endDate && new Date(data.endDate) < now) exp.push(data);
        else act.push(data);
      });
      setActive(act);
      setExpired(exp.sort((a, b) => new Date(b.endDate) - new Date(a.endDate)));
    });
    return unsub;
  }, []);

  const toggleExpand = (id) => {
    const card = cardRefs.current[id];
    if (!card) return;

    if (expanded === id) {
      // CAPTURE POSITION BEFORE COLLAPSE
      const rect = card.getBoundingClientRect();
      preCollapseScroll.current[id] = {
        top: window.scrollY + rect.top,
        height: rect.height
      };

      setExpanded(null);

      // RESTORE AFTER COLLAPSE ANIMATION
      setTimeout(() => {
        const saved = preCollapseScroll.current[id];
        if (saved) {
          const targetY = saved.top - (window.innerHeight / 2) + (saved.height / 2);
          window.scrollTo({ top: targetY, behavior: "smooth" });
          delete preCollapseScroll.current[id];
        }
      }, 450);
    } else {
      setExpanded(id);
      setTimeout(() => {
        card.scrollIntoView({ behavior: "smooth", block: "center" });
      }, 50);
    }
  };

  const handleCardClick = (e) => {
    if (e.target.closest("a, button, .readmore-text")) return;
    const card = e.currentTarget;
    const id = card.dataset.id;
    toggleExpand(id);
  };

  const articles = tab === "active" ? active : expired;

  if (articles.length === 0) return <div className="loading">Loading...</div>;

  const escapeRegExp = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  return (
    <div className="App">
      <header className="header">
        <h1>Prediction Pulse</h1>
        <p className="tagline">Markets don't lie.</p>
      </header>

      <div className="tabs">
        <button
          onClick={() => setTab("active")}
          className={tab === "active" ? "active" : ""}
        >
          Active ({active.length})
        </button>
        <button
          onClick={() => setTab("expired")}
          className={tab === "expired" ? "active" : ""}
        >
          Past ({expired.length})
        </button>
      </div>

      <div className="grid">
        {articles.map((a) => {
          const cleanArticle = a.article
            ? a.article.replace(new RegExp(`^${escapeRegExp(a.hook)}`, "i"), "").trim()
            : "Loading article...";

          return (
            <article
              key={a.id}
              data-id={a.id}
              ref={(el) => (cardRefs.current[a.id] = el)}
              className={`card ${expanded === a.id ? "full" : ""}`}
              onClick={handleCardClick}
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
                    <h3 className="question">{a.title || "Loading..."}</h3>
                    <div
                      className={`odds-badge ${a.favored?.toLowerCase() || "yes"}`}
                    >
                      <span className="favored">{a.favored || "Yes"}</span>
                      <span className="odds">{a.odds || "—"}</span>
                    </div>
                  </div>

                  <div className="prob-bar">
                    <div className="fill" style={{ width: a.odds || "0%" }} />
                  </div>

                  <div className="market-stats">
                    <span>Vol: ${a.volume24hr?.toLocaleString() || 0}</span>
                    <span>Liquidity: ${a.liquidity?.toLocaleString() || 0}</span>
                    <span>Open Int: ${a.openInterest?.toLocaleString() || 0}</span>
                  </div>

                  <div className="expire-timer-top">
                    {a.endDate && formatDate(a.endDate)}
                  </div>
                </div>
              </a>

              <div className="content">
                <h2 className="hook">{a.hook || "Loading hook..."}</h2>

                {expanded === a.id ? (
                  <>
                    <div className="article-date">
                      {a.articleDate || formatDate(a.createdAt?.toDate?.() || new Date())}
                    </div>
                    <p className="article">{cleanArticle}</p>
                    <div className="btn-group">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleExpand(a.id);
                        }}
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
                      {cleanArticle
                        ? cleanArticle.split(" ").slice(0, 60).join(" ") +
                          (cleanArticle.split(" ").length > 60 ? "…" : "")
                        : "Loading..."}
                    </p>
                    <div
                      className="readmore-text"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleExpand(a.id);
                      }}
                    >
                      Read More
                    </div>
                  </>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}

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

export default App;