(function(){
  "use strict";

  var state = {
    manifest:null,
    local:[],
    remote:[],
    loadedYears:new Set(),
    rendered:0,
    chunk:70,
    query:"",
    yearFilter:"",
    catFilter:"",
    docType:"",
    source:"all",
    sort:"newest",
    requestToken:0
  };

  var $ = function(id){ return document.getElementById(id); };
  var $list=$("list"), $latest=$("latest-list"), $empty=$("empty"), $q=$("q"), $qSide=$("q-side");
  var $year=$("year"), $cat=$("cat"), $sort=$("sort"), $docType=$("doc-type"), $source=$("source-select");
  var $loadFill=$("loadbar-fill"), $sentinel=$("sentinel"), $foot=$("foot"), $resultCount=$("result-count"), $remoteStatus=$("remote-status");
  var $detail=$("detail-panel"), $detailFrame=$("detail-frame");

  var CATEGORY_NAMES={
    "math.AG":"Algebraic geometry","math.AT":"Algebraic topology","math.AP":"Analysis of PDEs","math.AC":"Commutative algebra","math.CA":"Classical analysis","math.CO":"Combinatorics","math.CT":"Category theory","math.CV":"Complex variables","math.DG":"Differential geometry","math.DS":"Dynamical systems","math.FA":"Functional analysis","math.GM":"General mathematics","math.GN":"General topology","math.GR":"Group theory","math.GT":"Geometric topology","math.HO":"History and overview","math.KT":"K-theory","math.LO":"Logic","math.MG":"Metric geometry","math.NA":"Numerical analysis","math.NT":"Number theory","math.OA":"Operator algebras","math.OC":"Optimization and control","math.PR":"Probability","math.QA":"Quantum algebra","math.RA":"Rings and algebras","math.RT":"Representation theory","math.SG":"Symplectic geometry","math.SP":"Spectral theory","math.ST":"Statistics theory","math-ph":"Mathematical physics","quant-ph":"Quantum physics"
  };

  function escapeHTML(s){ return String(s||"").replace(/[&<>\"]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'\"':"&quot;"}[c];}); }
  function debounce(fn,ms){ var t; return function(){ var a=arguments; clearTimeout(t); t=setTimeout(function(){fn.apply(null,a);},ms); }; }
  function shortAuthors(s){ var a=String(s||"").split(";").map(function(x){return x.trim();}).filter(Boolean); return a.length>3?a.slice(0,3).join(", ")+" et al.":a.join(", "); }
  function niceDate(s){ if(!s)return "—"; var d=new Date(s); if(isNaN(d))return s; return d.toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"}); }
  function categoryName(code){ return CATEGORY_NAMES[code]||code||"Mathematics"; }

  function localRec(row,year){ return {source:"arxiv",id:row[0],title:row[1],authors:row[2],cat:row[3],pub:row[4],year:year,type:"preprint",abstract:"",landing:"https://arxiv.org/abs/"+row[0],pdf:"https://arxiv.org/pdf/"+row[0],lt:String(row[1]||"").toLowerCase(),la:String(row[2]||"").toLowerCase()}; }

  function loadYear(year){
    if(state.loadedYears.has(year)) return Promise.resolve();
    state.loadedYears.add(year);
    return fetch("data/"+year+".json").then(function(r){ if(!r.ok)throw new Error(r.status); return r.json(); }).then(function(rows){
      rows.forEach(function(row){ state.local.push(localRec(row,year)); });
      updateProgress();
    }).catch(function(err){ console.warn("year load failed",year,err); });
  }

  function ensureAllLoaded(){
    if(!state.manifest)return Promise.resolve();
    var missing=state.manifest.years.map(function(y){return y.year;}).filter(function(y){return !state.loadedYears.has(y);});
    return Promise.all(missing.map(loadYear));
  }

  function updateProgress(){
    var total=state.manifest?state.manifest.years.length:1;
    var pct=Math.round(100*state.loadedYears.size/total);
    $loadFill.style.width=pct+"%";
    if(pct>=100)setTimeout(function(){ $loadFill.style.width="0%"; },500);
  }

  function matchesLocal(rec){
    if(state.yearFilter&&rec.year!==state.yearFilter)return false;
    if(state.catFilter&&rec.cat!==state.catFilter)return false;
    if(state.docType&&state.docType!=="article"&&state.docType!=="preprint")return false;
    if(state.query&&rec.lt.indexOf(state.query)===-1&&rec.la.indexOf(state.query)===-1)return false;
    return true;
  }

  function sortRecords(arr){
    var a=arr.slice();
    if(state.sort==="title")a.sort(function(x,y){return String(x.title).localeCompare(String(y.title));});
    else if(state.sort==="oldest")a.sort(function(x,y){return String(x.pub).localeCompare(String(y.pub));});
    else a.sort(function(x,y){return String(y.pub).localeCompare(String(x.pub));});
    return a;
  }

  function currentSet(){
    var local=(state.source==="openalex")?[]:state.local.filter(matchesLocal);
    var remote=(state.source==="arxiv")?[]:state.remote;
    return sortRecords(local.concat(remote));
  }

  function openAlexType(type){
    if(type==="book"||type==="book-chapter")return "book";
    if(type==="dissertation")return "thesis";
    if(type==="preprint")return "preprint";
    return "article";
  }

  function invertedAbstract(inv){
    if(!inv)return "";
    var words=[];
    Object.keys(inv).forEach(function(w){ inv[w].forEach(function(pos){ words[pos]=w; }); });
    return words.join(" ").replace(/\s+/g," ").trim();
  }

  function openAlexRec(w){
    var best=w.best_oa_location||w.primary_location||{};
    var source=best.source||{};
    var authors=(w.authorships||[]).map(function(a){return a.author&&a.author.display_name;}).filter(Boolean).join("; ");
    var topic=(w.primary_topic&&w.primary_topic.display_name)||((w.topics&&w.topics[0]&&w.topics[0].display_name)||"Open access");
    return {
      source:"openalex",id:w.id||"",title:w.title||w.display_name||"Untitled",authors:authors,cat:topic,pub:w.publication_date||String(w.publication_year||""),year:String(w.publication_year||""),type:openAlexType(w.type),abstract:invertedAbstract(w.abstract_inverted_index),landing:best.landing_page_url||w.doi||w.id||"",pdf:best.pdf_url||"",venue:source.display_name||"",lt:String(w.title||"").toLowerCase(),la:authors.toLowerCase()
    };
  }

  function fetchOpenAlex(){
    var token=++state.requestToken;
    state.remote=[];
    if(state.source==="arxiv"||!state.query){ $remoteStatus.textContent=""; renderReset(); return Promise.resolve(); }
    $remoteStatus.textContent="Searching OpenAlex…";
    var url="https://api.openalex.org/works?search="+encodeURIComponent(state.query)+"&filter=is_oa:true&per-page=35";
    return fetch(url,{headers:{"Accept":"application/json"}}).then(function(r){ if(!r.ok)throw new Error("OpenAlex "+r.status); return r.json(); }).then(function(data){
      if(token!==state.requestToken)return;
      var rows=(data.results||[]).map(openAlexRec);
      if(state.yearFilter)rows=rows.filter(function(r){return r.year===state.yearFilter;});
      if(state.docType)rows=rows.filter(function(r){return r.type===state.docType;});
      state.remote=rows;
      $remoteStatus.textContent=rows.length?rows.length+" OpenAlex matches":"No OpenAlex matches";
      renderReset();
    }).catch(function(err){
      if(token!==state.requestToken)return;
      console.warn(err); state.remote=[]; $remoteStatus.textContent="OpenAlex temporarily unavailable"; renderReset();
    });
  }

  function sourceBadge(rec){ return '<span class="article-source '+(rec.source==="openalex"?"openalex":"")+'">'+(rec.source==="openalex"?"OpenAlex":"arXiv")+'</span>'; }

  function actionLinks(rec,compact){
    var out=[];
    if(rec.landing)out.push('<a href="'+escapeHTML(rec.landing)+'" target="_blank" rel="noopener">'+(rec.source==="arxiv"?"Abstract":"Record")+'</a>');
    if(rec.pdf)out.push('<a href="'+escapeHTML(rec.pdf)+'" target="_blank" rel="noopener">PDF</a>');
    out.push('<button type="button" class="inspect-btn">'+(compact?"Read":"Preview")+'</button>');
    return out.join("");
  }

  function latestHTML(rec){
    return '<article class="latest-card" data-key="'+escapeHTML(rec.source+"|"+rec.id)+'">'+
      '<div class="latest-top"><span class="new-label">NEW</span><span>'+escapeHTML(niceDate(rec.pub))+'</span></div>'+sourceBadge(rec)+
      '<h3>'+escapeHTML(rec.title)+'</h3><div class="latest-authors">'+escapeHTML(shortAuthors(rec.authors))+'</div><div class="latest-arxiv">'+escapeHTML(rec.source==="arxiv"?"arXiv:"+rec.id:rec.venue||"Open access")+'</div>'+ 
      '<div class="topic-pills"><span class="topic-pill">'+escapeHTML(categoryName(rec.cat))+'</span></div><div class="card-actions">'+actionLinks(rec,true)+'</div></article>';
  }

  function rowHTML(rec,index){
    var abs=rec.abstract?escapeHTML(rec.abstract.slice(0,190))+(rec.abstract.length>190?"…":""):"";
    return '<article class="article-row '+(rec.source==="openalex"?"remote-row":"")+'" data-key="'+escapeHTML(rec.source+"|"+rec.id)+'">'+
      '<div class="article-index">'+String(index+1).padStart(2,"0")+'</div><div><div class="article-source-row">'+sourceBadge(rec)+'<span class="article-meta">'+escapeHTML(niceDate(rec.pub))+'</span></div>'+ 
      '<div class="article-title">'+escapeHTML(rec.title)+'</div><div class="article-authors">'+escapeHTML(shortAuthors(rec.authors))+'</div>'+ 
      '<div class="article-meta">'+escapeHTML(rec.source==="arxiv"?"arXiv:"+rec.id+" · "+categoryName(rec.cat):(rec.venue||categoryName(rec.cat)))+'</div>'+ 
      (abs?'<div class="article-abstract">'+abs+'</div>':'')+'<div class="article-actions">'+actionLinks(rec,false)+'</div></div></article>';
  }

  var current=[];
  function renderLatest(){
    var rows=sortRecords(state.local).slice(0,3);
    $latest.innerHTML=rows.map(latestHTML).join("");
  }
  function renderReset(){
    current=currentSet(); state.rendered=0; $list.innerHTML=""; $empty.style.display=current.length?"none":"block"; $resultCount.textContent=current.length.toLocaleString()+" results"; renderMore();
  }
  function renderMore(){
    var end=Math.min(state.rendered+state.chunk,current.length),html="";
    for(var i=state.rendered;i<end;i++)html+=rowHTML(current[i],i);
    $list.insertAdjacentHTML("beforeend",html); state.rendered=end;
  }

  var io=new IntersectionObserver(function(entries){ entries.forEach(function(e){ if(e.isIntersecting&&state.rendered<current.length)renderMore(); }); },{rootMargin:"700px"});
  io.observe($sentinel);

  function findByKey(key){
    var p=String(key||"").split("|");
    var pool=p[0]==="openalex"?state.remote:state.local;
    return pool.find(function(r){return r.id===p.slice(1).join("|");});
  }
  function showDetail(rec){
    if(!rec)return;
    document.querySelectorAll(".article-row.active").forEach(function(x){x.classList.remove("active");});
    var key=rec.source+"|"+rec.id;
    document.querySelectorAll(".article-row").forEach(function(x){ if(x.getAttribute("data-key")===key)x.classList.add("active"); });
    $("detail-source").textContent=rec.source==="openalex"?"OpenAlex":"arXiv";
    $("detail-source").style.background=rec.source==="openalex"?"var(--blue)":"var(--rust)";
    $("detail-title").textContent=rec.title;
    $("detail-meta").textContent=shortAuthors(rec.authors)+(rec.pub?" · "+niceDate(rec.pub):"")+(rec.venue?" · "+rec.venue:"")+(rec.cat?" · "+categoryName(rec.cat):"");
    var actions=[];
    if(rec.landing)actions.push('<a href="'+escapeHTML(rec.landing)+'" target="_blank" rel="noopener">Open record ↗</a>');
    if(rec.pdf)actions.push('<a href="'+escapeHTML(rec.pdf)+'" target="_blank" rel="noopener">Open PDF ↗</a>');
    $("detail-actions").innerHTML=actions.join("");
    $detail.classList.toggle("has-pdf",!!rec.pdf);
    $detailFrame.src=rec.pdf||"";
    if(window.innerWidth<1050)$detail.scrollIntoView({behavior:"smooth",block:"start"});
  }

  function clickHandler(e){
    if(e.target.closest("a"))return;
    var host=e.target.closest("[data-key]"); if(!host)return;
    var rec=findByKey(host.getAttribute("data-key")); if(rec)showDetail(rec);
  }
  $list.addEventListener("click",clickHandler); $latest.addEventListener("click",clickHandler);

  function syncQuery(v){ $q.value=v; $qSide.value=v; state.query=v.trim().toLowerCase(); }
  function applyControls(){
    state.yearFilter=$year.value; state.catFilter=$cat.value; state.docType=$docType.value; state.source=$source.value; state.sort=$sort.value;
    ensureAllLoaded().then(function(){ renderLatest(); renderReset(); fetchOpenAlex(); });
  }
  var searchDebounced=debounce(function(v){ syncQuery(v); renderReset(); fetchOpenAlex(); },280);
  $q.addEventListener("input",function(){searchDebounced($q.value);});
  $qSide.addEventListener("input",function(){searchDebounced($qSide.value);});
  $("search-submit").addEventListener("click",function(){syncQuery($q.value);applyControls();$("all-results").scrollIntoView({behavior:"smooth"});});
  $("apply-filters").addEventListener("click",applyControls);
  [$year,$cat,$docType,$sort,$source].forEach(function(el){el.addEventListener("change",applyControls);});
  $("reset-filters").addEventListener("click",function(){
    syncQuery(""); $year.value=""; $cat.value=""; $docType.value=""; $sort.value="newest"; $source.value="all"; state.remote=[]; $remoteStatus.textContent=""; applyControls();
  });

  document.querySelectorAll(".source-tab").forEach(function(btn){
    btn.addEventListener("click",function(){
      document.querySelectorAll(".source-tab").forEach(function(b){b.classList.remove("active");}); btn.classList.add("active");
      $source.value=btn.getAttribute("data-source"); applyControls(); $("all-results").scrollIntoView({behavior:"smooth"});
    });
  });

  fetch("data/manifest.json").then(function(r){return r.json();}).then(function(manifest){
    state.manifest=manifest;
    manifest.years.forEach(function(y){var o=document.createElement("option");o.value=y.year;o.textContent=y.year;$year.appendChild(o);});
    manifest.categories.forEach(function(c){var o=document.createElement("option");o.value=c.code;o.textContent=categoryName(c.code)+" ("+c.code+")";$cat.appendChild(o);});
    $("stat-total").textContent=Number(manifest.total||0).toLocaleString();
    $("stat-categories").textContent=manifest.categories.length;
    $("stat-updated").textContent=niceDate(manifest.generated);
    $("source-updated").textContent=niceDate(manifest.generated);
    $foot.textContent="Local arXiv index generated "+(manifest.generated||"—")+" · External source metadata remains owned by its respective providers.";
    var years=manifest.years.map(function(y){return y.year;});
    Promise.all(years.slice(0,3).map(loadYear)).then(function(){renderLatest();renderReset();var rest=years.slice(3),i=0;function next(){if(i>=rest.length)return;loadYear(rest[i++]).then(function(){if(state.query||state.yearFilter||state.catFilter)renderReset();next();});}next();});
  }).catch(function(err){console.error(err);$list.innerHTML='<div id="empty">Unable to load the local arXiv index.</div>';});
})();
