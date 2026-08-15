(function(){
  "use strict";

  // --- Theme ---
  var THEME_KEY = "vanolib_theme";
  var themeBtn = document.getElementById("theme-toggle");
  function applyTheme(t){
    document.documentElement.setAttribute("data-theme", t);
    themeBtn.textContent = t === "dark" ? "☀️" : "🌙";
    localStorage.setItem(THEME_KEY, t);
  }
  applyTheme(localStorage.getItem(THEME_KEY) || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
  themeBtn.addEventListener("click", function(){
    var cur = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
    applyTheme(cur);
  });

  var state = {
    manifest: null,
    all: [],
    loadedYears: new Set(),
    rendered: 0,
    chunk: 60,
    query: "",
    yearFilter: "",
    catFilter: "",
    toRead: new Set(JSON.parse(localStorage.getItem("vanolib_toread") || "[]")),
  };

  var $list = document.getElementById("list");
  var $empty = document.getElementById("empty");
  var $q = document.getElementById("q");
  var $year = document.getElementById("year");
  var $cat = document.getElementById("cat");
  var $loadFill = document.getElementById("loadbar-fill");
  var $sentinel = document.getElementById("sentinel");
  var $foot = document.getElementById("foot");

  function debounce(fn, ms){
    var t;
    return function(){
      clearTimeout(t);
      var args = arguments;
      t = setTimeout(function(){ fn.apply(null, args); }, ms);
    };
  }

  function recFromRow(row, year){
    return {
      id: row[0], title: row[1], authors: row[2], cat: row[3], pub: row[4],
      year: year, lt: (row[1] || "").toLowerCase(), la: (row[2] || "").toLowerCase(),
    };
  }

  function loadYear(year){
    if (state.loadedYears.has(year)) return Promise.resolve();
    state.loadedYears.add(year);
    return fetch("data/" + year + ".json").then(function(r){ return r.json(); }).then(function(rows){
      for (var i=0;i<rows.length;i++) state.all.push(recFromRow(rows[i], year));
    }).catch(function(err){ console.warn("year load failed", year, err); });
  }

  function updateProgress(){
    var doneCount = state.loadedYears.size;
    var totalCount = (state.manifest && state.manifest.years.length) || 1;
    var pct = Math.round(100 * doneCount / totalCount);
    $loadFill.style.width = pct + "%";
    if (pct >= 100) { setTimeout(function(){ $loadFill.style.width = "0%"; }, 500); }
  }

  function matches(rec){
    if (state.yearFilter && rec.year !== state.yearFilter) return false;
    if (state.catFilter && rec.cat !== state.catFilter) return false;
    if (state.query){
      if (rec.lt.indexOf(state.query) === -1 && rec.la.indexOf(state.query) === -1) return false;
    }
    return true;
  }

  function currentSet(){
    if (!state.query && !state.yearFilter && !state.catFilter) return state.all;
    return state.all.filter(matches);
  }

  function cardHTML(rec){
    var isTR = state.toRead.has(rec.id);
    var authors = rec.authors.split(";")[0].trim();
    if (rec.authors.indexOf(";") !== -1) authors += " et al.";
    return '<div class="card' + (isTR ? " toread" : "") + '" data-id="' + rec.id + '">' +
      '<div class="title">' + escapeHTML(rec.title || "(untitled)") + '</div>' +
      '<div class="meta">' + escapeHTML(authors) + '   ·   ' + rec.pub + '<span class="cat">' + escapeHTML(rec.cat) + '</span></div>' +
      '</div>';
  }

  function escapeHTML(s){
    return (s || "").replace(/[&<>"]/g, function(c){
      return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c];
    });
  }

  var currentResults = [];

  function resetAndRender(){
    currentResults = currentSet();
    $list.innerHTML = "";
    state.rendered = 0;
    $empty.style.display = currentResults.length === 0 ? "block" : "none";
    renderMore();
  }

  function renderMore(){
    var end = Math.min(state.rendered + state.chunk, currentResults.length);
    var html = "";
    for (var i = state.rendered; i < end; i++){
      html += cardHTML(currentResults[i]);
    }
    requestAnimationFrame(function(){
      $list.insertAdjacentHTML("beforeend", html);
    });
    state.rendered = end;
  }

  var io = new IntersectionObserver(function(entries){
    entries.forEach(function(e){
      if (e.isIntersecting && state.rendered < currentResults.length){
        renderMore();
      }
    });
  }, { rootMargin: "800px" });
  io.observe($sentinel);

  $list.addEventListener("click", function(e){
    var card = e.target.closest(".card");
    if (!card) return;
    openReader(card.getAttribute("data-id"));
  });

  function openReader(id){
    var rec = state.all.find(function(r){ return r.id === id; });
    var reader = document.getElementById("reader");
    document.getElementById("reader-title").textContent = rec ? rec.title : id;
    document.getElementById("reader-abs-link").href = "https://arxiv.org/abs/" + id;
    document.getElementById("reader-pdf-link").href = "https://arxiv.org/pdf/" + id;
    document.getElementById("reader-frame").src = "https://arxiv.org/pdf/" + id;
    reader.classList.add("open");
  }
  function closeReader(){
    document.getElementById("reader").classList.remove("open");
    setTimeout(function(){ document.getElementById("reader-frame").src = ""; }, 200);
  }
  document.getElementById("reader-close").addEventListener("click", closeReader);
  document.getElementById("reader").addEventListener("click", function(e){
    if (e.target.id === "reader") closeReader();
  });
  document.addEventListener("keydown", function(e){
    if (e.key === "Escape") closeReader();
  });

  $q.addEventListener("input", debounce(function(){
    state.query = $q.value.trim().toLowerCase();
    resetAndRender();
  }, 180));
  $year.addEventListener("change", function(){
    state.yearFilter = $year.value;
    resetAndRender();
  });
  $cat.addEventListener("change", function(){
    state.catFilter = $cat.value;
    resetAndRender();
  });

  fetch("data/manifest.json").then(function(r){ return r.json(); }).then(function(manifest){
    state.manifest = manifest;
    manifest.years.forEach(function(y){
      var opt = document.createElement("option");
      opt.value = y.year; opt.textContent = y.year;
      $year.appendChild(opt);
    });
    manifest.categories.forEach(function(c){
      var opt = document.createElement("option");
      opt.value = c.code; opt.textContent = c.code;
      $cat.appendChild(opt);
    });
    $foot.textContent = "arXiv data — auto-updated every Monday. Last generated: " + (manifest.generated || "—");

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
          if (state.query || state.yearFilter || state.catFilter){
            resetAndRender();
          }
          next();
        });
      }
      next();
    });
  }).catch(function(err){
    $list.innerHTML = '<div id="empty">Error loading data: ' + escapeHTML(String(err)) + '</div>';
  });
})();
