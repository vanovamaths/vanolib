(function(){
  "use strict";

  var state = {
    manifest: null,
    all: [],
    loadedYears: new Set(),
    rendered: 0,
    chunk: 70,
    query: "",
    yearFilter: "",
    catFilter: "",
    sort: "newest"
  };

  var $list = document.getElementById("list");
  var $latest = document.getElementById("latest-list");
  var $latestSection = document.getElementById("latest-section");
  var $empty = document.getElementById("empty");
  var $q = document.getElementById("q");
  var $qSide = document.getElementById("q-side");
  var $year = document.getElementById("year");
  var $cat = document.getElementById("cat");
  var $sort = document.getElementById("sort");
  var $loadFill = document.getElementById("loadbar-fill");
  var $sentinel = document.getElementById("sentinel");
  var $foot = document.getElementById("foot");
  var $resultCount = document.getElementById("result-count");

  var CATEGORY_NAMES = {
    "math.AG":"Algebraic geometry",
    "math.AT":"Algebraic topology",
    "math.AP":"Analysis of PDEs",
    "math.AC":"Commutative algebra",
    "math.CA":"Classical analysis",
    "math.CO":"Combinatorics",
    "math.CT":"Category theory",
    "math.CV":"Complex variables",
    "math.DG":"Differential geometry",
    "math.DS":"Dynamical systems",
    "math.FA":"Functional analysis",
    "math.GM":"General mathematics",
    "math.GN":"General topology",
    "math.GR":"Group theory",
    "math.GT":"Geometric topology",
    "math.HO":"History and overview",
    "math.KT":"K-theory",
    "math.LO":"Logic",
    "math.MG":"Metric geometry",
    "math.MP":"Mathematical physics",
    "math.NA":"Numerical analysis",
    "math.NT":"Number theory",
    "math.OA":"Operator algebras",
    "math.OC":"Optimization and control",
    "math.PR":"Probability",
    "math.QA":"Quantum algebra",
    "math.RA":"Rings and algebras",
    "math.RT":"Representation theory",
    "math.SG":"Symplectic geometry",
    "math.SP":"Spectral theory",
    "math.ST":"Statistics theory",
    "math-ph":"Mathematical physics",
    "quant-ph":"Quantum physics"
  };

  function escapeHTML(s){
    return String(s || "").replace(/[&<>\"]/g, function(c){
      return {"&":"&amp;","<":"&lt;",">":"&gt;",'\"':"&quot;"}[c];
    });
  }

  function debounce(fn, ms){
    var t;
    return function(){
      var args = arguments;
      clearTimeout(t);
      t = setTimeout(function(){ fn.apply(null, args); }, ms);
    };
  }

  function recFromRow(row, year){
    return {
      id: row[0],
      title: row[1],
      authors: row[2],
      cat: row[3],
      pub: row[4],
      year: year,
      lt: (row[1] || "").toLowerCase(),
      la: (row[2] || "").toLowerCase()
    };
  }

  function formatNumber(n){
    try { return Number(n).toLocaleString("en-CA"); }
    catch(e){ return String(n || "—"); }
  }

  function formatDate(value){
    if (!value) return "—";
    var d = new Date(value);
    if (isNaN(d.getTime())) return String(value).slice(0,10);
    return d.toLocaleDateString("en-US", {month:"short", day:"numeric", year:"numeric"});
  }

  function dateValue(rec){
    var t = Date.parse(rec.pub || "");
    if (!isNaN(t)) return t;
    var y = parseInt(rec.year, 10);
    return isNaN(y) ? 0 : y * 10000000000;
  }

  function categoryLabel(code){
    return CATEGORY_NAMES[code] || code || "Mathematics";
  }

  function authorShort(authors){
    var parts = String(authors || "").split(";").map(function(x){ return x.trim(); }).filter(Boolean);
    if (!parts.length) return "Unknown author";
    if (parts.length <= 2) return parts.join(", ");
    return parts[0] + " et al.";
  }

  function loadYear(year){
    if (state.loadedYears.has(year)) return Promise.resolve();
    state.loadedYears.add(year);
    return fetch("data/" + year + ".json")
      .then(function(r){
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function(rows){
        for (var i=0;i<rows.length;i++) state.all.push(recFromRow(rows[i], year));
      })
      .catch(function(err){
        state.loadedYears.delete(year);
        console.warn("year load failed", year, err);
      });
  }

  function updateProgress(){
    var total = state.manifest ? state.manifest.years.length : 1;
    var pct = Math.round(100 * state.loadedYears.size / total);
    $loadFill.style.width = pct + "%";
    if (pct >= 100) setTimeout(function(){ $loadFill.style.width = "0%"; }, 650);
  }

  function ensureAllLoaded(onProgress){
    if (!state.manifest) return Promise.resolve();
    var missing = state.manifest.years.map(function(y){ return y.year; }).filter(function(y){
      return !state.loadedYears.has(y);
    });
    if (!missing.length) return Promise.resolve();
    return Promise.all(missing.map(function(y){
      return loadYear(y).then(function(){
        updateProgress();
        if (onProgress) onProgress();
      });
    }));
  }

  function matches(rec){
    if (state.yearFilter && rec.year !== state.yearFilter) return false;
    if (state.catFilter && rec.cat !== state.catFilter) return false;
    if (state.query && rec.lt.indexOf(state.query) === -1 && rec.la.indexOf(state.query) === -1) return false;
    return true;
  }

  function sorted(records){
    var arr = records.slice();
    if (state.sort === "title"){
      arr.sort(function(a,b){ return String(a.title || "").localeCompare(String(b.title || "")); });
    } else if (state.sort === "oldest"){
      arr.sort(function(a,b){ return dateValue(a) - dateValue(b); });
    } else {
      arr.sort(function(a,b){ return dateValue(b) - dateValue(a); });
    }
    return arr;
  }

  function currentSet(){
    var base = (!state.query && !state.yearFilter && !state.catFilter) ? state.all : state.all.filter(matches);
    return sorted(base);
  }

  function hasFilters(){
    return !!(state.query || state.yearFilter || state.catFilter || state.sort !== "newest");
  }

  function topicPill(rec){
    return '<span class="topic-pill" title="' + escapeHTML(rec.cat) + '">' + escapeHTML(categoryLabel(rec.cat)) + '</span>';
  }

  function latestHTML(rec){
    return '<article class="latest-card" data-id="' + escapeHTML(rec.id) + '">' +
      '<div class="latest-top"><span class="new-label">NEW</span><span>' + escapeHTML(formatDate(rec.pub)) + '</span></div>' +
      '<h3>' + escapeHTML(rec.title || "Untitled") + '</h3>' +
      '<div class="latest-authors">' + escapeHTML(authorShort(rec.authors)) + '</div>' +
      '<div class="latest-arxiv">arXiv:' + escapeHTML(rec.id) + ' &nbsp;[' + escapeHTML(rec.cat) + ']</div>' +
      '<div class="topic-pills">' + topicPill(rec) + '</div>' +
      '<div class="card-actions">' +
        '<a href="https://arxiv.org/abs/' + encodeURIComponent(rec.id) + '" target="_blank" rel="noopener">▤ Abstract</a>' +
        '<a href="https://arxiv.org/pdf/' + encodeURIComponent(rec.id) + '" target="_blank" rel="noopener">▤ PDF</a>' +
        '<button type="button" data-read="' + escapeHTML(rec.id) + '">Read →</button>' +
      '</div>' +
    '</article>';
  }

  function articleHTML(rec, index){
    return '<article class="article-row" data-id="' + escapeHTML(rec.id) + '">' +
      '<div class="article-index">' + String(index + 1).padStart(2,"0") + '</div>' +
      '<div><div class="article-title">' + escapeHTML(rec.title || "Untitled") + '</div><div class="article-authors">' + escapeHTML(authorShort(rec.authors)) + '</div></div>' +
      '<div class="article-arxiv"><div class="article-id">arXiv:' + escapeHTML(rec.id) + '</div><div class="article-date">' + escapeHTML(formatDate(rec.pub)) + '</div></div>' +
      '<div class="article-topic"><span class="topic-pill" title="' + escapeHTML(rec.cat) + '">' + escapeHTML(categoryLabel(rec.cat)) + '</span></div>' +
      '<div class="article-actions">' +
        '<a href="https://arxiv.org/abs/' + encodeURIComponent(rec.id) + '" target="_blank" rel="noopener">▤ Abstract</a>' +
        '<a href="https://arxiv.org/pdf/' + encodeURIComponent(rec.id) + '" target="_blank" rel="noopener">▤ PDF</a>' +
        '<button type="button" data-read="' + escapeHTML(rec.id) + '">Read →</button>' +
      '</div>' +
    '</article>';
  }

  var currentResults = [];
  var visibleResults = [];

  function resetAndRender(){
    currentResults = currentSet();
    var filtered = hasFilters();

    if (filtered){
      $latestSection.style.display = "none";
      visibleResults = currentResults;
    } else {
      $latestSection.style.display = "block";
      var latest = currentResults.slice(0, 3);
      $latest.innerHTML = latest.map(latestHTML).join("");
      visibleResults = currentResults.slice(3);
    }

    $list.innerHTML = "";
    state.rendered = 0;
    $empty.style.display = visibleResults.length === 0 ? "block" : "none";

    if (!filtered && state.manifest){
      $resultCount.textContent = formatNumber(state.manifest.total) + " papers";
    } else {
      $resultCount.textContent = formatNumber(currentResults.length) + " results";
    }

    renderMore();
  }

  function renderMore(){
    var end = Math.min(state.rendered + state.chunk, visibleResults.length);
    if (end <= state.rendered) return;
    var html = "";
    for (var i=state.rendered;i<end;i++) html += articleHTML(visibleResults[i], i);
    $list.insertAdjacentHTML("beforeend", html);
    state.rendered = end;
  }

  var io = new IntersectionObserver(function(entries){
    entries.forEach(function(e){
      if (e.isIntersecting && state.rendered < visibleResults.length) renderMore();
    });
  }, {rootMargin:"700px"});
  io.observe($sentinel);

  function openReader(id){
    var rec = state.all.find(function(r){ return r.id === id; });
    var reader = document.getElementById("reader");
    document.getElementById("reader-title").textContent = rec ? rec.title : id;
    document.getElementById("reader-abs-link").href = "https://arxiv.org/abs/" + id;
    document.getElementById("reader-pdf-link").href = "https://arxiv.org/pdf/" + id;
    document.getElementById("reader-frame").src = "https://arxiv.org/pdf/" + id;
    reader.classList.add("open");
    reader.setAttribute("aria-hidden","false");
  }

  function closeReader(){
    var reader = document.getElementById("reader");
    reader.classList.remove("open");
    reader.setAttribute("aria-hidden","true");
    setTimeout(function(){ document.getElementById("reader-frame").src = ""; }, 200);
  }

  function handleResultClick(e){
    var read = e.target.closest("[data-read]");
    if (read){
      e.preventDefault();
      openReader(read.getAttribute("data-read"));
      return;
    }
    if (e.target.closest("a,button")) return;
    var card = e.target.closest("[data-id]");
    if (card) openReader(card.getAttribute("data-id"));
  }

  $list.addEventListener("click", handleResultClick);
  $latest.addEventListener("click", handleResultClick);
  document.getElementById("reader-close").addEventListener("click", closeReader);
  document.getElementById("reader").addEventListener("click", function(e){ if (e.target.id === "reader") closeReader(); });
  document.addEventListener("keydown", function(e){ if (e.key === "Escape") closeReader(); });

  function syncQuery(source){
    var value = source.value;
    if (source !== $q) $q.value = value;
    if (source !== $qSide) $qSide.value = value;
    state.query = value.trim().toLowerCase();
    resetAndRender();
    if (state.query) ensureAllLoaded(resetAndRender);
  }

  var debouncedQuery = debounce(function(source){ syncQuery(source); }, 180);
  $q.addEventListener("input", function(){ debouncedQuery($q); });
  $qSide.addEventListener("input", function(){ debouncedQuery($qSide); });

  document.getElementById("search-submit").addEventListener("click", function(){
    syncQuery($q);
    document.getElementById("all-articles").scrollIntoView({behavior:"smooth"});
  });

  $q.addEventListener("keydown", function(e){
    if (e.key === "Enter"){
      syncQuery($q);
      document.getElementById("all-articles").scrollIntoView({behavior:"smooth"});
    }
  });

  $year.addEventListener("change", function(){
    state.yearFilter = $year.value;
    resetAndRender();
    ensureAllLoaded(resetAndRender);
  });

  $cat.addEventListener("change", function(){
    state.catFilter = $cat.value;
    resetAndRender();
    ensureAllLoaded(resetAndRender);
  });

  $sort.addEventListener("change", function(){
    state.sort = $sort.value;
    resetAndRender();
    if (state.sort !== "newest") ensureAllLoaded(resetAndRender);
  });

  document.getElementById("apply-filters").addEventListener("click", function(){
    state.yearFilter = $year.value;
    state.catFilter = $cat.value;
    state.sort = $sort.value;
    syncQuery($qSide);
    ensureAllLoaded(resetAndRender);
    document.getElementById("all-articles").scrollIntoView({behavior:"smooth"});
  });

  fetch("data/manifest.json")
    .then(function(r){
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    })
    .then(function(manifest){
      state.manifest = manifest;

      manifest.years.forEach(function(y){
        var opt = document.createElement("option");
        opt.value = y.year;
        opt.textContent = y.year;
        $year.appendChild(opt);
      });

      manifest.categories.forEach(function(c){
        var opt = document.createElement("option");
        opt.value = c.code;
        opt.textContent = categoryLabel(c.code) + " (" + c.code + ")";
        $cat.appendChild(opt);
      });

      var generated = manifest.generated || "";
      document.getElementById("stat-total").textContent = formatNumber(manifest.total);
      document.getElementById("stat-updated").textContent = formatDate(generated);
      document.getElementById("stat-categories").textContent = formatNumber(manifest.categories.length);
      document.getElementById("source-updated").textContent = generated ? formatDate(generated) : "—";
      $foot.textContent = "arXiv data · automatic Monday updates · generated " + (generated ? formatDate(generated) : "—");

      var years = manifest.years.map(function(y){ return y.year; });
      var priority = years.slice(0, 3);
      var rest = years.slice(3);

      Promise.all(priority.map(loadYear)).then(function(){
        updateProgress();
        resetAndRender();

        var i = 0;
        function next(){
          if (i >= rest.length){ updateProgress(); return; }
          loadYear(rest[i++]).then(function(){
            updateProgress();
            if (hasFilters()) resetAndRender();
            next();
          });
        }
        next();
      });
    })
    .catch(function(err){
      $list.innerHTML = '<div id="empty">Error loading data: ' + escapeHTML(String(err)) + '</div>';
      $resultCount.textContent = "Unavailable";
    });
})();
