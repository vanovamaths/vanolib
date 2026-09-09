(function(){
  "use strict";

  var state={
    manifest:null,
    all:[],
    loadedYears:new Set(),
    rendered:0,
    chunk:70,
    query:"",
    yearFilter:"",
    catFilter:"",
    sort:"newest",
    selected:null,
    loadingAll:false,
    allLoaded:false
  };

  var $=function(id){return document.getElementById(id);};
  var $list=$("list"),$latest=$("latest-list"),$empty=$("empty"),$q=$("q"),$qSide=$("q-side");
  var $year=$("year"),$cat=$("cat"),$sort=$("sort"),$loadFill=$("loadbar-fill"),$sentinel=$("sentinel");
  var $resultCount=$("result-count"),$foot=$("foot"),$frame=$("detail-frame"),$preview=$("detail-preview"),$previewEmpty=$("preview-empty");

  var CATEGORY_NAMES={
    "math.AG":"Algebraic geometry","math.AT":"Algebraic topology","math.AP":"Analysis of PDEs","math.AC":"Commutative algebra",
    "math.CA":"Classical analysis","math.CO":"Combinatorics","math.CT":"Category theory","math.CV":"Complex variables",
    "math.DG":"Differential geometry","math.DS":"Dynamical systems","math.FA":"Functional analysis","math.GM":"General mathematics",
    "math.GN":"General topology","math.GR":"Group theory","math.GT":"Geometric topology","math.HO":"History and overview",
    "math.KT":"K-theory","math.LO":"Logic","math.MG":"Metric geometry","math.NA":"Numerical analysis","math.NT":"Number theory",
    "math.OA":"Operator algebras","math.OC":"Optimization and control","math.PR":"Probability","math.QA":"Quantum algebra",
    "math.RA":"Rings and algebras","math.RT":"Representation theory","math.SG":"Symplectic geometry","math.SP":"Spectral theory",
    "math.ST":"Statistics theory","math-ph":"Mathematical physics","quant-ph":"Quantum physics"
  };

  function escapeHTML(s){return String(s||"").replace(/[&<>\"]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'\"':"&quot;"}[c];});}
  function debounce(fn,ms){var t;return function(){var a=arguments;clearTimeout(t);t=setTimeout(function(){fn.apply(null,a);},ms);};}
  function categoryName(code){return CATEGORY_NAMES[code]||code||"Mathematics";}
  function formatNumber(n){try{return Number(n||0).toLocaleString("en-CA");}catch(e){return String(n||0);}}
  function formatDate(value){if(!value)return "—";var d=new Date(value);if(isNaN(d.getTime()))return String(value).slice(0,10);return d.toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"});}
  function dateValue(rec){var t=Date.parse(rec.pub||"");if(!isNaN(t))return t;var y=parseInt(rec.year,10);return isNaN(y)?0:y*10000000000;}
  function authorsArray(value){return String(value||"").split(";").map(function(x){return x.trim();}).filter(Boolean);}
  function shortAuthors(value,max){var a=authorsArray(value);max=max||2;if(!a.length)return "Unknown author";return a.length>max?a.slice(0,max).join(", ")+" et al.":a.join(", ");}
  function arxivPdf(id){return "https://arxiv.org/pdf/"+String(id||"");}
  function arxivAbs(id){return "https://arxiv.org/abs/"+String(id||"");}

  function recFromRow(row,year){
    return {id:String(row[0]||""),title:row[1]||"Untitled",authors:row[2]||"",cat:row[3]||"math.GM",pub:row[4]||"",year:String(year),lt:String(row[1]||"").toLowerCase(),la:String(row[2]||"").toLowerCase()};
  }

  function fetchJSON(url){return fetch(url).then(function(r){if(!r.ok)throw new Error("HTTP "+r.status);return r.json();});}

  function loadYear(year){
    year=String(year);
    if(state.loadedYears.has(year))return Promise.resolve();
    state.loadedYears.add(year);
    return fetchJSON("data/"+year+".json").then(function(rows){
      for(var i=0;i<rows.length;i++)state.all.push(recFromRow(rows[i],year));
      updateProgress();
    }).catch(function(err){state.loadedYears.delete(year);updateProgress();console.warn("VanoLib year load failed",year,err);});
  }

  function updateProgress(){
    var total=(state.manifest&&state.manifest.years||[]).length||1;
    var pct=Math.min(100,Math.round(100*state.loadedYears.size/total));
    $loadFill.style.width=pct+"%";
    if(pct>=100)setTimeout(function(){$loadFill.style.width="0%";},500);
  }

  function loadYearsSequential(years){
    var p=Promise.resolve();
    years.forEach(function(year){p=p.then(function(){return loadYear(year);});});
    return p;
  }

  function loadYearsConcurrent(years,concurrency){
    var i=0;
    function worker(){
      if(i>=years.length)return Promise.resolve();
      var year=years[i++];
      return loadYear(year).then(worker);
    }
    var workers=[];
    var n=Math.min(concurrency||4,years.length);
    for(var k=0;k<n;k++)workers.push(worker());
    return Promise.all(workers);
  }

  function ensureAllLoaded(){
    if(!state.manifest||state.loadingAll)return state.loadingPromise||Promise.resolve();
    var missing=(state.manifest.years||[]).map(function(y){return String(y.year);}).filter(function(y){return !state.loadedYears.has(y);});
    if(!missing.length){state.allLoaded=true;return Promise.resolve();}
    state.loadingAll=true;
    $resultCount.textContent="Loading full arXiv archive…";
    state.loadingPromise=loadYearsConcurrent(missing,4).then(function(){
      state.loadingAll=false;
      state.allLoaded=state.loadedYears.size>=(state.manifest.years||[]).length;
      renderLatest();
      renderReset();
    });
    return state.loadingPromise;
  }

  function hasFilters(){return !!(state.query||state.yearFilter||state.catFilter||state.sort!=="newest");}

  function matches(rec){
    if(state.yearFilter&&rec.year!==state.yearFilter)return false;
    if(state.catFilter&&rec.cat!==state.catFilter)return false;
    if(state.query){
      var hay=(rec.lt+" "+rec.la+" "+rec.id.toLowerCase()+" "+rec.cat.toLowerCase()+" "+categoryName(rec.cat).toLowerCase());
      var terms=state.query.split(/\s+/).filter(Boolean);
      for(var i=0;i<terms.length;i++)if(hay.indexOf(terms[i])===-1)return false;
    }
    return true;
  }

  function sortRecords(rows){
    var a=rows.slice();
    if(state.sort==="title")a.sort(function(x,y){return String(x.title).localeCompare(String(y.title));});
    else if(state.sort==="oldest")a.sort(function(x,y){return dateValue(x)-dateValue(y);});
    else a.sort(function(x,y){return dateValue(y)-dateValue(x);});
    return a;
  }

  function currentSet(){
    var base=hasFilters()?state.all.filter(matches):state.all.slice();
    if(state.sort!=="newest"||hasFilters()||state.allLoaded)return sortRecords(base);
    return base;
  }

  function topicPills(rec){
    return '<span class="topic-pill">'+escapeHTML(categoryName(rec.cat))+'</span><span class="topic-pill">'+escapeHTML(rec.cat)+'</span>';
  }

  function latestHTML(rec){
    return '<article class="latest-card" data-id="'+escapeHTML(rec.id)+'">'+
      '<div class="latest-top"><span class="new-label">NEW</span><span>'+escapeHTML(formatDate(rec.pub))+'</span></div>'+
      '<h3>'+escapeHTML(rec.title)+'</h3>'+
      '<div class="latest-authors">'+escapeHTML(shortAuthors(rec.authors,2))+'</div>'+
      '<div class="latest-arxiv">arXiv:'+escapeHTML(rec.id)+'</div>'+
      '<div class="topic-pills">'+topicPills(rec)+'</div>'+
      '<div class="card-actions">'+
        '<button type="button" data-action="details">▤ Abstract</button>'+
        '<button type="button" data-action="pdf">▤ PDF</button>'+
        '<button type="button" data-action="read">Read →</button>'+
      '</div></article>';
  }

  function articleHTML(rec,index){
    return '<article class="article-row" data-id="'+escapeHTML(rec.id)+'">'+
      '<div class="article-index">'+String(index+1).padStart(2,"0")+'</div>'+
      '<div><div class="article-title">'+escapeHTML(rec.title)+'</div><div class="article-authors">'+escapeHTML(shortAuthors(rec.authors,2))+'</div></div>'+
      '<div><div class="article-id">arXiv:'+escapeHTML(rec.id)+'</div><div class="article-authors">['+escapeHTML(rec.cat)+']</div></div>'+
      '<div class="article-category">'+topicPills(rec)+'</div>'+
      '<div class="article-date">'+escapeHTML(formatDate(rec.pub))+'</div>'+
    '</article>';
  }

  function findRec(id){return state.all.find(function(r){return r.id===String(id);});}

  function renderLatest(){
    var recent=state.all.slice();
    recent.sort(function(a,b){return dateValue(b)-dateValue(a);});
    $latest.innerHTML=recent.slice(0,3).map(latestHTML).join("");
  }

  var current=[];
  function renderReset(){
    current=currentSet();
    state.rendered=0;
    $list.innerHTML="";
    $empty.style.display=current.length?"none":"block";
    if(!hasFilters()&&state.manifest)$resultCount.textContent=formatNumber(state.manifest.total)+" papers";
    else $resultCount.textContent=formatNumber(current.length)+" results"+(state.loadingAll?" · loading archive…":"");
    renderMore();
  }

  function renderMore(){
    var end=Math.min(state.rendered+state.chunk,current.length);
    if(end<=state.rendered)return;
    var html="";
    for(var i=state.rendered;i<end;i++)html+=articleHTML(current[i],i);
    $list.insertAdjacentHTML("beforeend",html);
    state.rendered=end;
    markActiveRow();
  }

  var io=new IntersectionObserver(function(entries){entries.forEach(function(e){if(e.isIntersecting&&state.rendered<current.length)renderMore();});},{rootMargin:"700px"});
  io.observe($sentinel);

  function markActiveRow(){
    document.querySelectorAll(".article-row.active").forEach(function(x){x.classList.remove("active");});
    if(!state.selected)return;
    document.querySelectorAll('.article-row[data-id="'+CSS.escape(state.selected.id)+'"]').forEach(function(x){x.classList.add("active");});
  }

  function showTab(name){
    document.querySelectorAll("[data-detail-tab]").forEach(function(b){b.classList.toggle("active",b.getAttribute("data-detail-tab")===name);});
    document.querySelectorAll("[data-detail-view]").forEach(function(v){v.classList.toggle("active",v.getAttribute("data-detail-view")===name);});
    if(name==="preview"&&state.selected)loadSelectedPdf();
  }

  function loadSelectedPdf(){
    if(!state.selected)return;
    var url=arxivPdf(state.selected.id);
    if($frame.getAttribute("src")!==url)$frame.src=url;
    $preview.classList.add("detail-frame-visible");
    $previewEmpty.textContent="Loading arXiv PDF…";
  }

  function selectRec(rec,mode){
    if(!rec)return;
    state.selected=rec;
    $("detail-id").textContent="arXiv:"+rec.id;
    $("detail-title").textContent=rec.title;
    $("detail-authors").textContent=authorsArray(rec.authors).join(", ")||"Unknown author";
    $("detail-tags").innerHTML=topicPills(rec);
    $("detail-meta").textContent="arXiv:"+rec.id+"   ["+rec.cat+"]   "+formatDate(rec.pub);
    $("detail-category").textContent=categoryName(rec.cat)+" ("+rec.cat+")";
    $("detail-date").textContent=formatDate(rec.pub);
    $("detail-identifier").textContent=rec.id;
    $("detail-read").disabled=false;
    $("detail-arxiv").href=arxivAbs(rec.id);
    $("detail-pdf-link").href=arxivPdf(rec.id);
    markActiveRow();
    if(mode==="details")showTab("details");else showTab("preview");
    if(window.innerWidth<1050)$("detail-panel").scrollIntoView({behavior:"smooth",block:"start"});
  }

  function clearDetail(){
    state.selected=null;
    $frame.src="";
    $preview.classList.remove("detail-frame-visible");
    $("detail-id").textContent="arXiv";
    $("detail-title").textContent="Select an article";
    $("detail-authors").textContent="Choose a paper to preview it inside VanoLib.";
    $("detail-tags").innerHTML="";
    $("detail-meta").textContent="";
    $("detail-read").disabled=true;
    $("detail-arxiv").href="https://arxiv.org/";
    $("detail-pdf-link").href="https://arxiv.org/";
    $("detail-category").textContent="—";$("detail-date").textContent="—";$("detail-identifier").textContent="—";
    $previewEmpty.textContent="Select a paper to load its arXiv PDF preview.";
    showTab("preview");
    markActiveRow();
  }

  $latest.addEventListener("click",function(e){
    var card=e.target.closest("[data-id]");if(!card)return;
    var rec=findRec(card.getAttribute("data-id"));if(!rec)return;
    var action=e.target.closest("button[data-action]");
    if(action){var a=action.getAttribute("data-action");selectRec(rec,a==="details"?"details":"preview");}
    else selectRec(rec,"preview");
  });

  $list.addEventListener("click",function(e){var row=e.target.closest("[data-id]");if(!row)return;selectRec(findRec(row.getAttribute("data-id")),"preview");});
  $("detail-read").addEventListener("click",function(){if(state.selected)showTab("preview");});
  $("detail-close").addEventListener("click",clearDetail);
  document.querySelectorAll("[data-detail-tab]").forEach(function(btn){btn.addEventListener("click",function(){showTab(btn.getAttribute("data-detail-tab"));});});

  function syncQuery(value){value=String(value||"");$q.value=value;$qSide.value=value;state.query=value.trim().toLowerCase();}

  function applyFilters(){
    syncQuery($qSide.value||$q.value);
    state.yearFilter=$year.value;
    state.catFilter=$cat.value;
    state.sort=$sort.value;
    renderReset();
    var needsAll=!!(state.query||state.catFilter||state.sort!=="newest");
    if(state.yearFilter){
      loadYear(state.yearFilter).then(function(){renderLatest();renderReset();});
    }else if(needsAll){
      ensureAllLoaded();
    }
  }

  var liveSearch=debounce(function(value){syncQuery(value);renderReset();if(state.query)ensureAllLoaded();},220);
  $q.addEventListener("input",function(){liveSearch($q.value);});
  $qSide.addEventListener("input",function(){liveSearch($qSide.value);});
  $q.addEventListener("keydown",function(e){if(e.key==="Enter"){syncQuery($q.value);applyFilters();$("all-articles").scrollIntoView({behavior:"smooth"});}});
  $qSide.addEventListener("keydown",function(e){if(e.key==="Enter")applyFilters();});
  $("search-submit").addEventListener("click",function(){syncQuery($q.value);applyFilters();$("all-articles").scrollIntoView({behavior:"smooth"});});
  $("apply-filters").addEventListener("click",applyFilters);
  [$year,$cat,$sort].forEach(function(el){el.addEventListener("change",applyFilters);});
  $("clear-filters").addEventListener("click",function(){syncQuery("");$year.value="";$cat.value="";$sort.value="newest";state.yearFilter="";state.catFilter="";state.sort="newest";renderReset();});

  fetchJSON("data/manifest.json").then(function(manifest){
    state.manifest=manifest;
    (manifest.years||[]).forEach(function(y){var opt=document.createElement("option");opt.value=String(y.year);opt.textContent=String(y.year);$year.appendChild(opt);});
    (manifest.categories||[]).forEach(function(c){var opt=document.createElement("option");opt.value=c.code;opt.textContent=categoryName(c.code)+" ("+c.code+")";$cat.appendChild(opt);});

    $("stat-total").textContent=formatNumber(manifest.total);
    $("stat-updated").textContent=formatDate(manifest.generated);
    $("stat-categories").textContent=formatNumber((manifest.categories||[]).length);
    $("source-updated").textContent=formatDate(manifest.generated);
    $foot.textContent="Local arXiv index · "+formatNumber(manifest.total)+" references · generated "+formatDate(manifest.generated)+".";

    var years=(manifest.years||[]).map(function(y){return String(y.year);});
    var priority=years.slice(0,3),rest=years.slice(3);
    return loadYearsSequential(priority).then(function(){
      renderLatest();renderReset();
      var i=0;
      function next(){
        if(i>=rest.length){state.allLoaded=true;updateProgress();return;}
        loadYear(rest[i++]).then(function(){
          if(hasFilters())renderReset();
          next();
        });
      }
      next();
    });
  }).catch(function(err){
    console.error(err);
    $list.innerHTML='<div id="empty">Unable to load the VanoLib arXiv index.</div>';
    $resultCount.textContent="Unavailable";
  });
})();
