// src/App.jsx — FINAL @sompiUP — NOV 06 2025 10:25 PM EST
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

  const expandAndSnap = (id) => {
    setExpanded(id);
    setTimeout(
      () =>
        cardRefs.current[id]?.scrollIntoView({
          behavior: "smooth",
          block: "center",
        }),
      50
    );
  };

  const handleCardClick = (e) => {
    if (e.target.closest("a, button")) return;
    const card = e.currentTarget;
    const id = card.dataset.id;
    expandAndSnap(id);
  };

  const articles = tab === "active" ? active : expired;

  if (articles.length === 0) return <div className="loading">Loading...</div>;

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
        {articles.map((a) => (
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
                  <div
                    className={`odds-badge ${
                      a.favored?.toLowerCase() || "yes"
                    }`}
                  >
                    <span className="favored">{a.favored || "Yes"}</span>
                    <span className="odds">{a.odds || "—"}</span>
                  </div>
                  <h3 className="question">{a.title || "Loading..."}</h3>
                </div>

                {/* EXPIRES — TOP OF CARD — WALL STREET STYLE */}
                <div className="expire-timer-top">
                  {a.endDate && formatDate(a.endDate)}
                </div>

                <div className="prob-bar">
                  <div className="fill" style={{ width: a.odds || "0%" }} />
                </div>

                <div className="market-stats">
                  <span>Vol: ${a.volume24hr?.toLocaleString() || 0}</span>
                  <span>Liquidity: ${a.liquidity?.toLocaleString() || 0}</span>
                  {/* <span>Open Int: ${a.openInterest?.toLocaleString() || 0}</span> */}
                </div>
              </div>
            </a>

            {/* Collapsible content — click anywhere to expand/collapse */}
            <div
              className="content"
              onClick={(e) => {
                e.stopPropagation();
                if (expanded === a.id) setExpanded(null);
                else expandAndSnap(a.id);
              }}
              style={{ cursor: "pointer" }}
            >
              {expanded === a.id ? (
                <>
                  <p className="article">{a.article || "Loading article..."}</p>
                  <div className="btn-group">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setExpanded(null);
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
                    {a.article
                      ? a.article.split(" ").slice(0, 60).join(" ") +
                        (a.article.split(" ").length > 60 ? "…" : "")
                      : "Loading..."}
                  </p>
                  <div className="readmore-text">Read More</div>
                </>
              )}
            </div>
          </article>
        ))}
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
