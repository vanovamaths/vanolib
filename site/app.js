(function(){
  "use strict";

  var state={
    arxivManifest:null, oaManifest:null,
    arxiv:[], oa:[],
    loadedArxiv:new Set(), loadedOA:new Set(),
    rendered:0, chunk:70,
    query:"", yearFilter:"", catFilter:"", docType:"", source:"all", sort:"newest"
  };

  var $=function(id){return document.getElementById(id);};
  var $list=$("list"),$latest=$("latest-list"),$empty=$("empty"),$q=$("q"),$qSide=$("q-side");
  var $year=$("year"),$cat=$("cat"),$sort=$("sort"),$docType=$("doc-type"),$source=$("source-select");
  var $loadFill=$("loadbar-fill"),$sentinel=$("sentinel"),$foot=$("foot"),$resultCount=$("result-count"),$remoteStatus=$("remote-status");
  var $detail=$("detail-panel"),$detailFrame=$("detail-frame"),$previewEmpty=$("preview-empty");

  var CATEGORY_NAMES={
    "math.AG":"Algebraic geometry","math.AT":"Algebraic topology","math.AP":"Analysis of PDEs","math.AC":"Commutative algebra","math.CA":"Classical analysis","math.CO":"Combinatorics","math.CT":"Category theory","math.CV":"Complex variables","math.DG":"Differential geometry","math.DS":"Dynamical systems","math.FA":"Functional analysis","math.GM":"General mathematics","math.GN":"General topology","math.GR":"Group theory","math.GT":"Geometric topology","math.HO":"History and overview","math.KT":"K-theory","math.LO":"Logic","math.MG":"Metric geometry","math.NA":"Numerical analysis","math.NT":"Number theory","math.OA":"Operator algebras","math.OC":"Optimization and control","math.PR":"Probability","math.QA":"Quantum algebra","math.RA":"Rings and algebras","math.RT":"Representation theory","math.SG":"Symplectic geometry","math.SP":"Spectral theory","math.ST":"Statistics theory","math-ph":"Mathematical physics","quant-ph":"Quantum physics"
  };

  function escapeHTML(s){return String(s||"").replace(/[&<>\"]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'\"':"&quot;"}[c];});}
  function debounce(fn,ms){var t;return function(){var a=arguments;clearTimeout(t);t=setTimeout(function(){fn.apply(null,a);},ms);};}
  function shortAuthors(s){var a=String(s||"").split(";").map(function(x){return x.trim();}).filter(Boolean);return a.length>3?a.slice(0,3).join(", ")+" et al.":a.join(", ");}
  function niceDate(s){if(!s)return "—";var d=new Date(s);if(isNaN(d))return s;return d.toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"});}
  function categoryName(code){return CATEGORY_NAMES[code]||code||"Mathematics";}

  function arxivRec(row,year){
    return {source:"arxiv",id:row[0],title:row[1],authors:row[2],cat:row[3],pub:row[4],year:String(year),type:"preprint",abstract:"",landing:"https://arxiv.org/abs/"+row[0],pdf:"https://arxiv.org/pdf/"+row[0],doi:"",venue:"arXiv",provider:"arXiv",license:"",lt:String(row[1]||"").toLowerCase(),la:String(row[2]||"").toLowerCase()};
  }

  function oaRec(row,year){
    return {source:"openalex",id:row[0],title:row[1],authors:row[2],cat:row[3]||"Mathematics",pub:row[4],year:String(year),type:row[5]||"article",venue:row[6]||"",landing:row[7]||"",pdf:row[8]||"",doi:row[9]||"",provider:row[10]||"Open-access source",license:row[11]||"",abstract:"",lt:String(row[1]||"").toLowerCase(),la:String(row[2]||"").toLowerCase()};
  }

  function fetchJSON(url){return fetch(url).then(function(r){if(!r.ok)throw new Error(r.status);return r.json();});}

  function loadArxivYear(year){
    year=String(year);if(state.loadedArxiv.has(year))return Promise.resolve();state.loadedArxiv.add(year);
    return fetchJSON("data/"+year+".json").then(function(rows){rows.forEach(function(r){state.arxiv.push(arxivRec(r,year));});updateProgress();}).catch(function(e){console.warn("arXiv year failed",year,e);});
  }

  function loadOAYear(year){
    year=String(year);if(state.loadedOA.has(year))return Promise.resolve();state.loadedOA.add(year);
    return fetchJSON("data/openalex/"+year+".json").then(function(rows){rows.forEach(function(r){state.oa.push(oaRec(r,year));});updateProgress();}).catch(function(e){console.warn("OpenAlex year failed",year,e);});
  }

  function updateProgress(){
    var a=(state.arxivManifest&&state.arxivManifest.years||[]).length;
    var o=(state.oaManifest&&state.oaManifest.years||[]).length;
    var total=Math.max(1,a+o),done=state.loadedArxiv.size+state.loadedOA.size;
    var pct=Math.min(100,Math.round(100*done/total));$loadFill.style.width=pct+"%";
    if(pct>=100)setTimeout(function(){$loadFill.style.width="0%";},500);
  }

  function ensureAllLoaded(){
    var jobs=[];
    if(state.arxivManifest)(state.arxivManifest.years||[]).forEach(function(y){if(!state.loadedArxiv.has(String(y.year)))jobs.push(loadArxivYear(y.year));});
    if(state.oaManifest)(state.oaManifest.years||[]).forEach(function(y){if(!state.loadedOA.has(String(y.year)))jobs.push(loadOAYear(y.year));});
    return Promise.all(jobs);
  }

  function matches(rec){
    if(state.yearFilter&&rec.year!==state.yearFilter)return false;
    if(state.docType&&rec.type!==state.docType&&!(state.docType==="article"&&rec.type==="preprint"))return false;
    if(state.catFilter&&rec.source==="arxiv"&&rec.cat!==state.catFilter)return false;
    if(state.query){
      var hay=[rec.lt,rec.la,String(rec.cat||"").toLowerCase(),String(rec.venue||"").toLowerCase(),String(rec.provider||"").toLowerCase(),String(rec.doi||"").toLowerCase()].join(" ");
      var terms=state.query.split(/\s+/).filter(Boolean);for(var i=0;i<terms.length;i++)if(hay.indexOf(terms[i])===-1)return false;
    }
    return true;
  }

  function sortRecords(arr){var a=arr.slice();if(state.sort==="title")a.sort(function(x,y){return String(x.title).localeCompare(String(y.title));});else if(state.sort==="oldest")a.sort(function(x,y){return String(x.pub).localeCompare(String(y.pub));});else a.sort(function(x,y){return String(y.pub).localeCompare(String(x.pub));});return a;}

  function currentSet(){
    var rows=[];
    if(state.source!=="openalex")rows=rows.concat(state.arxiv.filter(matches));
    if(state.source!=="arxiv")rows=rows.concat(state.oa.filter(matches));
    return sortRecords(rows);
  }

  function sourceBadge(rec){var label=rec.source==="openalex"?(rec.provider||"Open access"):"arXiv";return '<span class="article-source '+(rec.source==="openalex"?"openalex":"")+'">'+escapeHTML(label)+'</span>';}

  function actionLinks(rec,compact){var out=[];out.push('<button type="button" data-view="abstract">Details</button>');if(rec.pdf)out.push('<button type="button" data-view="pdf">PDF</button>');out.push('<button type="button" data-view="'+(rec.pdf?"pdf":"abstract")+'">'+(compact?"Read":"Preview")+'</button>');return out.join("");}

  function latestHTML(rec){return '<article class="latest-card" data-key="'+escapeHTML(rec.source+"|"+rec.id)+'"><div class="latest-top"><span class="new-label">NEW</span><span>'+escapeHTML(niceDate(rec.pub))+'</span></div>'+sourceBadge(rec)+'<h3>'+escapeHTML(rec.title)+'</h3><div class="latest-authors">'+escapeHTML(shortAuthors(rec.authors))+'</div><div class="latest-arxiv">'+escapeHTML(rec.source==="arxiv"?"arXiv:"+rec.id:(rec.venue||rec.provider||"Open access"))+'</div><div class="topic-pills"><span class="topic-pill">'+escapeHTML(categoryName(rec.cat))+'</span></div><div class="card-actions">'+actionLinks(rec,true)+'</div></article>';}

  function rowHTML(rec,index){return '<article class="article-row '+(rec.source==="openalex"?"remote-row":"")+'" data-key="'+escapeHTML(rec.source+"|"+rec.id)+'"><div class="article-index">'+String(index+1).padStart(2,"0")+'</div><div><div class="article-source-row">'+sourceBadge(rec)+'<span class="article-meta">'+escapeHTML(niceDate(rec.pub))+'</span></div><div class="article-title">'+escapeHTML(rec.title)+'</div><div class="article-authors">'+escapeHTML(shortAuthors(rec.authors))+'</div><div class="article-meta">'+escapeHTML(rec.source==="arxiv"?"arXiv:"+rec.id+" · "+categoryName(rec.cat):(rec.venue||categoryName(rec.cat)))+'</div><div class="article-actions">'+actionLinks(rec,false)+'</div></div></article>';}

  var current=[];
  function renderLatest(){var rows=sortRecords(state.arxiv.concat(state.oa)).slice(0,3);$latest.innerHTML=rows.map(latestHTML).join("");}
  function renderReset(){current=currentSet();state.rendered=0;$list.innerHTML="";$empty.style.display=current.length?"none":"block";$resultCount.textContent=current.length.toLocaleString()+" results";renderMore();updateStoredStatus();}
  function renderMore(){var end=Math.min(state.rendered+state.chunk,current.length),html="";for(var i=state.rendered;i<end;i++)html+=rowHTML(current[i],i);$list.insertAdjacentHTML("beforeend",html);state.rendered=end;}

  var io=new IntersectionObserver(function(entries){entries.forEach(function(e){if(e.isIntersecting&&state.rendered<current.length)renderMore();});},{rootMargin:"700px"});io.observe($sentinel);

  function findByKey(key){var p=String(key||"").split("|"),id=p.slice(1).join("|");var pool=p[0]==="openalex"?state.oa:state.arxiv;return pool.find(function(r){return r.id===id;});}

  function showDetail(rec,mode){
    if(!rec)return;mode=mode||(rec.pdf?"pdf":"abstract");
    document.querySelectorAll(".article-row.active").forEach(function(x){x.classList.remove("active");});
    var key=rec.source+"|"+rec.id;document.querySelectorAll(".article-row").forEach(function(x){if(x.getAttribute("data-key")===key)x.classList.add("active");});
    $("detail-source").textContent=rec.source==="openalex"?(rec.provider||"Open access"):"arXiv";
    $("detail-source").style.background=rec.source==="openalex"?"var(--blue)":"var(--rust)";
    $("detail-title").textContent=rec.title;
    var meta=shortAuthors(rec.authors)+(rec.pub?" · "+niceDate(rec.pub):"")+(rec.venue?" · "+rec.venue:"")+(rec.cat?" · "+categoryName(rec.cat):"");
    if(rec.doi)meta+=" · "+rec.doi;$("detail-meta").textContent=meta;
    var actions=[];if(rec.pdf)actions.push('<button type="button" data-detail-view="pdf">Read PDF here</button>');if(rec.landing)actions.push('<a href="'+escapeHTML(rec.landing)+'" target="_blank" rel="noopener">Original source ↗</a>');$("detail-actions").innerHTML=actions.join("");
    var tabButton=$detail.querySelector(".detail-tabs button"),tabText=$detail.querySelector(".detail-tabs span");
    if(mode==="pdf"&&rec.pdf){$detail.classList.add("has-pdf");$detailFrame.style.display="block";$detailFrame.src=rec.pdf;$previewEmpty.style.display="none";if(tabButton)tabButton.textContent="PDF reader";if(tabText)tabText.textContent="The open-access PDF is displayed inside VanoLib.";}
    else{$detail.classList.remove("has-pdf");$detailFrame.src="";$detailFrame.style.display="none";$previewEmpty.style.display="block";$previewEmpty.textContent=(rec.source==="arxiv"?"arXiv reference stored in VanoLib.":"This open-access reference is stored in the VanoLib local index.")+(rec.license?" License: "+rec.license+".":"")+(rec.pdf?" A direct open-access PDF is available in the reader.":" The provider does not expose a direct embeddable PDF.");if(tabButton)tabButton.textContent="Details";if(tabText)tabText.textContent="Metadata is served from VanoLib's local index.";}
    if(window.innerWidth<1050)$detail.scrollIntoView({behavior:"smooth",block:"start"});
  }

  function clickHandler(e){var host=e.target.closest("[data-key]");if(!host)return;var rec=findByKey(host.getAttribute("data-key"));if(!rec)return;var btn=e.target.closest("button[data-view]");showDetail(rec,btn?btn.getAttribute("data-view"):undefined);}
  $list.addEventListener("click",clickHandler);$latest.addEventListener("click",clickHandler);
  $("detail-actions").addEventListener("click",function(e){var b=e.target.closest("button[data-detail-view]");if(!b)return;var active=document.querySelector(".article-row.active");if(active){var rec=findByKey(active.getAttribute("data-key"));if(rec)showDetail(rec,b.getAttribute("data-detail-view"));}});

  function syncQuery(v){$q.value=v;$qSide.value=v;state.query=v.trim().toLowerCase();}
  function applyControls(){state.yearFilter=$year.value;state.catFilter=$cat.value;state.docType=$docType.value;state.source=$source.value;state.sort=$sort.value;ensureAllLoaded().then(function(){renderLatest();renderReset();});}
  var searchDebounced=debounce(function(v){syncQuery(v);ensureAllLoaded().then(function(){renderReset();});},220);
  $q.addEventListener("input",function(){searchDebounced($q.value);});$qSide.addEventListener("input",function(){searchDebounced($qSide.value);});
  $("search-submit").addEventListener("click",function(){syncQuery($q.value);applyControls();$("all-results").scrollIntoView({behavior:"smooth"});});
  $("apply-filters").addEventListener("click",applyControls);[$year,$cat,$docType,$sort,$source].forEach(function(el){el.addEventListener("change",applyControls);});
  $("reset-filters").addEventListener("click",function(){syncQuery("");$year.value="";$cat.value="";$docType.value="";$sort.value="newest";$source.value="all";applyControls();});
  document.querySelectorAll(".source-tab").forEach(function(btn){btn.addEventListener("click",function(){document.querySelectorAll(".source-tab").forEach(function(b){b.classList.remove("active");});btn.classList.add("active");$source.value=btn.getAttribute("data-source");applyControls();$("all-results").scrollIntoView({behavior:"smooth"});});});

  function addYearOptions(){var seen={};(state.arxivManifest&&state.arxivManifest.years||[]).concat(state.oaManifest&&state.oaManifest.years||[]).forEach(function(y){seen[String(y.year)]=true;});Object.keys(seen).sort().reverse().forEach(function(y){var o=document.createElement("option");o.value=y;o.textContent=y;$year.appendChild(o);});}
  function addCategoryOptions(){(state.arxivManifest&&state.arxivManifest.categories||[]).forEach(function(c){var o=document.createElement("option");o.value=c.code;o.textContent=categoryName(c.code)+" ("+c.code+")";$cat.appendChild(o);});}
  function updateStoredStatus(){var total=state.oaManifest?Number(state.oaManifest.total||0):0;$remoteStatus.textContent=total?total.toLocaleString()+" stored open-access refs":"";}
  function updateStats(){
    var a=state.arxivManifest||{},o=state.oaManifest||{};$("stat-total").textContent=(Number(a.total||0)+Number(o.total||0)).toLocaleString();$("stat-categories").textContent=(a.categories||[]).length;$("stat-updated").textContent=niceDate(a.generated||o.generated);$("source-updated").textContent=niceDate(a.generated||o.generated);
    $foot.textContent="VanoLib local indexes: arXiv "+Number(a.total||0).toLocaleString()+" refs"+(o.total?" · Open mathematics "+Number(o.total).toLocaleString()+" refs":"")+". Updated automatically every Monday.";updateStoredStatus();
  }

  Promise.all([
    fetchJSON("data/manifest.json").then(function(m){state.arxivManifest=m;}).catch(function(e){console.error("arXiv manifest",e);}),
    fetchJSON("data/openalex/manifest.json").then(function(m){state.oaManifest=m;}).catch(function(){state.oaManifest=null;})
  ]).then(function(){
    addYearOptions();addCategoryOptions();updateStats();
    var first=[];
    (state.arxivManifest&&state.arxivManifest.years||[]).slice(0,3).forEach(function(y){first.push(loadArxivYear(y.year));});
    (state.oaManifest&&state.oaManifest.years||[]).slice(0,2).forEach(function(y){first.push(loadOAYear(y.year));});
    return Promise.all(first);
  }).then(function(){
    renderLatest();renderReset();
    var rest=[];(state.arxivManifest&&state.arxivManifest.years||[]).slice(3).forEach(function(y){rest.push(function(){return loadArxivYear(y.year);});});(state.oaManifest&&state.oaManifest.years||[]).slice(2).forEach(function(y){rest.push(function(){return loadOAYear(y.year);});});
    var i=0;function next(){if(i>=rest.length)return;rest[i++]().then(function(){if(state.query||state.yearFilter||state.catFilter||state.source!=="all")renderReset();next();});}next();
  }).catch(function(err){console.error(err);$list.innerHTML='<div id="empty">Unable to load the VanoLib local indexes.</div>';});
})();
