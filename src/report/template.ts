/**
 * The self-contained HTML report shell and its vanilla-JS renderer.
 *
 * No framework: the interaction logic is plain DOM code, and the pure helpers
 * it relies on are the same ones the test suite pins — inlined here via
 * `.toString()` so there is one source of truth. Everything (CSS, JS, data)
 * is inlined; the output makes no network request, matching the artifact CSP
 * and working offline.
 */
import * as H from "./browser-helpers.js";

/** The pure helpers, emitted as browser source in one shared scope. */
function inlinedHelpers(): string {
  return [
    H.parseNumeric,
    H.escapeHtml,
    H.applyMicro,
    H.cellHtml,
    H.itemHtml,
    H.coveragePct,
    H.coverageBand,
    H.tableToCsv,
    H.facetableColumns,
    H.facetValue,
    H.pastebackText,
  ]
    .map((fn) => fn.toString())
    .join("\n");
}

const STYLE = `
:root{
  --bg:#f5f3ef; --card:#fffdf9; --ink:#22201c; --muted:#6b655c; --line:#e7e2d8;
  --chip:#efeae0; --accent:#0b6b3a;
  --confident:#0b6b3a; --ok:#3f7d4f; --warning:#b45309; --blocked:#b91c1c;
  --info:#1e5fa8; --neutral:#7a736a;
  --good:#15803d; --warn:#b45309; --bad:#b91c1c;
  --serif:Georgia,"Iowan Old Style","Palatino Linotype",Palatino,Charter,Cambria,"Times New Roman",serif;
}
:root[data-theme="dark"]{
  --bg:#16140f; --card:#201d17; --ink:#ece7dd; --muted:#a49b8c; --line:#332e25;
  --chip:#2a251d; --accent:#4ade80;
  --confident:#4ade80; --ok:#7bbd8a; --warning:#f59e0b; --blocked:#f87171;
  --info:#60a5fa; --neutral:#a49b8c; --good:#4ade80; --warn:#f59e0b; --bad:#f87171;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
  font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
.wrap{max-width:940px;margin:0 auto;padding:0 18px 80px}
header.rpt{padding:26px 0 14px;display:flex;justify-content:space-between;align-items:flex-start;gap:16px}
.kicker{font-size:12px;letter-spacing:.09em;text-transform:uppercase;color:var(--muted);margin:0 0 4px}
h1{font-size:27px;line-height:1.18;margin:0;font-family:var(--serif);font-weight:600;letter-spacing:-.01em}
.tools{display:flex;gap:8px;flex:0 0 auto}
.tbtn{font-size:13px;padding:6px 11px;border:1px solid var(--line);background:var(--card);
  color:var(--ink);border-radius:8px;cursor:pointer}
.meta{display:flex;flex-wrap:wrap;gap:6px 16px;color:var(--muted);font-size:13px;margin:2px 0 8px}
.meta b{color:var(--ink);font-weight:600}
.stats{display:flex;flex-wrap:wrap;gap:12px;margin:14px 0}
.stat{flex:1 1 150px;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px}
.stat .v{font-size:26px;font-weight:700;line-height:1.1}
.stat .l{font-size:13px;color:var(--muted);margin-top:3px}
.stat .s{font-size:12px;color:var(--muted);margin-top:6px}
.stat.accent .v{color:var(--accent)} .stat.ok .v{color:var(--ok)}
.stat.warning .v{color:var(--warning)} .stat.blocked .v{color:var(--blocked)}
.stat.confident .v{color:var(--confident)}
.cov{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px;margin:14px 0}
.cov h2,.sec h2{font-size:12px;letter-spacing:.07em;text-transform:uppercase;color:var(--muted);margin:0 0 10px}
.covsum{display:flex;flex-wrap:wrap;gap:8px 20px;margin-bottom:12px}
.covsum div{font-size:13px} .covsum b{font-size:16px;display:block}
.covsum .n{color:var(--muted);font-size:12px}
.bar{margin:7px 0}
.bar .row{display:flex;justify-content:space-between;font-size:13px;margin-bottom:3px}
.bar .track{height:7px;background:var(--chip);border-radius:5px;overflow:hidden}
.bar .fill{height:100%}
.fill.good{background:var(--good)} .fill.warn{background:var(--warn)} .fill.bad{background:var(--bad)}
.bar .note{font-size:12px;color:var(--muted);margin-top:2px}
.headline{font-size:16px;background:var(--card);border:1px solid var(--line);
  border-radius:12px;padding:15px;margin:14px 0}
.sec{background:var(--card);border:1px solid var(--line);border-left:4px solid var(--neutral);
  border-radius:12px;margin:14px 0;overflow:hidden}
.sec.confident{border-left-color:var(--confident)} .sec.ok{border-left-color:var(--ok)}
.sec.warning{border-left-color:var(--warning)} .sec.blocked{border-left-color:var(--blocked)}
.sec.info{border-left-color:var(--info)} .sec.neutral{border-left-color:var(--neutral)}
.sec > .head{padding:14px 16px;cursor:pointer;display:flex;align-items:center;gap:10px}
.sec > .head h3{margin:0;font-size:18px;flex:1 1 auto;font-family:var(--serif);font-weight:600}
.sec > .head .count{color:var(--muted);font-size:13px;font-weight:400}
.pill{font-size:11px;padding:2px 9px;border-radius:20px;color:#fff;white-space:nowrap;text-transform:capitalize}
.pill.confident{background:var(--confident)} .pill.ok{background:var(--ok)}
.pill.warning{background:var(--warning)} .pill.blocked{background:var(--blocked)}
.pill.info{background:var(--info)} .pill.neutral{background:var(--neutral)}
.chev{color:var(--muted);transition:transform .15s}
.sec.closed .chev{transform:rotate(-90deg)}
.bodywrap{display:grid;grid-template-rows:1fr;transition:grid-template-rows .18s ease}
.sec.closed .bodywrap{grid-template-rows:0fr}
.sec .body{overflow:hidden;min-height:0}
.sec .bodyinner{padding:0 16px 14px}
.offscreen{position:absolute;left:-9999px}
.tctl{display:flex;align-items:center;gap:8px;margin:10px 0 4px;flex-wrap:wrap}
.tctl-sp{flex:1 1 auto}
.xbtn{font-size:12px;padding:4px 9px;border:1px solid var(--line);background:var(--bg);
  color:var(--muted);border-radius:7px;cursor:pointer}
.xbtn:hover{color:var(--ink)}
.facets{display:flex;flex-wrap:wrap;gap:6px 16px;margin:0 0 8px}
.facetgrp{display:flex;flex-wrap:wrap;gap:5px;align-items:center}
.facetgrp .fl{font-size:12px;color:var(--muted)}
.facetchip{font-size:12px;padding:2px 9px;border:1px solid var(--line);border-radius:20px;
  cursor:pointer;user-select:none;color:var(--muted)}
.facetchip.on{background:var(--accent);color:#fff;border-color:transparent}
.empty{padding:20px;text-align:center;color:var(--muted);font-size:14px}
.empty button{margin-left:6px;font-size:13px;color:var(--accent);background:none;border:0;cursor:pointer}
.actbar{display:flex;justify-content:flex-end;margin:8px 0 0}
.acttoggle{font-size:13px;color:var(--muted);cursor:pointer;user-select:none;display:inline-flex;gap:7px;align-items:center}
.sec .summary{color:var(--muted);font-size:14px;margin:-2px 0 12px}
.sec .lead{margin:10px 0}
.sec .foot{font-style:italic;color:var(--muted);font-size:13px;margin-top:10px}
.subhead{font-weight:650;font-size:14px;margin:16px 0 6px}
ul.rlist{list-style:none;padding:0;margin:8px 0}
ul.rlist li{padding:4px 0 4px 22px;position:relative}
ul.rlist li:before{content:"\\2713";position:absolute;left:0;color:var(--good)}
ul.rlist.cross li:before{content:"\\2715";color:var(--bad)}
.tablewrap{overflow:auto;max-height:72vh;margin:4px 0}
.filter{font-size:13px;padding:6px 10px;border:1px solid var(--line);border-radius:8px;
  background:var(--bg);color:var(--ink);width:200px;max-width:100%}
table{border-collapse:collapse;width:100%;font-size:14px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:12px;color:var(--muted);cursor:pointer;user-select:none;white-space:nowrap;
  position:sticky;top:0;background:var(--card);z-index:1}
th:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
th.numeric,td.numeric{text-align:right}
th .ar{opacity:.5;font-size:10px}
td .chip,li .chip,.headline .chip,.cov .chip{background:var(--chip);border-radius:5px;
  padding:1px 6px;font-size:12.5px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.showall{font-size:13px;color:var(--accent);background:none;border:0;cursor:pointer;padding:8px 0}
.morenote{font-style:italic;color:var(--muted);font-size:13px;margin:4px 0}
.order{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:6px 16px;margin:16px 0}
.order .oi{display:flex;gap:12px;padding:12px 0;border-top:1px solid var(--line)}
.order .oi:first-child{border-top:0}
.order .num{flex:0 0 26px;height:26px;border-radius:8px;background:var(--accent);color:#fff;
  font-weight:700;display:flex;align-items:center;justify-content:center;font-size:13px}
.order .oi .d{color:var(--muted);font-size:13px}
.closing{color:var(--muted);font-size:14px;margin:16px 0}
footer.rpt{border-top:1px solid var(--line);margin-top:24px;padding-top:12px;
  display:flex;justify-content:space-between;color:var(--muted);font-size:12px;flex-wrap:wrap;gap:6px}
.selbar{position:fixed;left:0;right:0;bottom:0;background:var(--card);border-top:1px solid var(--line);
  padding:10px 16px;display:none;align-items:center;gap:12px;justify-content:center}
.selbar.on{display:flex}
.selbar b{color:var(--accent)}
.selbar textarea{position:absolute;left:-9999px}
@media print{
  .tools,.selbar,.filter,.showall,.tctl,.facets,.actbar,.empty{display:none!important}
  .sec.closed .bodywrap{grid-template-rows:1fr!important}
  .tablewrap{max-height:none!important;overflow:visible!important}
  body{background:#fff;color:#000}
  .sec,.stat,.cov,.headline,.order{border-color:#ccc;break-inside:avoid}
}
`;

