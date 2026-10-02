(function(){
  "use strict";

  var state={
    manifest:null,
    rows:[],
    scope:"latest",
    query:"",
    category:"",
    sort:"newest",
    rendered:0,
    chunk:70,
    selected:null,
    requestToken:0
  };

  var names={
    "math.AC":"Commutative algebra","math.AG":"Algebraic geometry","math.AP":"Analysis of PDEs",
    "math.AT":"Algebraic topology","math.CA":"Classical analysis","math.CO":"Combinatorics",
    "math.CT":"Category theory","math.CV":"Complex variables","math.DG":"Differential geometry",
    "math.DS":"Dynamical systems","math.FA":"Functional analysis","math.GM":"General mathematics",
    "math.GN":"General topology","math.GR":"Group theory","math.GT":"Geometric topology",
    "math.HO":"History and overview","math.KT":"K-theory","math.LO":"Logic",
    "math.MG":"Metric geometry","math.MP":"Mathematical physics","math.NA":"Numerical analysis",
    "math.NT":"Number theory","math.OA":"Operator algebras","math.OC":"Optimization and control",
    "math.PR":"Probability","math.QA":"Quantum algebra","math.RA":"Rings and algebras",
    "math.RT":"Representation theory","math.SG":"Symplectic geometry","math.SP":"Spectral theory",
    "math.ST":"Statistics theory","math-ph":"Mathematical physics"
  };

  function $(id){return document.getElementById(id);}
  var list=$("list"), q=$("q"), year=$("year"), cat=$("cat"), sort=$("sort"), sentinel=$("sentinel");
  var visible=[];

  function esc(value){
    return String(value == null ? "" : value).replace(/[&<>"]/g,function(c){
      return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c];
    });
  }

  function categoryName(code){return names[code] || code || "Mathematics";}
  function number(value){return Number(value || 0).toLocaleString("en-US");}

  function formatDate(value){
    if(!value)return "—";
    var d=new Date(value+"T00:00:00Z");
    return isNaN(d.getTime()) ? String(value).slice(0,10) :
      d.toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"});
  }

  function authors(value){
    return String(value || "").split(";").map(function(x){return x.trim();}).filter(Boolean);
  }

  function shortAuthors(value){
    var a=authors(value);
    if(!a.length)return "Unknown author";
    return a.length>3 ? a.slice(0,3).join(", ")+" et al." : a.join(", ");
  }

  function baseId(id){return String(id || "").replace(/v\d+$/,"");}
  function pdfUrl(id){return "https://arxiv.org/pdf/"+encodeURIComponent(id);}
  function absUrl(id){return "https://arxiv.org/abs/"+encodeURIComponent(id);}

  function scholarUrl(rec){
    return "https://scholar.google.com/scholar?q="+encodeURIComponent('"'+rec.title+'"');
  }

  function fetchJSON(url){
    return fetch(url,{cache:"no-store"}).then(function(r){
      if(!r.ok)throw new Error("HTTP "+r.status+" for "+url);
      return r.json();
    });
  }

  function toRecord(row){
    var pub=String(row[4] || "");
    return {
      id:String(row[0] || ""),
      title:String(row[1] || "Untitled"),
      authors:String(row[2] || ""),
      cat:String(row[3] || "math.GM"),
      pub:pub,
      year:pub.slice(0,4),
      search:(String(row[0] || "")+" "+String(row[1] || "")+" "+String(row[2] || "")+" "+String(row[3] || "")).toLowerCase()
    };
  }

  function setLoading(on){
    $("loadbar-fill").style.width=on ? "42%" : "0";
    document.body.classList.toggle("is-loading",on);
  }

  function loadScope(scope){
    state.scope=scope || "latest";
    var token=++state.requestToken;
    setLoading(true);
    $("scope-label").textContent=state.scope==="latest" ? "Latest papers" : "Papers from "+state.scope;

    var primary=state.scope==="latest" ? "data/latest.json" : "data/"+state.scope+".json";
    var fallback=state.scope==="latest" && state.manifest && state.manifest.years && state.manifest.years[0]
      ? "data/"+state.manifest.years[0].year+".json" : null;

    return fetchJSON(primary).catch(function(err){
      if(!fallback)throw err;
      console.warn("latest.json unavailable, using newest yearly shard",err);
      return fetchJSON(fallback).then(function(rows){return rows.slice(0,1200);});
    }).then(function(rows){
      if(token!==state.requestToken)return;
      state.rows=rows.map(toRecord);
      setLoading(false);
      reset();
    }).catch(function(err){
      if(token!==state.requestToken)return;
      console.error(err);
      setLoading(false);
      state.rows=[];
      reset();
      $("archive-status").textContent="Index unavailable";
    });
  }

  function dateValue(rec){
    var t=Date.parse(rec.pub+"T00:00:00Z");
    return isNaN(t) ? 0 : t;
  }

  function matches(rec){
    if(state.category && rec.cat!==state.category)return false;
    if(state.query){
      var hay=(rec.search+" "+categoryName(rec.cat)).toLowerCase();
      var terms=state.query.split(/\s+/).filter(Boolean);
      for(var i=0;i<terms.length;i++){
        if(hay.indexOf(terms[i])<0)return false;
      }
    }
    return true;
  }

  function current(){
    var rows=state.rows.filter(matches);
    rows.sort(function(a,b){
      if(state.sort==="title")return a.title.localeCompare(b.title);
      if(state.sort==="oldest")return dateValue(a)-dateValue(b);
      return dateValue(b)-dateValue(a);
    });
    return rows;
  }

  function rowHTML(rec){
    return '<article class="paper-row" data-id="'+esc(rec.id)+'" tabindex="0">'+
      '<div class="paper-main">'+
        '<strong class="paper-title">'+esc(rec.title)+'</strong>'+
        '<span class="paper-authors">'+esc(shortAuthors(rec.authors))+'</span>'+
      '</div>'+
      '<div class="paper-category"><span>'+esc(rec.cat)+'</span><small>'+esc(categoryName(rec.cat))+'</small></div>'+
      '<time class="paper-date">'+esc(formatDate(rec.pub))+'</time>'+
      '<button class="read-button" type="button" aria-label="Open '+esc(rec.title)+'">Read →</button>'+
    '</article>';
  }

  function reset(){
    visible=current();
    state.rendered=0;
    list.innerHTML="";
    $("empty").hidden=visible.length>0;
    $("result-count").textContent=number(visible.length)+" papers";
    renderMore();
    markSelected();
  }

  function renderMore(){
    var end=Math.min(state.rendered+state.chunk,visible.length);
    if(end<=state.rendered)return;
    var html="";
    for(var i=state.rendered;i<end;i++)html+=rowHTML(visible[i]);
    list.insertAdjacentHTML("beforeend",html);
    state.rendered=end;
  }

  function find(id){
    for(var i=0;i<state.rows.length;i++){
      if(state.rows[i].id===String(id))return state.rows[i];
    }
    return null;
  }

  function markSelected(){
    document.querySelectorAll(".paper-row.active").forEach(function(el){el.classList.remove("active");});
    if(!state.selected)return;
    document.querySelectorAll(".paper-row").forEach(function(el){
      if(el.dataset.id===state.selected.id)el.classList.add("active");
    });
  }

  function apaCitation(rec){
    var a=authors(rec.authors);
    var authorText=a.length ? a.join(", ") : "Unknown author";
    return authorText+" ("+(rec.year || "n.d.")+"). "+rec.title+". arXiv. https://arxiv.org/abs/"+baseId(rec.id);
  }

  function bibtexKey(rec){
    var a=authors(rec.authors);
    var surname=(a[0] || "unknown").split(/\s+/).slice(-1)[0].replace(/[^A-Za-z0-9]/g,"") || "unknown";
    var word=(rec.title.match(/[A-Za-z0-9]+/) || ["paper"])[0];
    return (surname+rec.year+word).replace(/[^A-Za-z0-9]/g,"");
  }

  function bibtexCitation(rec){
    var a=authors(rec.authors).join(" and ");
    return "@article{"+bibtexKey(rec)+",\n"+
      "  title = {"+rec.title.replace(/[{}]/g,"")+"},\n"+
      "  author = {"+a.replace(/[{}]/g,"")+"},\n"+
      "  year = {"+(rec.year || "")+"},\n"+
      "  eprint = {"+baseId(rec.id)+"},\n"+
      "  archivePrefix = {arXiv},\n"+
      "  primaryClass = {"+rec.cat+"},\n"+
      "  url = {https://arxiv.org/abs/"+baseId(rec.id)+"}\n"+
      "}";
  }

  function showTab(name){
    document.querySelectorAll("[data-tab]").forEach(function(button){
      button.classList.toggle("active",button.dataset.tab===name);
    });
    document.querySelectorAll("[data-view]").forEach(function(view){
      view.classList.toggle("active",view.dataset.view===name);
    });
  }

  function openReader(rec){
    if(!rec)return;
    state.selected=rec;
    $("reading-workspace").classList.add("reader-open");
    $("detail-title").textContent=rec.title;
    $("detail-authors").textContent=authors(rec.authors).join(", ") || "Unknown author";
    $("detail-id").textContent=rec.id;
    $("detail-category").textContent=categoryName(rec.cat)+" ("+rec.cat+")";
    $("detail-date").textContent=formatDate(rec.pub);
    $("detail-authors-full").textContent=authors(rec.authors).join(", ") || "Unknown author";
    $("detail-arxiv").href=absUrl(rec.id);
    $("detail-download").href=pdfUrl(rec.id);
    $("detail-scholar").href=scholarUrl(rec);
    $("citation-apa").textContent=apaCitation(rec);
    $("citation-bibtex").textContent=bibtexCitation(rec);

    var frame=$("detail-frame");
    frame.src=pdfUrl(rec.id)+"#view=FitH";
    $("pdf-view").classList.add("has-pdf");
    showTab("pdf");
    markSelected();

    if(window.innerWidth<980){
      $("reader-panel").scrollIntoView({behavior:"smooth",block:"start"});
    }
  }

  function closeReader(){
    state.selected=null;
    $("reading-workspace").classList.remove("reader-open");
    $("detail-frame").src="";
    $("pdf-view").classList.remove("has-pdf");
    markSelected();
  }

  function applyFilters(){
    state.query=q.value.trim().toLowerCase();
    state.category=cat.value;
    state.sort=sort.value;
    reset();
  }

  function copyCitation(kind,button){
    if(!state.selected)return;
    var text=kind==="bibtex" ? bibtexCitation(state.selected) : apaCitation(state.selected);
    navigator.clipboard.writeText(text).then(function(){
      var old=button.textContent;
      button.textContent="Copied";
      setTimeout(function(){button.textContent=old;},1100);
    }).catch(function(){
      window.prompt("Copy citation:",text);
    });
  }

  var timer;
  q.addEventListener("input",function(){
    clearTimeout(timer);
    timer=setTimeout(applyFilters,160);
  });

  $("search-form").addEventListener("submit",function(e){
    e.preventDefault();
    applyFilters();
  });

  cat.addEventListener("change",applyFilters);
  sort.addEventListener("change",applyFilters);
  year.addEventListener("change",function(){
    closeReader();
    loadScope(year.value || "latest");
  });

  $("clear-filters").addEventListener("click",function(){
    q.value="";
    cat.value="";
    sort.value="newest";
    applyFilters();
  });

  list.addEventListener("click",function(e){
    var row=e.target.closest("[data-id]");
    if(row)openReader(find(row.dataset.id));
  });

  list.addEventListener("keydown",function(e){
    var row=e.target.closest("[data-id]");
    if(row && (e.key==="Enter" || e.key===" ")){
      e.preventDefault();
      openReader(find(row.dataset.id));
    }
  });

  $("detail-close").addEventListener("click",closeReader);

  document.querySelectorAll("[data-tab]").forEach(function(button){
    button.addEventListener("click",function(){showTab(button.dataset.tab);});
  });

  document.querySelectorAll("[data-copy]").forEach(function(button){
    button.addEventListener("click",function(){copyCitation(button.dataset.copy,button);});
  });

  new IntersectionObserver(function(entries){
    if(entries[0].isIntersecting)renderMore();
  },{rootMargin:"700px"}).observe(sentinel);

  document.addEventListener("keydown",function(e){
    if(e.key==="Escape" && state.selected)closeReader();
    if(e.key==="/" && document.activeElement!==q){
      e.preventDefault();
      q.focus();
    }
  });

  fetchJSON("data/manifest.json").then(function(manifest){
    state.manifest=manifest;

    (manifest.years || []).forEach(function(item){
      var option=document.createElement("option");
      option.value=String(item.year);
      option.textContent=String(item.year)+" · "+number(item.count);
      year.appendChild(option);
    });

    (manifest.categories || []).forEach(function(item){
      var option=document.createElement("option");
      option.value=item.code;
      option.textContent=categoryName(item.code)+" · "+number(item.count);
      cat.appendChild(option);
    });

    var fresh=manifest.latest_date ? "latest "+formatDate(manifest.latest_date) : "updated "+formatDate(String(manifest.generated || "").slice(0,10));
    $("archive-status").textContent=number(manifest.total)+" papers · "+fresh;
    $("foot").textContent=number(manifest.total)+" references · weekly automatic update.";

    return loadScope("latest");
  }).catch(function(err){
    console.error(err);
    $("archive-status").textContent="Index unavailable";
    $("result-count").textContent="Unavailable";
    $("empty").hidden=false;
    $("empty").textContent="Unable to load the VanoLib index.";
  });
})();
