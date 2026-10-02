(function(){
"use strict";

var $=function(id){return document.getElementById(id);};
var state={
  manifest:null, legacyManifest:null, mirrorManifest:null,
  rows:[], visible:[], selected:null, filter:"all", category:"all",
  scope:"latest", rendered:0, chunk:80, zoom:100, token:0
};
var names={
  "math.AC":"Commutative algebra","math.AG":"Algebraic geometry","math.AP":"Analysis of PDEs",
  "math.AT":"Algebraic topology","math.CA":"Classical analysis","math.CO":"Combinatorics",
  "math.CT":"Category theory","math.CV":"Complex variables","math.DG":"Differential geometry",
  "math.DS":"Dynamical systems","math.FA":"Functional analysis","math.GM":"General mathematics",
  "math.GN":"General topology","math.GR":"Group theory","math.GT":"Geometric topology",
  "math.HO":"History and overview","math.KT":"K-theory","math.LO":"Logic","math.MG":"Metric geometry",
  "math.MP":"Mathematical physics","math.NA":"Numerical analysis","math.NT":"Number theory",
  "math.OA":"Operator algebras","math.OC":"Optimization and control","math.PR":"Probability",
  "math.QA":"Quantum algebra","math.RA":"Rings and algebras","math.RT":"Representation theory",
  "math.SG":"Symplectic geometry","math.SP":"Spectral theory","math.ST":"Statistics theory",
  "math-ph":"Mathematical physics"
};
var palette=["#c4643f","#6d8f72","#c19b55","#7187a5","#8c72a8","#5f918e","#b06e72","#7e8661"];
var favorites=new Set(readStore("vanolib:favorites",[]));
var progress=readStore("vanolib:progress",{});

function readStore(key,fallback){
  try{var v=localStorage.getItem(key);return v?JSON.parse(v):fallback}catch(e){return fallback}
}
function writeStore(key,value){
  try{localStorage.setItem(key,JSON.stringify(value))}catch(e){}
}
function esc(v){
  return String(v==null?"":v).replace(/[&<>"]/g,function(c){
    return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c];
  });
}
function number(v){return Number(v||0).toLocaleString("en-US")}
function categoryName(c){return names[c]||c||"Mathematics"}
function colorFor(c){
  var keys=Object.keys(names),i=Math.max(0,keys.indexOf(c));
  return palette[i%palette.length];
}
function authors(v){return String(v||"").split(";").map(function(x){return x.trim()}).filter(Boolean)}
function shortAuthor(v){
  var a=authors(v);if(!a.length)return "Unknown author";
  return a[0]+(a.length>1?" et al.":"");
}
function formatDate(v){
  if(!v)return "—";
  var d=new Date(v+"T00:00:00Z");
  return isNaN(d.getTime())?v:new Intl.DateTimeFormat("en-US",{month:"short",day:"numeric",year:"numeric"}).format(d);
}
function yearOf(r){return String(r.pub||"").slice(0,4)}
function baseId(id){return String(id||"").replace(/v\d+$/,"")}
function safeArxivId(id){return encodeURI(String(id||"").replace(/[^A-Za-z0-9.\/\-]/g,""))}
function absUrl(id){return "https://arxiv.org/abs/"+safeArxivId(id)}
function pdfUrl(id){return "https://arxiv.org/pdf/"+safeArxivId(id)}
function scholarUrl(r){return "https://scholar.google.com/scholar?q="+encodeURIComponent('"'+r.title+'"')}
function toRecord(row){
  return {
    id:String(row[0]||""),title:String(row[1]||"Untitled"),authors:String(row[2]||""),
    cat:String(row[3]||"math.GM"),pub:String(row[4]||""),
    abstract:String(row[5]||""),
    search:(String(row[0]||"")+" "+String(row[1]||"")+" "+String(row[2]||"")+" "+String(row[3]||"")).toLowerCase()
  }
}
function fetchJSON(url){
  return fetch(url,{cache:"no-store"}).then(function(r){
    if(!r.ok)throw new Error("HTTP "+r.status);return r.json()
  });
}
function toast(msg){
  var t=$("toast");t.textContent=msg;t.classList.add("on");
  clearTimeout(toast._t);toast._t=setTimeout(function(){t.classList.remove("on")},1400)
}
function setLoading(on){
  $("sync-status").textContent=on?"Loading papers…":syncText()
}
function syncText(){
  var m=state.mirrorManifest;
  if(m){
    var g=String(m.generated||"").slice(0,10);
    if(m.backfill_complete){
      return number(m.total)+" arXiv papers · full mirror · synced "+formatDate(g)
    }
    return number(m.total)+" arXiv papers mirrored · full backfill running"
  }
  if(!state.legacyManifest)return "Library ready";
  var lg=String(state.legacyManifest.generated||"").slice(0,10);
  return number(state.legacyManifest.total)+" papers · synced "+formatDate(lg)
}
function dedupeRows(rows){
  var map=new Map();
  rows.forEach(function(row){
    if(!row||!row.length)return;
    var key=baseId(String(row[0]||""));
    var old=map.get(key);
    if(!old||row.length>old.length)map.set(key,row)
  });
  return Array.from(map.values())
}
function mirrorYearInfo(y){
  if(!state.mirrorManifest)return null;
  var years=state.mirrorManifest.years||[];
  for(var i=0;i<years.length;i++)if(String(years[i].year)===String(y))return years[i];
  return null
}
function legacyYearExists(y){
  var years=(state.legacyManifest&&state.legacyManifest.years)||[];
  return years.some(function(x){return String(x.year)===String(y)})
}
function loadLatestRows(){
  if(state.mirrorManifest){
    return fetchJSON("data/arxiv/latest.json").catch(function(){
      return legacyLatestRows()
    })
  }
  return legacyLatestRows()
}
function legacyLatestRows(){
  return fetchJSON("data/latest.json").catch(function(){
    var y=state.legacyManifest&&state.legacyManifest.years&&state.legacyManifest.years[0];
    if(!y)throw new Error("No latest archive shard");
    return fetchJSON("data/"+y.year+".json").then(function(rows){return rows.slice(0,1600)})
  })
}
function loadYearRows(y){
  var info=mirrorYearInfo(y);
  var jobs=[];
  if(info&&Array.isArray(info.months)){
    info.months.forEach(function(month){
      jobs.push(fetchJSON("data/arxiv/"+month+".json").catch(function(){return []}))
    })
  }
  if((!state.mirrorManifest||!state.mirrorManifest.backfill_complete)&&legacyYearExists(y)){
    jobs.push(fetchJSON("data/"+y+".json").catch(function(){return []}))
  }
  if(!jobs.length&&legacyYearExists(y)){
    jobs.push(fetchJSON("data/"+y+".json"))
  }
  if(!jobs.length)return Promise.resolve([]);
  return Promise.all(jobs).then(function(parts){
    var rows=[];parts.forEach(function(part){rows=rows.concat(part||[])});
    return dedupeRows(rows)
  })
}
function loadScope(scope){
  state.scope=scope||"latest";state.rows=[];state.selected=null;state.rendered=0;
  $("detail").innerHTML='<div class="welcome"><span class="welcome-mark">V</span><h1>Open mathematics, in one quiet library.</h1><p>Select a paper to see its details, citation tools and integrated PDF reader.</p></div>';
  var token=++state.token;setLoading(true);
  var request=state.scope==="latest"?loadLatestRows():loadYearRows(state.scope);
  request.then(function(rows){
    if(token!==state.token)return;
    state.rows=dedupeRows(rows).map(toRecord);setLoading(false);apply()
  }).catch(function(err){
    console.error(err);if(token!==state.token)return;
    setLoading(false);$("items").innerHTML='<div style="padding:40px;text-align:center;color:var(--fa)">Unable to load papers.</div>'
  })
}
function current(){
  var q=$("q").value.trim().toLowerCase();
  return state.rows.filter(function(r){
    if(state.filter==="read"&&!favorites.has(r.id))return false;
    if(state.filter==="cont"&&!((progress[r.id]||0)>0&&(progress[r.id]||0)<100))return false;
    if(state.category!=="all"&&r.cat!==state.category)return false;
    if(q){
      var hay=r.search+" "+categoryName(r.cat).toLowerCase();
      var terms=q.split(/\s+/).filter(Boolean);
      for(var i=0;i<terms.length;i++)if(hay.indexOf(terms[i])<0)return false
    }
    return true
  }).sort(function(a,b){
    return String(b.pub).localeCompare(String(a.pub))||b.id.localeCompare(a.id)
  })
}
function renderList(){
  state.visible=current();state.rendered=0;$("items").innerHTML="";renderMore();
  $("nall").textContent=state.rows.length;
  $("nread").textContent=state.rows.filter(function(r){return favorites.has(r.id)}).length;
  $("ncont").textContent=state.rows.filter(function(r){var p=progress[r.id]||0;return p>0&&p<100}).length
}
function renderMore(){
  var end=Math.min(state.rendered+state.chunk,state.visible.length),h="";
  for(var i=state.rendered;i<end;i++){
    var r=state.visible[i],p=progress[r.id]||0;
    h+='<div class="it '+(state.selected&&r.id===state.selected.id?"on":"")+'" data-id="'+esc(r.id)+'">'+
      (favorites.has(r.id)?'<span class="star">★</span>':'')+
      '<div class="t">'+esc(r.title)+'</div>'+
      '<div class="m"><span class="dot" style="background:'+colorFor(r.cat)+'"></span>'+
      esc(shortAuthor(r.authors))+' · '+esc(yearOf(r))+' · '+esc(r.cat)+'</div>'+
      (p?'<div class="prog"><i style="width:'+Math.min(100,p)+'%"></i></div>':'')+
      '</div>'
  }
  if(h)$("items").insertAdjacentHTML("beforeend",h);
  state.rendered=end
}
function apply(){renderList();renderChips()}
function selectRecord(id){
  for(var i=0;i<state.rows.length;i++)if(state.rows[i].id===id){state.selected=state.rows[i];break}
  if(!state.selected)return;
  renderList();renderDetail();
}
function citationAPA(r){
  var a=authors(r.authors).join(", ")||"Unknown author";
  return a+" ("+(yearOf(r)||"n.d.")+"). "+r.title+". arXiv. https://arxiv.org/abs/"+baseId(r.id)
}
function citationBib(r){
  var a=authors(r.authors).join(" and ");
  var first=(authors(r.authors)[0]||"unknown").split(/\s+/).slice(-1)[0].replace(/\W/g,"")||"unknown";
  var key=first+(yearOf(r)||"")+"VanoLib";
  return "@article{"+key+",\n  title={"+r.title.replace(/[{}]/g,"")+"},\n  author={"+a.replace(/[{}]/g,"")+"},\n  year={"+yearOf(r)+"},\n  eprint={"+baseId(r.id)+"},\n  archivePrefix={arXiv},\n  primaryClass={"+r.cat+"}\n}"
}
function renderDetail(){
  var r=state.selected;if(!r)return;
  var p=progress[r.id]||0;
  var abs=r.abstract?
    esc(r.abstract):
    'Abstract metadata is not stored in the local archive. Use “arXiv” to read the official abstract, or open the PDF directly in VanoLib.';
  $("detail").innerHTML=
    '<div class="inner">'+
      '<span class="pill"><span class="dot" style="background:'+colorFor(r.cat)+'"></span>arXiv · '+esc(r.cat)+'</span>'+
      '<h1>'+esc(r.title)+'</h1>'+
      '<div class="who">'+esc(authors(r.authors).join(", ")||"Unknown author")+' — '+esc(formatDate(r.pub))+'</div>'+
      '<div class="actions">'+
        '<button class="btn pri" id="open-reader">'+(p?'Resume reading':'Read paper')+'</button>'+
        '<button class="btn" id="star-detail">'+(favorites.has(r.id)?"★ In To Read":"☆ To Read")+'</button>'+
        '<a class="btn" href="'+absUrl(r.id)+'" target="_blank" rel="noopener">↗ arXiv</a>'+
        '<a class="btn" href="'+scholarUrl(r)+'" target="_blank" rel="noopener">Scholar ↗</a>'+
        '<button class="btn" id="copy-bib">⧉ BibTeX</button>'+
      '</div>'+
      '<div class="lbl">Abstract</div><div class="ab">'+abs+'</div>'+
      '<div class="lbl">Details</div>'+
      '<div class="grid">'+
        '<div><small>Published</small>'+esc(formatDate(r.pub))+'</div>'+
        '<div><small>Progress</small>'+Math.round(p)+'%</div>'+
        '<div><small>arXiv ID</small>'+esc(r.id)+'</div>'+
      '</div>'+
      '<div class="cite-box">'+esc(citationAPA(r))+'</div>'+
    '</div>';
  $("open-reader").onclick=openReader;
  $("star-detail").onclick=function(){toggleFavorite(r);renderDetail()};
  $("copy-bib").onclick=function(){copyText(citationBib(r),"BibTeX copied")}
}
function toggleFavorite(r){
  if(favorites.has(r.id))favorites.delete(r.id);else favorites.add(r.id);
  writeStore("vanolib:favorites",Array.from(favorites));renderList()
}
function copyText(text,msg){
  if(navigator.clipboard&&navigator.clipboard.writeText){
    navigator.clipboard.writeText(text).then(function(){toast(msg)})
  }else{
    var ta=document.createElement("textarea");ta.value=text;document.body.appendChild(ta);ta.select();
    document.execCommand("copy");ta.remove();toast(msg)
  }
}
function openReader(){
  var r=state.selected;if(!r)return;
  $("reader").classList.add("on");
  $("pdf-frame").src=pdfUrl(r.id)+"#view=FitH";
  $("reader-arxiv").href=absUrl(r.id);
  $("reader-scholar").href=scholarUrl(r);
  $("reader-star").textContent=favorites.has(r.id)?"★":"☆";
  $("reader-meta").innerHTML='<strong>'+esc(r.title)+'</strong>'+esc(shortAuthor(r.authors))+'<br>'+esc(r.cat)+' · '+esc(formatDate(r.pub));
  state.zoom=100;applyZoom();
  progress[r.id]=Math.max(progress[r.id]||0,5);writeStore("vanolib:progress",progress);
  $("rprog").style.width=(progress[r.id]||5)+"%";
  $("rinfo").textContent=Math.round(progress[r.id]||5)+"% · "+r.id;
  renderList()
}
function closeReader(){
  $("reader").classList.remove("on");$("pdf-frame").src="";
  if(state.selected){progress[state.selected.id]=Math.max(progress[state.selected.id]||0,12);writeStore("vanolib:progress",progress)}
  renderList();renderDetail()
}
function applyZoom(){
  $("zoom-label").textContent=state.zoom+"%";
  $("pdf-shell").style.zoom=state.zoom/100
}
function setMode(mode,button){
  $("reader").className="reader on"+(mode?" "+mode:"");
  document.querySelectorAll(".rbar .sw").forEach(function(b){b.classList.toggle("on",b===button)});
  $("pdf-frame").style.filter=mode==="night"?"invert(.9) hue-rotate(180deg)":"none"
}
function renderCategories(){
  var cats=(state.manifest.categories||[]).slice(0,16),h="";
  cats.forEach(function(c){
    h+='<button class="nav" data-cat="'+esc(c.code)+'"><span class="dot" style="background:'+colorFor(c.code)+'"></span>'+
      esc(c.code)+'<span class="n">'+number(c.count)+'</span></button>'
  });
  $("category-nav").innerHTML=h
}
function renderChips(){
  var top=(state.manifest&&state.manifest.categories||[]).slice(0,5).map(function(x){return x.code});
  var arr=["all"].concat(top);
  $("chips").innerHTML=arr.map(function(c){
    var label=c==="all"?"All":c;
    return '<button class="chip '+(state.category===c?"on":"")+'" data-chip="'+esc(c)+'">'+esc(label)+'</button>'
  }).join("")
}
function fillYears(){
  $("year").innerHTML='<option value="">Latest</option>';
  (state.manifest.years||[]).forEach(function(y){
    var o=document.createElement("option");o.value=String(y.year);
    o.textContent=String(y.year)+" · "+number(y.count);$("year").appendChild(o)
  })
}
function buildCompositeManifest(){
  var legacy=state.legacyManifest||{years:[],categories:[],total:0};
  var mirror=state.mirrorManifest;
  if(!mirror)return legacy;

  var byYear={};
  (legacy.years||[]).forEach(function(y){
    byYear[String(y.year)]={year:String(y.year),count:Number(y.count||0)}
  });
  (mirror.years||[]).forEach(function(y){
    var key=String(y.year),old=byYear[key];
    byYear[key]={year:key,count:mirror.backfill_complete?Number(y.count||0):Math.max(Number(y.count||0),old?old.count:0)}
  });

  var years=Object.keys(byYear).sort(function(a,b){return b.localeCompare(a)}).map(function(k){return byYear[k]});
  return {
    total:mirror.backfill_complete?mirror.total:Math.max(Number(legacy.total||0),Number(mirror.total||0)),
    generated:mirror.generated||legacy.generated,
    years:years,
    categories:(mirror.categories&&mirror.categories.length)?mirror.categories:(legacy.categories||[])
  }
}

$("items").addEventListener("click",function(e){
  var el=e.target.closest(".it");if(el)selectRecord(el.dataset.id)
});
$("items").addEventListener("dblclick",function(e){
  var el=e.target.closest(".it");if(el){selectRecord(el.dataset.id);openReader()}
});
$("q").addEventListener("input",apply);
$("year").addEventListener("change",function(){loadScope(this.value||"latest")});
$("chips").addEventListener("click",function(e){
  var b=e.target.closest("[data-chip]");if(!b)return;
  state.category=b.dataset.chip;apply();
  document.querySelectorAll("#category-nav .nav").forEach(function(n){n.classList.toggle("on",n.dataset.cat===state.category)})
});
$("category-nav").addEventListener("click",function(e){
  var b=e.target.closest("[data-cat]");if(!b)return;
  state.category=b.dataset.cat;apply();
  document.querySelectorAll("#category-nav .nav").forEach(function(n){n.classList.toggle("on",n===b)})
});
document.querySelectorAll("aside>.nav[data-f]").forEach(function(n){
  n.onclick=function(){
    state.filter=n.dataset.f;
    document.querySelectorAll("aside>.nav[data-f]").forEach(function(x){x.classList.toggle("on",x===n)});
    $("list-title").textContent=state.filter==="all"?"Library":state.filter==="read"?"To Read":"In Progress";
    apply()
  }
});
$("theme-toggle").onclick=function(){
  $("A").classList.toggle("dark");this.textContent=$("A").classList.contains("dark")?"☀":"☾"
};
$("reader-close").onclick=closeReader;
$("zoom-in").onclick=function(){state.zoom=Math.min(160,state.zoom+10);applyZoom()};
$("zoom-out").onclick=function(){state.zoom=Math.max(70,state.zoom-10);applyZoom()};
document.querySelectorAll(".rbar .sw").forEach(function(b){b.onclick=function(){setMode(b.dataset.m,b)}});
$("reader-star").onclick=function(){
  if(!state.selected)return;toggleFavorite(state.selected);
  this.textContent=favorites.has(state.selected.id)?"★":"☆";renderDetail()
};
new IntersectionObserver(function(entries){
  if(entries[0].isIntersecting&&state.rendered<state.visible.length)renderMore()
},{rootMargin:"500px"}).observe($("sentinel"));
document.addEventListener("keydown",function(e){
  if(e.key==="Escape"&&$("reader").classList.contains("on")){closeReader();return}
  if(e.key==="/"&&document.activeElement.tagName!=="INPUT"){
    e.preventDefault();$("q").focus()
  }
});

Promise.all([
  fetchJSON("data/manifest.json").catch(function(){return {years:[],categories:[],total:0}}),
  fetchJSON("data/arxiv/manifest.json").catch(function(){return null})
]).then(function(values){
  state.legacyManifest=values[0];
  state.mirrorManifest=values[1];
  state.manifest=buildCompositeManifest();
  renderCategories();fillYears();renderChips();$("sync-status").textContent=syncText();
  loadScope("latest")
}).catch(function(err){
  console.error(err);$("sync-status").textContent="Index unavailable"
});
})();