/** The browser renderer, as source inlined into the report. */
const APP = `
(function(){
  "use strict";
  var data = JSON.parse(document.getElementById("report-data").textContent);
  var root = document.getElementById("app");
  var selections = {};   // tableId -> {title, rows, set:Set(originalIdx)}

  function el(tag, cls, html){ var e=document.createElement(tag); if(cls)e.className=cls;
    if(html!=null)e.innerHTML=html; return e; }

  var clipTa=el("textarea","offscreen"); document.body&&document.body.appendChild(clipTa);
  function copyText(s){ clipTa.value=s; clipTa.select();
    try{navigator.clipboard.writeText(s)}catch(e){} try{document.execCommand("copy")}catch(e){} }
  function downloadCsv(csv,name){ var a=el("a"); a.href="data:text/csv;charset=utf-8,"+encodeURIComponent(csv);
    a.download=name; a.style.display="none"; document.body.appendChild(a); a.click(); document.body.removeChild(a); }
  function flash(btn,txt){ var o=btn.textContent; btn.textContent=txt;
    setTimeout(function(){btn.textContent=o},1400); }

  // ---- header
  var head = el("header","rpt");
  var htxt = el("div");
  if(data.kicker) htxt.appendChild(el("p","kicker", escapeHtml(data.kicker)));
  htxt.appendChild(el("h1",null, escapeHtml(data.title||"Report")));
  head.appendChild(htxt);
  var tools = el("div","tools");
  var themeBtn = el("button","tbtn","Dark");
  themeBtn.onclick=function(){ var d=document.documentElement;
    var dark=d.getAttribute("data-theme")==="dark";
    d.setAttribute("data-theme",dark?"light":"dark"); themeBtn.textContent=dark?"Dark":"Light";
    try{localStorage.setItem("hcpapi-report-theme",dark?"light":"dark")}catch(e){} };
  var printBtn = el("button","tbtn","Print"); printBtn.onclick=function(){window.print()};
  tools.appendChild(themeBtn); tools.appendChild(printBtn); head.appendChild(tools);
  root.appendChild(head);

  if(Array.isArray(data.meta)&&data.meta.length){
    var m=el("div","meta");
    data.meta.forEach(function(x){ m.appendChild(el("span",null,
      "<b>"+escapeHtml(x.label)+"</b> "+escapeHtml(x.value))); });
    root.appendChild(m);
  }
  if(Array.isArray(data.stats)&&data.stats.length){
    var sr=el("div","stats");
    data.stats.forEach(function(s){ var c=el("div","stat "+(s.tone||"default"));
      c.appendChild(el("div","v",escapeHtml(s.value)));
      c.appendChild(el("div","l",escapeHtml(s.label)));
      if(s.sub)c.appendChild(el("div","s",escapeHtml(s.sub))); sr.appendChild(c); });
    root.appendChild(sr);
  }
  if(data.headline) root.appendChild(el("div","headline",data.headline));

  if(data.coverage){
    var cov=el("div","cov"); cov.appendChild(el("h2",null,"Coverage"));
    var cv=data.coverage;
    if(Array.isArray(cv.summary)&&cv.summary.length){
      var cs=el("div","covsum");
      cv.summary.forEach(function(x){ var d=el("div");
        d.appendChild(el("b",null,escapeHtml(x.value)));
        d.appendChild(document.createTextNode(x.label));
        if(x.note)d.appendChild(el("div","n",escapeHtml(x.note))); cs.appendChild(d); });
      cov.appendChild(cs);
    }
    (cv.fields||[]).forEach(function(f){ var pct=coveragePct(f); var band=coverageBand(pct);
      var b=el("div","bar");
      b.appendChild(el("div","row","<span>"+escapeHtml(f.name)+"</span><span>"+
        (pct===null?"—":pct+"%")+"</span>"));
      var t=el("div","track"); var fill=el("div","fill "+band);
      fill.style.width=(pct===null?0:pct)+"%"; t.appendChild(fill); b.appendChild(t);
      if(f.note)b.appendChild(el("div","note",escapeHtml(f.note))); cov.appendChild(b); });
    root.appendChild(cov);
  }

  var secEls=[], anyAct=false, anyNon=false;
  (data.sections||[]).forEach(function(sec,si){ var w=renderSection(sec,si);
    var act=(sec.blocks||[]).some(function(bb){return bb.type==="table"&&bb.selectable;});
    if(act)anyAct=true; else anyNon=true; secEls.push({el:w,act:act}); root.appendChild(w); });
  if(anyAct&&anyNon&&secEls.length){
    var abar=el("div","actbar"); var tg=el("label","acttoggle"); var acb=el("input"); acb.type="checkbox";
    tg.appendChild(acb); tg.appendChild(document.createTextNode("Actionable only"));
    acb.onchange=function(){ secEls.forEach(function(s){ s.el.style.display=(acb.checked&&!s.act)?"none":""; }); };
    abar.appendChild(tg); root.insertBefore(abar, secEls[0].el);
  }

  if(Array.isArray(data.order)&&data.order.length){
    var o=el("div","order");
    data.order.forEach(function(it,i){ var r=el("div","oi");
      r.appendChild(el("div","num",String(i+1)));
      var d=el("div"); d.appendChild(el("div",null,"<strong>"+escapeHtml(it.title)+"</strong>"));
      d.appendChild(el("div","d",escapeHtml(it.detail))); r.appendChild(d); o.appendChild(r); });
    root.appendChild(o);
  }
  if(data.closing) root.appendChild(el("div","closing",escapeHtml(data.closing)));

  var f=el("footer","rpt");
  f.appendChild(el("span",null,escapeHtml(data.provenance||"")));
  f.appendChild(el("span",null,escapeHtml(data.generated||""))); root.appendChild(f);

  // ---- selection bar
  var bar=el("div","selbar");
  var barTxt=el("span"); var copyBtn=el("button","tbtn","Copy selection");
  var ta=el("textarea"); bar.appendChild(barTxt); bar.appendChild(copyBtn); bar.appendChild(ta);
  copyBtn.onclick=function(){ var parts=[]; Object.keys(selections).forEach(function(k){
      var s=selections[k]; var idx=Array.from(s.set).sort(function(a,b){return a-b});
      if(idx.length) parts.push(pastebackText(s.title,s.rows,idx)); });
    ta.value=parts.join("\\n\\n"); ta.select();
    try{navigator.clipboard.writeText(ta.value)}catch(e){}
    try{document.execCommand("copy")}catch(e){}
    copyBtn.textContent="Copied"; setTimeout(function(){copyBtn.textContent="Copy selection"},1500); };
  document.body.appendChild(bar);
  function refreshBar(){ var n=0; Object.keys(selections).forEach(function(k){n+=selections[k].set.size});
    barTxt.innerHTML="<b>"+n+"</b> row"+(n===1?"":"s")+" selected";
    bar.className="selbar"+(n?" on":""); }

  function renderSection(sec,si){
    var sev=sec.severity||"neutral";
    var wrap=el("div","sec "+sev+(sec.defaultOpen===false?" closed":""));
    var hd=el("div","head");
    hd.appendChild(el("span","pill "+sev,escapeHtml(sec.severityLabel||sev)));
    var h3=el("h3",null,escapeHtml(sec.title));
    if(sec.count)h3.appendChild(el("span","count"," · "+escapeHtml(sec.count)));
    hd.appendChild(h3); hd.appendChild(el("span","chev","\\u25be"));
    hd.onclick=function(){ wrap.classList.toggle("closed"); };
    wrap.appendChild(hd);
    var bodywrap=el("div","bodywrap"); var body=el("div","body"); var inner=el("div","bodyinner");
    if(sec.summary)inner.appendChild(el("div","summary",applyMicro(escapeHtml(sec.summary))));
    if(sec.lead)inner.appendChild(el("div","lead",sec.lead));
    (sec.blocks||[]).forEach(function(b,bi){ inner.appendChild(renderBlock(b,si+"-"+bi,sec.title)); });
    if(sec.footer)inner.appendChild(el("div","foot",escapeHtml(sec.footer)));
    body.appendChild(inner); bodywrap.appendChild(body); wrap.appendChild(bodywrap); return wrap;
  }

  function renderBlock(b,id,secTitle){
    if(b.type==="prose"||b.type==="lead") return el("div",b.type==="lead"?"lead":null,b.html);
    if(b.type==="subhead") return el("div","subhead",escapeHtml(b.text));
    if(b.type==="list"){ var ul=el("ul","rlist"+(b.crosses?" cross":""));
      (b.items||[]).forEach(function(it){ ul.appendChild(el("li",null,itemHtml(it))); }); return ul; }
    if(b.type==="table") return renderTable(b,id,secTitle);
    return el("div");
  }

  function renderTable(b,id,secTitle){
    var cols=b.columns||[], rows=b.rows||[];
    var state={sort:(typeof b.defaultSort==="number"?b.defaultSort:-1),
      dir:(b.defaultSortDir===1?1:-1), expanded:false, filter:"", facetSel:{}};
    if(b.selectable) selections[id]={title:secTitle,rows:rows,set:new Set()};
    var container=el("div");
    var ctl=el("div","tctl"); container.appendChild(ctl);
    var filterEl=null;
    if(rows.length>8){ filterEl=el("input","filter"); filterEl.placeholder="Filter…";
      filterEl.oninput=function(){ state.filter=filterEl.value.toLowerCase(); draw(); };
      ctl.appendChild(filterEl); }
    ctl.appendChild(el("span","tctl-sp"));
    function currentCsv(){ return tableToCsv(cols, order().map(function(i){return rows[i]})); }
    var copyBtn=el("button","xbtn","Copy CSV");
    copyBtn.title="Copy this table as CSV, in the current sort and filter";
    copyBtn.onclick=function(){ copyText(currentCsv()); flash(copyBtn,"Copied"); };
    var dlBtn=el("button","xbtn","CSV \\u2913"); dlBtn.title="Download this table as a CSV file";
    dlBtn.onclick=function(){ downloadCsv(currentCsv(),
      (secTitle||"report").replace(/[^a-z0-9]+/gi,"-").replace(/^-|-$/g,"").toLowerCase()+".csv"); };
    ctl.appendChild(copyBtn); ctl.appendChild(dlBtn);
    var facetWrap=el("div","facets"); container.appendChild(facetWrap);
    var chipList=[];
    function clearAll(){ state.filter=""; if(filterEl)filterEl.value=""; state.facetSel={};
      chipList.forEach(function(c){c.classList.remove("on")}); draw(); }
    facetableColumns(cols,rows).forEach(function(f){ var grp=el("div","facetgrp");
      grp.appendChild(el("span","fl",escapeHtml(cols[f.index].label)+":"));
      f.values.forEach(function(v){ var chip=el("span","facetchip",escapeHtml(v)); chipList.push(chip);
        chip.onclick=function(){ var set=state.facetSel[f.index]||(state.facetSel[f.index]=new Set());
          if(set.has(v)){set.delete(v);chip.classList.remove("on");}
          else {set.add(v);chip.classList.add("on");} draw(); };
        grp.appendChild(chip); });
      facetWrap.appendChild(grp); });
    var tw=el("div","tablewrap"); var table=el("table"); tw.appendChild(table);
    container.appendChild(tw);
    var emptyEl=el("div","empty"); emptyEl.style.display="none"; container.appendChild(emptyEl);
    var showBtn=el("button","showall"); container.appendChild(showBtn);
    if(b.moreNote)container.appendChild(el("div","morenote",applyMicro(escapeHtml(b.moreNote))));

    function order(){ var idx=rows.map(function(_,i){return i});
      if(state.sort>=0){ var num=cols[state.sort]&&cols[state.sort].numeric;
        idx.sort(function(a,b2){ var x=rows[a][state.sort],y=rows[b2][state.sort];
          var c=num?parseNumeric(x)-parseNumeric(y):String(x).localeCompare(String(y));
          return c*state.dir; }); }
      if(state.filter) idx=idx.filter(function(i){
        return rows[i].join(" ").toLowerCase().indexOf(state.filter)>=0; });
      var fk=Object.keys(state.facetSel);
      if(fk.length) idx=idx.filter(function(i){ return fk.every(function(k){
        var set=state.facetSel[k]; if(!set||!set.size)return true;
        return set.has(facetValue(rows[i][k])); }); });
      return idx;
    }
    function draw(){ table.innerHTML="";
      var thead=el("thead"); var htr=el("tr");
      if(b.selectable)htr.appendChild(el("th"));
      cols.forEach(function(c,ci){ var th=el("th",c.numeric?"numeric":null,escapeHtml(c.label)+
        (state.sort===ci?" <span class='ar'>"+(state.dir===1?"\\u25b2":"\\u25bc")+"</span>":""));
        th.setAttribute("scope","col"); th.setAttribute("role","button"); th.setAttribute("tabindex","0");
        th.setAttribute("aria-sort", state.sort===ci?(state.dir===1?"ascending":"descending"):"none");
        th.setAttribute("aria-label","Sort by "+(c.label||"column"));
        function doSort(){ if(state.sort===ci)state.dir=-state.dir; else{state.sort=ci;state.dir=1;} draw(); }
        th.onclick=doSort;
        th.onkeydown=function(e){ if(e.key==="Enter"||e.key===" "||e.key==="Spacebar"){ e.preventDefault(); doSort(); } };
        htr.appendChild(th); });
      thead.appendChild(htr); table.appendChild(thead);
      var tb=el("tbody"); var idx=order();
      if(idx.length===0){ tw.style.display="none"; showBtn.style.display="none";
        emptyEl.style.display=""; emptyEl.innerHTML="No rows match these filters. ";
        var clr=el("button",null,"Clear filters"); clr.onclick=clearAll; emptyEl.appendChild(clr); return; }
      tw.style.display=""; emptyEl.style.display="none";
      var cap=(!state.expanded&&typeof b.collapsedRows==="number")?b.collapsedRows:idx.length;
      idx.slice(0,cap).forEach(function(i){ var tr=el("tr");
        if(b.selectable){ var td=el("td"); var cb=el("input"); cb.type="checkbox";
          cb.checked=selections[id].set.has(i);
          cb.onchange=function(){ if(cb.checked)selections[id].set.add(i);
            else selections[id].set.delete(i); refreshBar(); };
          td.appendChild(cb); tr.appendChild(td); }
        rows[i].forEach(function(cell,ci){ tr.appendChild(el("td",cols[ci]&&cols[ci].numeric?"numeric":null,cellHtml(cell))); });
        tb.appendChild(tr); });
      table.appendChild(tb);
      var hidden=idx.length-cap;
      if(hidden>0){ showBtn.style.display=""; showBtn.textContent="Show all ("+idx.length+") \\u2192"; }
      else if(state.expanded&&typeof b.collapsedRows==="number"&&idx.length>b.collapsedRows){
        showBtn.style.display=""; showBtn.textContent="Show fewer"; }
      else showBtn.style.display="none";
    }
    showBtn.onclick=function(){ state.expanded=!state.expanded; draw(); };
    draw(); return container;
  }

  // default theme is light; honor a prior explicit toggle only.
  try{ if(localStorage.getItem("hcpapi-report-theme")==="dark"){
    document.documentElement.setAttribute("data-theme","dark"); themeBtn.textContent="Light"; } }catch(e){}
})();
`;

/** The full template with `__TITLE__` and `__REPORT_JSON__` tokens for render.ts. */
export function reportTemplate(): string {
  return `<!doctype html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>__TITLE__</title>
<style>${STYLE}</style>
</head>
<body>
<div class="wrap"><div id="app"></div></div>
<script id="report-data" type="application/json">__REPORT_JSON__</script>
<script>
${inlinedHelpers()}
${APP}
</script>
</body>
</html>`;
}
