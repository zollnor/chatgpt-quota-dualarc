/* Local quota UI and missing-navigation fallback. No external network, storage, or conversation-content access. */
(function installQuotaDualArc(root) {
  "use strict";
  const VERSION = "1.3.2";
  const MARKER = "data-quota-dual-arc";
  const DETAIL_MARKER = "data-quota-dual-details";
  const SVG_NS = "http://www.w3.org/2000/svg";
  const LABELS = new Set(["用量", "Usage", "使用情况", "使用情況"]);
  const DEFAULT_APPEARANCE={trackStyle:"dots",grayTone:"medium",centerMode:"flip"};
  const FLIP_INTERVAL_MS=5000;
  let appearance={...DEFAULT_APPEARANCE};

  function percentage(value) {
    return typeof value === "number" && Number.isFinite(value)
      ? Math.min(100, Math.max(0, value)) : null;
  }

  function parseDescription(text) {
    if (typeof text !== "string") return null;
    const labels = [
      {key:"fiveHour",match:/5\s*[-–]?\s*(?:小时|小時|hours?|h)/i.exec(text)},
      {key:"weekly",match:/(?:每周|每週|一周|一週|weekly)/i.exec(text)},
    ].filter(item=>item.match).sort((a,b)=>a.match.index-b.match.index);
    const result = {fiveHour:null,weekly:null};
    for(let i=0;i<labels.length;i++) {
      const {key,match}=labels[i],end=labels[i+1]?.match.index ?? text.length;
      const segment=text.slice(match.index+match[0].length,Math.min(end,match.index+160));
      const number=/([+-]?\d+(?:[.,]\d+)?)\s*[%％]/.exec(segment);
      if(!number)continue;
      const semantic=/剩余|剩餘|\bremaining\b|\bleft\b|\bavailable\b|已使用|已用|已消耗|\bused\b|\bconsumed\b/gi;
      const before=Array.from(segment.slice(0,number.index).matchAll(semantic));
      semantic.lastIndex=0;
      const after=semantic.exec(segment.slice(number.index+number[0].length).split(/[，,;；。]/)[0]);
      const meaning=before.at(-1)?.[0] ?? after?.[0];
      if(!meaning)continue;
      const value=percentage(Number(number[1].replace(",",".")));
      if(value!==null)result[key]=/已使用|已用|已消耗|\bused\b|\bconsumed\b/i.test(meaning)?100-value:value;
    }
    return result.fiveHour === null && result.weekly === null ? null : result;
  }

  function reconcileReadings(description,rate) {
    if(!description&&!rate)return null;
    const values={},conflicts={};
    for(const key of ["fiveHour","weekly"]) {
      const a=description?.[key] ?? null,b=rate?.[key] ?? null;
      conflicts[key]=a!==null&&b!==null&&Math.abs(a-b)>1;
      values[key]=conflicts[key]?null:a??b;
    }
    return {values,conflicts};
  }

  function fromRateLimit(rate) {
    if (!rate || typeof rate !== "object") return null;
    const result = {fiveHour: null, weekly: null};
    for (const bucket of [rate.primary_window, rate.secondary_window]) {
      if (!bucket || !Number.isFinite(bucket.limit_window_seconds)) continue;
      const used = percentage(bucket.used_percent);
      const value = used === null ? null : 100 - used;
      if (Math.abs(bucket.limit_window_seconds - 18000) <= 60) result.fiveHour = value;
      if (Math.abs(bucket.limit_window_seconds - 604800) <= 60) result.weekly = value;
    }
    return result.fiveHour === null && result.weekly === null ? null : result;
  }

  function resetWindows(rate) {
    const result={fiveHour:null,weekly:null};
    for(const bucket of [rate?.primary_window,rate?.secondary_window]) {
      if(!bucket||!Number.isFinite(bucket.limit_window_seconds)||!Number.isFinite(bucket.reset_at)||bucket.reset_at<=0)continue;
      const instant=bucket.reset_at<1e11?bucket.reset_at*1000:bucket.reset_at;
      if(Math.abs(bucket.limit_window_seconds-18000)<=60)result.fiveHour=instant;
      if(Math.abs(bucket.limit_window_seconds-604800)<=60)result.weekly=instant;
    }
    return result;
  }

  function formatReset(instant,now=Date.now(),timeZone=Intl.DateTimeFormat().resolvedOptions().timeZone) {
    if(!Number.isFinite(instant)||instant<=0)return "重置时间暂未提供";
    if(instant<=now)return "等待官方更新";
    const dateFormat=new Intl.DateTimeFormat("en-CA",{timeZone,year:"numeric",month:"2-digit",day:"2-digit"});
    const sameDay=dateFormat.format(instant)===dateFormat.format(now);
    const time=new Intl.DateTimeFormat("zh-CN",{timeZone,hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).format(instant);
    const date=sameDay?"":new Intl.DateTimeFormat("en-US",{timeZone,month:"2-digit",day:"2-digit"}).format(instant)+" ";
    const minutes=Math.ceil((instant-now)/60000),days=Math.floor(minutes/1440),hours=Math.floor(minutes/60),rest=minutes%60;
    const duration=days?`${days}天`:hours?`${hours}小时${rest?`${rest}分`:""}`:`${minutes}分`;
    return `重置 ${date}${time} · ${duration}后`;
  }

  function centerMetric(data,resets,mode="lowest",now=Date.now(),activeWindow="fiveHour") {
    if(mode==="flip"){
      const key=activeWindow==="weekly"?"weekly":"fiveHour",label=key==="fiveHour"?"5 小时":"一周",value=data[key];
      return value===null||!Number.isFinite(value)?{text:"—",key,title:`${label}额度暂未提供或正在同步`}:{text:String(Math.round(value)),key,title:`${label}剩余额度：${Math.round(value)}%`};
    }
    if(mode==="none")return {text:"",key:null,title:"中心留白"};
    if(mode==="dual")return {text:"",key:null,title:"上方为 5 小时，下方为一周剩余百分比",values:[data.fiveHour,data.weekly]};
    if(mode==="countdown") {
      if(![resets.fiveHour,resets.weekly].every(value=>Number.isFinite(value)&&value>now))return {text:"—",key:null,title:"重置时间尚不完整或等待更新"};
      const key=resets.fiveHour<=resets.weekly?"fiveHour":"weekly",minutes=Math.max(1,Math.ceil((resets[key]-now)/60000));
      const text=minutes>=1440?`${Math.floor(minutes/1440)}d`:minutes>=60?`${Math.floor(minutes/60)}h`:`${minutes}m`;
      return {text,key,title:`较早重置：${key==="fiveHour"?"5 小时":"一周"}，${formatReset(resets[key],now)}`};
    }
    if(![data.fiveHour,data.weekly].every(Number.isFinite))return {text:"—",key:null,title:"至少一项额度尚未提供或正在同步"};
    const key=data.fiveHour===data.weekly?null:data.fiveHour<data.weekly?"fiveHour":"weekly";
    const value=Math.round(Math.min(data.fiveHour,data.weekly));
    return {text:String(value),key,title:`较低剩余额度：${key==="fiveHour"?"5 小时":key==="weekly"?"一周":"两项相同"} ${value}%`};
  }

  const point = (angle) => ({x:16 + 12.5*Math.cos(angle*Math.PI/180), y:16 + 12.5*Math.sin(angle*Math.PI/180)});
  function arc(start, end) {
    const a = point(start), b = point(end);
    return {radius:12.5,span:end-start,startAngle:start,endAngle:end,start:a,end:b,path:`M${a.x.toFixed(4)} ${a.y.toFixed(4)} A12.5 12.5 0 0 1 ${b.x.toFixed(4)} ${b.y.toFixed(4)}`};
  }
  const geometry = {top:arc(192,348),bottom:arc(12,168)};
  const exports = {parseDescription,fromRateLimit,geometry,percentage,reconcileReadings,resetWindows,formatReset,centerMetric};
  if (typeof module !== "undefined" && module.exports) {
    module.exports = exports;
    return;
  }
  if (!root.document || root.location.protocol !== "app:" || root.location.hostname !== "-") return;
  if (!document.documentElement) {
    document.addEventListener("DOMContentLoaded",() => installQuotaDualArc(root),{once:true});
    return;
  }
  if (root.__chatgptQuotaDualArc?.version === VERSION) {
    root.__chatgptQuotaDualArc.refresh();
    return;
  }
  root.__chatgptQuotaDualArc?.uninstall();
  document.getElementById("quota-debug-local")?.remove();

  function createNavigationFallback(onChange,environment={}) {
    const doc=environment.document ?? root.document;
    const load=environment.importRuntime ?? (source=>import(source));
    const now=environment.now ?? (()=>Date.now());
    const gateKey="3085093835"; // The installed app's navigation presentation gate.
    let disposed=false,busy=false,lastAttempt=-Infinity,owned=null,state="idle";

    function release() {
      if(!owned)return;
      const previous=owned;owned=null;
      try {
        previous.unsubscribe?.();
        const official=previous.client.getFeatureGate(gateKey,{disableExposureLog:true});
        if(previous.scope.get(previous.signal,gateKey)===true)
          previous.scope.set(previous.signal,gateKey,official.details?.reason==="NoValues"?previous.value:official.value);
      } catch {state="restore-unavailable";}
    }

    async function refresh() {
      if(disposed||busy)return;
      if(owned) {
        try {
          const gate=owned.client.getFeatureGate(gateKey,{disableExposureLog:true});
          if(owned.scope.get(owned.eligibility)?.status!=="allowed") {
            release();state="ineligible-navigation";onChange();
          } else if(gate.details?.reason!=="NoValues") {
            release();state="official-configuration-restored";onChange();
          } else if(owned.scope.get(owned.signal,gateKey)!==true) {
            // A failed official refresh can write its empty default again.
            owned.scope.set(owned.signal,gateKey,true);onChange();
          }
        } catch {release();state="unavailable";}
        return;
      }
      if(doc.querySelector('[data-app-navigation-rail]')) {state="native-navigation";return;}
      const anchor=doc.querySelector('aside');
      const entry=Array.from(doc.scripts).find(script=>/\/348410\.[a-z0-9]+\.js$/.test(script.src));
      if(!anchor||!entry||now()-lastAttempt<5000)return;
      busy=true;lastAttempt=now();
      try {
        const runtime=await load(entry.src);
        if(disposed)return;
        const req=runtime.__webpack_require__;
        const required=['OWtl','GNwQ','OMIV','eFn4','nlNF','d1ji'];
        if(typeof req!=="function"||!required.every(key=>req.c?.[key])) {state="unsupported-runtime";return;}
        const token=req('OWtl').u;
        let fiber=anchor[Object.keys(anchor).find(key=>key.startsWith('__reactFiber$'))],chain=null;
        for(let depth=0;fiber&&depth<500;depth++,fiber=fiber.return) {
          const value=fiber.memoizedProps?.value;
          if(value instanceof Map&&value.has(token.id)) {chain=value;break;}
        }
        if(!chain) {state="waiting-for-app-scope";return;}
        const scope=req('GNwQ').GB(token,chain,chain.get(token.id));
        const signal=req('OMIV').JW,client=scope.get(req('OMIV').M9);
        if(typeof client?.getFeatureGate!=="function") {state="waiting-for-configuration";return;}
        const gate=client.getFeatureGate(gateKey,{disableExposureLog:true});
        // Only supply a missing UI choice. Never replace a real server value or an access decision.
        if(gate.details?.reason!=="NoValues") {state="official-configuration";return;}
        if(scope.get(req('eFn4').lN)?.status!=="allowed") {state="ineligible-navigation";return;}
        const location=scope.get(req('nlNF').x2);
        if(scope.get(req('d1ji').MF,location)!=="legacy") {state="native-navigation";return;}
        const value=scope.get(signal,gateKey);
        if(value!==false) {state="native-navigation";return;}
        owned={scope,signal,client,value,eligibility:req('eFn4').lN};
        if(typeof client.on==="function"&&typeof client.off==="function") {
          const changed=()=>refresh();client.on('values_updated',changed);
          owned.unsubscribe=()=>client.off('values_updated',changed);
        }
        scope.set(signal,gateKey,true);
        state="local-navigation-fallback";onChange();
      } catch {
        release();state="unavailable";
      } finally {busy=false;}
    }

    return {refresh,inspect:()=>({state,active:owned!==null}),uninstall:()=>{disposed=true;release();}};
  }

  function createLocalQuotaFallback(onChange,environment={}) {
    const doc=environment.document ?? root.document,now=environment.now ?? (()=>Date.now());
    let disposed=false,busy=false,context=null,button=null,rate=null,account=null,updated=0,nextRead=0,state="idle";
    const marker='data-local-quota-fallback';
    const remove=()=>{const changed=Boolean(button);button?.remove();button=null;rate=null;account=null;updated=0;if(changed)onChange();};
    async function resolveContext() {
      if(environment.getContext)return environment.getContext();
      const entry=Array.from(doc.scripts).find(e=>/\/348410\.[a-z0-9]+\.js$/.test(e.src)),anchor=doc.querySelector('aside');
      if(!entry||!anchor)return null;
      const req=(await import(entry.src)).__webpack_require__;
      if(!['OWtl','GNwQ','Dgwo','SPnB','eFn4'].every(key=>req.c?.[key]))return null;
      const token=req('OWtl').u;let fiber=anchor[Object.keys(anchor).find(key=>key.startsWith('__reactFiber$'))],chain=null;
      for(let i=0;fiber&&i<500;i++,fiber=fiber.return){const value=fiber.memoizedProps?.value;if(value instanceof Map&&value.has(token.id)){chain=value;break;}}
      if(!chain)return null;
      const scope=req('GNwQ').GB(token,chain,chain.get(token.id));
      return {account:()=>scope.get(req('SPnB').chatGptAuthenticatedAccountId$),eligible:()=>scope.get(req('eFn4').ph)===true,
        read:()=>req('Dgwo').V(scope,'local').sendRequest('account/rateLimits/read',{})};
    }
    function mount(rail,profile) {
      if(!button){
        button=doc.createElement('button');button.type='button';button.setAttribute(marker,'true');button.setAttribute('aria-label','Usage');
        button.style.cssText='position:absolute;width:36px;height:36px;display:grid;place-items:center;padding:0;border:0;border-radius:8px;background:transparent;color:inherit;cursor:pointer';
        const holder=doc.createElement('span');holder.style.cssText='position:relative;display:inline-flex;width:28px;height:28px';
        const svg=doc.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','2.5 2.5 27 27');svg.style.cssText='position:absolute;inset:0;margin:auto;width:24px;height:24px';
        const path=doc.createElementNS('http://www.w3.org/2000/svg','path');path.setAttribute('d','M16 3.5 A12.5 12.5 0 1 1 16 28.5 A12.5 12.5 0 1 1 16 3.5');path.setAttribute('pathLength','100');path.setAttribute('stroke','currentColor');path.setAttribute('stroke-width','1.9');path.setAttribute('fill','none');
        svg.append(path);holder.append(svg);button.append(holder);
      }
      if(button.parentElement!==rail)rail.append(button);
      const r=rail.getBoundingClientRect(),p=profile.getBoundingClientRect();
      const left=`${p.x-r.x}px`,top=`${p.y-r.y-44}px`;
      if(button.style.left!==left)button.style.left=left;if(button.style.top!==top)button.style.top=top;
      const values=fromRateLimit(rate);
      const description=`5-hour usage: ${Math.round(values.fiveHour)}% left. Weekly usage: ${Math.round(values.weekly)}% left.`;
      if(button.getAttribute('aria-description')!==description)button.setAttribute('aria-description',description);
    }
    async function refresh() {
      if(disposed)return;
      const native=Array.from(doc.querySelectorAll('button[aria-label]')).some(e=>{const r=e.getBoundingClientRect();return !e.hasAttribute(marker)&&LABELS.has(e.getAttribute('aria-label'))&&r.width>0&&r.height>0&&r.width<=90&&r.height<=90&&r.x<180});
      if(native){remove();nextRead=0;state="native-quota";return;}
      const rail=doc.querySelector('[data-app-navigation-rail]');
      const profiles=rail?Array.from(rail.querySelectorAll('button[aria-haspopup="menu"]')).filter(e=>{const r=e.getBoundingClientRect();return r.y>(doc.defaultView?.innerHeight??innerHeight)-120&&r.width>0}):[];
      if(!rail||profiles.length!==1){remove();return;}
      let acquired=false;
      try {
        context=await resolveContext();if(disposed)return;
        const activeAccount=context?.account();
        if(!context||!context.eligible()||typeof activeAccount!=='string'){remove();state="unavailable";return;}
        if(account!==null&&account!==activeAccount){remove();nextRead=0;}
        if(rate&&now()-updated>=120000){remove();state="expired";}
        if(rate)mount(rail,profiles[0]);
        if(busy)return;
        if(now()<nextRead)return;
        busy=true;acquired=true;
        nextRead=now()+60000;state="reading-local-quota";
        const response=await context.read();if(disposed)return;
        const latest=await resolveContext();if(disposed)return;
        if(!latest||response?.accountId!==latest.account()||!latest.eligible()){remove();state="account-mismatch";return;}
        const windows=[response?.rateLimits?.primary,response?.rateLimits?.secondary];
        const mapped=windows.map(w=>w?{limit_window_seconds:w.windowDurationMins*60,used_percent:w.usedPercent,reset_at:w.resetsAt}:null);
        const candidate={primary_window:mapped[0],secondary_window:mapped[1]},values=fromRateLimit(candidate);
        if(!values||values.fiveHour===null||values.weekly===null||mapped.some(w=>!w||!Number.isFinite(w.reset_at))){remove();state="unsupported-windows";return;}
        rate=candidate;account=response.accountId;updated=now();mount(rail,profiles[0]);state="official-local-quota";onChange();
      } catch {state="local-quota-unavailable";if(!updated||now()-updated>=120000)remove();}
      finally {if(acquired)busy=false;}
    }
    return {refresh,rateFor:element=>element===button?rate:null,inspect:()=>({state,active:Boolean(button?.isConnected),source:button?'official-local-app-server':null,ageMs:updated?now()-updated:null}),uninstall:()=>{disposed=true;remove();}};
  }

  let navigationFallback=null,navigationSession=null,localQuotaFallback=null;

  // Only follow the quota button's React ancestors, and only read the usage rate-limit fields.
  function rawRateFromButton(button) {
    const local=localQuotaFallback?.rateFor(button);if(local)return local;
    const key = Object.keys(button).find((name) => name.startsWith("__reactFiber$"));
    let fiber = key ? button[key] : null;
    for (let depth=0;fiber && depth<30;depth++,fiber=fiber.return) {
      for (const props of [fiber.memoizedProps, fiber.pendingProps]) {
        const rate=props?.usage?.rate_limit;
        if(rate&&[rate.primary_window,rate.secondary_window].some(b=>Number.isFinite(b?.limit_window_seconds)&&[18000,604800].some(seconds=>Math.abs(b.limit_window_seconds-seconds)<=60)))return rate;
      }
    }
    return null;
  }
  function rateFromButton(button){return fromRateLimit(rawRateFromButton(button));}

  function dataFromButton(button) {
    const description = parseDescription(button.getAttribute("aria-description"));
    const raw=rawRateFromButton(button),result=reconcileReadings(description,fromRateLimit(raw));
    return result?{...result,resets:resetWindows(raw)}:null;
  }

  function paletteFor(button) {
    const css=getComputedStyle(button).color,parts=css.match(/[\d.]+/g)?.map(Number) ?? [];
    const unit=css.startsWith("color(")?1:255;
    const scheme=getComputedStyle(button).colorScheme;
    const lightText=scheme==="dark"?true:scheme==="light"?false:parts.length>=3?(.2126*parts[0]+.7152*parts[1]+.0722*parts[2])/unit>.55:matchMedia("(prefers-color-scheme:dark)").matches;
    return lightText?
      {upper:"#79BAFF",lower:"#EFC187",dotWidth:1.4,gray:{soft:"#636F7E",medium:"#8793A2",bright:"#B5BFCC"},surface:"#242A33",border:"#465160",text:"#F1F5FB",muted:"#B7C3D3",warning:"#F2AD82"}:
      {upper:"#1858A8",lower:"#895800",dotWidth:1.65,gray:{soft:"#7E899A",medium:"#5F6D82",bright:"#43546B"},surface:"#FFFFFF",border:"#CED7E4",text:"#233046",muted:"#586A81",warning:"#9B512E"};
  }

  function createDetails(button) {
    const id="chatgpt-quota-dual-details";
    const tip=document.createElement("div");tip.id=id;tip.setAttribute(DETAIL_MARKER,VERSION);
    tip.setAttribute("popover","manual");
    tip.setAttribute("role","tooltip");tip.setAttribute("aria-label","额度双弧详情");tip.setAttribute("aria-hidden","true");tip.hidden=true;
    tip.style.cssText="all:initial;box-sizing:border-box;position:fixed;z-index:2147483000;display:none;width:228px;padding:10px 12px;border:1px solid;border-radius:10px;font:12px/1.5 'Segoe UI','Microsoft YaHei UI',sans-serif;box-shadow:0 10px 28px rgba(0,0,0,.26);pointer-events:auto;";
    const element=(tag,css,text)=>{const e=document.createElement(tag);e.style.cssText=css;if(text!==undefined)e.textContent=text;return e;};
    const heading=element("div","font-size:10px;margin-bottom:5px;","剩余额度");tip.append(heading);
    const rows=["5 小时","一周"].map((name,index)=>{
      const row=element("div",`padding:7px 0;${index?"border-top:1px solid;":""}`);
      const main=element("div","display:flex;align-items:center;justify-content:space-between;gap:10px;");
      const label=element("span","display:flex;align-items:center;gap:7px;font-size:12px;");
      const dot=element("span","display:inline-block;width:5px;height:5px;border-radius:50%;flex-shrink:0;");label.append(dot,document.createTextNode(name));
      const right=element("span","display:flex;align-items:baseline;gap:8px;");
      const state=element("span","font-size:10px;");
      const value=element("span","font:600 16px/1.2 Consolas,'Cascadia Code',monospace;font-variant-numeric:tabular-nums;");
      const reset=element("div","font-size:10px;margin-top:4px;white-space:nowrap;");reset.setAttribute("data-reset",index?"weekly":"five-hour");
      right.append(state,value);main.append(label,right);row.append(main,reset);tip.append(row);return {row,label,dot,state,value,reset};
    });
    document.body.append(tip);
    const described=(button.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean);
    if(!described.includes(id))button.setAttribute("aria-describedby",[...described,id].join(" "));
    const bindings=[];let openTimer=0,closeTimer=0,visible=false,suppressed=false;
    function bind(node,type,fn,capture=false){node.addEventListener(type,fn,capture);bindings.push([node,type,fn,capture]);}
    function position(){
      if(!visible)return;
      const b=button.getBoundingClientRect(),box=tip.getBoundingClientRect();
      const left=Math.max(8,Math.min(b.right+10,innerWidth-box.width-8));
      const top=Math.max(8,Math.min(b.bottom-box.height,innerHeight-box.height-8));
      const x=`${Math.round(left)}px`,y=`${Math.round(top)}px`;
      if(tip.style.left!==x)tip.style.left=x;if(tip.style.top!==y)tip.style.top=y;
    }
    function hide(){clearTimeout(openTimer);clearTimeout(closeTimer);visible=false;if(tip.matches(":popover-open"))tip.hidePopover();tip.hidden=true;tip.style.display="none";tip.setAttribute("aria-hidden","true");}
    function show(){
      clearTimeout(openTimer);clearTimeout(closeTimer);
      if(suppressed||button.getAttribute("aria-expanded")==="true")return;
      visible=true;tip.hidden=false;tip.style.display="block";tip.setAttribute("aria-hidden","false");if(!tip.matches(":popover-open"))tip.showPopover();position();
    }
    function leave(){clearTimeout(openTimer);suppressed=false;closeTimer=setTimeout(()=>{if(document.activeElement!==button)hide();},180);}
    bind(button,"pointerenter",event=>{if(event.pointerType==="touch")return;pauseCenterFlip("hover");suppressed=false;clearTimeout(closeTimer);openTimer=setTimeout(show,160);});
    bind(button,"pointerleave",()=>{resumeCenterFlip("hover");leave();});bind(button,"focus",()=>{if(button.matches(":focus-visible"))pauseCenterFlip("focus");suppressed=false;show();});bind(button,"blur",()=>{resumeCenterFlip("focus");hide();});
    bind(button,"click",()=>{if(button.hasAttribute("data-local-quota-fallback")){suppressed=false;show();return;}pauseCenterFlip("menu");suppressed=true;hide();});
    bind(button,"keydown",event=>{if(event.key==="Escape"){suppressed=true;hide();}});
    // The old tooltip uses different arc hit regions. Keep its hover handlers from competing.
    for(const type of ["pointerover","mouseover","pointermove"])bind(button,type,event=>event.stopPropagation(),true);
    bind(tip,"pointerenter",()=>{pauseCenterFlip("details");clearTimeout(closeTimer);});bind(tip,"pointerleave",()=>{resumeCenterFlip("details");leave();});
    bind(root,"resize",position);bind(root,"scroll",position,true);
    return {
      update(data,conflicts,resets,palette){
        tip.style.background=palette.surface;tip.style.borderColor=palette.border;tip.style.color=palette.text;
        heading.style.color=palette.muted;
        for(const [index,key]of [[0,"fiveHour"],[1,"weekly"]]){
          const row=rows[index],value=data[key],pending=conflicts[key];
          row.dot.style.background=index?palette.lower:palette.upper;
          row.row.style.borderColor=palette.border;
          row.reset.style.color=palette.muted;
          const resetText=conflicts[key]?"重置时间待同步":formatReset(resets[key]);
          if(row.reset.textContent!==resetText)row.reset.textContent=resetText;
          row.state.textContent=pending?"同步中":value===null?"暂未提供":value===0?"已用尽":value<=10?"偏低":"";
          row.state.style.color=pending||value!==null&&value<=10?palette.warning:palette.muted;
          const text=value===null?"—":`${Math.round(value)}%`;if(row.value.textContent!==text)row.value.textContent=text;
        }
        position();
      },
      isHovered:()=>visible&&tip.matches(":hover"),
      destroy(){hide();for(const [node,type,fn,capture]of bindings)node.removeEventListener(type,fn,capture);tip.remove();
        const next=(button.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(token=>token&&token!==id);
        if(next.length)button.setAttribute("aria-describedby",next.join(" "));else button.removeAttribute("aria-describedby");
      },
    };
  }

  function attr(node, name, value) {
    value = String(value);
    if (node.getAttribute(name) !== value) node.setAttribute(name,value);
  }
  function svgElement(name, attributes) {
    const node = document.createElementNS(SVG_NS,name);
    for (const [key,value] of Object.entries(attributes)) node.setAttribute(key,value);
    return node;
  }
  function makeArc(name,shape,color) {
    const group = svgElement("g",{"data-window":name});
    const title = svgElement("title",{});
    const track = svgElement("path",{d:shape.path,fill:"none",stroke:color,"stroke-width":1.75,"stroke-linecap":"round",pathLength:100,"data-used":name});
    const fill = svgElement("path",{d:shape.path,fill:"none",stroke:color,"stroke-width":1.9,"stroke-linecap":"round",pathLength:100,"data-fill":name});
    group.append(title,track,fill);
    return {group,title,track,fill};
  }
  let current = null, stopped = false, pending = false,flipTimer=0;
  let status = "waiting-for-quota-button";
  const retryAfter = new WeakMap();
  const reducedMotion=root.matchMedia("(prefers-reduced-motion: reduce)");

  function cancelCenterFlip(){
    clearTimeout(flipTimer);flipTimer=0;
    if(current?.center.animation){const animation=current.center.animation;current.center.animation=null;current.center.animating=false;animation.cancel();}
  }
  function pauseCenterFlip(reason){if(!current)return;current.center.paused.add(reason);cancelCenterFlip();}
  function resumeCenterFlip(reason){if(!current)return;current.center.paused.delete(reason);syncCenterFlip();}
  function updateFlipEnvironment(){
    if(!current)return;
    for(const [reason,paused]of [["hover",current.center.paused.has("hover")&&current.button.matches(":hover")],["details",current.center.paused.has("details")&&current.details.isHovered()],["hidden",document.hidden],["menu",current.button.getAttribute("aria-expanded")==="true"],["focus",document.activeElement===current.button&&current.button.matches(":focus-visible")]]){
      if(paused)current.center.paused.add(reason);else current.center.paused.delete(reason);
    }
  }
  function syncCenterFlip(){
    if(!current||stopped)return;
    updateFlipEnvironment();
    if(appearance.centerMode!=="flip"||current.center.paused.size){cancelCenterFlip();return;}
    if(!flipTimer&&!current.center.animating)flipTimer=setTimeout(beginCenterFlip,FLIP_INTERVAL_MS);
  }
  function beginCenterFlip(){
    flipTimer=0;
    if(!current||stopped||appearance.centerMode!=="flip")return;
    updateFlipEnvironment();if(current.center.paused.size)return;
    const owner=current.center,next=owner.activeWindow==="fiveHour"?"weekly":"fiveHour";
    if(reducedMotion.matches){owner.activeWindow=next;updateCenter(current.data,current.resets,paletteFor(current.button));return;}
    owner.animating=true;
    const out=owner.group.animate([{transform:"perspective(120px) rotateX(0deg)",opacity:1},{transform:"perspective(120px) rotateX(90deg)",opacity:0}],{duration:140,easing:"cubic-bezier(.4,0,1,1)",fill:"forwards"});
    owner.animation=out;
    out.onfinish=()=>{
      if(current?.center!==owner||owner.animation!==out||!owner.animating)return;
      owner.activeWindow=next;out.cancel();
      updateCenter(current.data,current.resets,paletteFor(current.button));
      const incoming=owner.group.animate([{transform:"perspective(120px) rotateX(-90deg)",opacity:0},{transform:"perspective(120px) rotateX(0deg)",opacity:1}],{duration:180,easing:"cubic-bezier(0,0,.2,1)"});
      owner.animation=incoming;
      incoming.onfinish=()=>{if(current?.center!==owner||owner.animation!==incoming)return;owner.animation=null;owner.animating=false;syncCenterFlip();};
    };
  }
  function onFlipVisibility(){syncCenterFlip();}
  function onFlipMotionPreference(){cancelCenterFlip();syncCenterFlip();}
  document.addEventListener("visibilitychange",onFlipVisibility);reducedMotion.addEventListener("change",onFlipMotionPreference);

  function restoreSymbol() {
    if(!current?.symbol)return;
    const symbol=current.symbol;
    if(current.oldSymbolVisibility)symbol.style.setProperty("visibility",current.oldSymbolVisibility,current.oldSymbolPriority);
    else symbol.style.removeProperty("visibility");
    symbol.removeAttribute("data-quota-previous-symbol-visibility");symbol.removeAttribute("data-quota-previous-symbol-priority");current.symbol=null;
  }
  function syncSymbol() {
    const symbol=Array.from(current.meter.parentElement?.children ?? []).find(e=>e.tagName==="SPAN"&&e.querySelector("svg")) ?? null;
    if(current.symbol!==symbol){
      restoreSymbol();
      if(symbol){
        current.symbol=symbol;
        current.oldSymbolVisibility=symbol.getAttribute("data-quota-previous-symbol-visibility") ?? symbol.style.getPropertyValue("visibility");
        current.oldSymbolPriority=symbol.getAttribute("data-quota-previous-symbol-priority") ?? symbol.style.getPropertyPriority("visibility");
        symbol.setAttribute("data-quota-previous-symbol-visibility",current.oldSymbolVisibility);symbol.setAttribute("data-quota-previous-symbol-priority",current.oldSymbolPriority);
      }
    }
    if(symbol&&symbol.style.getPropertyValue("visibility")!=="hidden")symbol.style.setProperty("visibility","hidden","important");
  }
  function updateCenter(data,resets,palette) {
    const nodes=current.center;
    if(nodes.mode!==appearance.centerMode){cancelCenterFlip();nodes.mode=appearance.centerMode;nodes.activeWindow="fiveHour";}
    const metric=centerMetric(data,resets,appearance.centerMode,Date.now(),nodes.activeWindow);
    if(nodes.title.textContent!==metric.title)nodes.title.textContent=metric.title;
    attr(nodes.group,"data-mode",appearance.centerMode);
    const dual=appearance.centerMode==="dual";
    attr(nodes.single,"display",dual||appearance.centerMode==="none"?"none":"inline");
    attr(nodes.dualGroup,"display",dual?"inline":"none");
    if(nodes.single.textContent!==metric.text)nodes.single.textContent=metric.text;
    attr(nodes.single,"font-size",metric.text.length>=3?10:12.2);
    attr(nodes.single,"fill",metric.key==="fiveHour"?palette.upper:metric.key==="weekly"?palette.lower:palette.text);
    [data.fiveHour,data.weekly].forEach((value,index)=>{const text=value===null?"—":String(Math.round(value));if(nodes.dualTexts[index].textContent!==text)nodes.dualTexts[index].textContent=text;attr(nodes.dualTexts[index],"fill",index?palette.lower:palette.upper);});
    current.centerValue=metric;
    syncCenterFlip();
  }
  function updateTrack(part,shape,value,palette) {
    const unknown=value===null,style=appearance.trackStyle;
    attr(part.track,"stroke",palette.gray[appearance.grayTone]);attr(part.track,"stroke-width",style==="dots"?palette.dotWidth:1.75);
    attr(part.track,"opacity",!unknown&&value===100?0:1);
    if(unknown||style!=="solid"){
      part.track.removeAttribute("pathLength");
      const path=unknown||value===100?shape.path:arc(shape.startAngle+shape.span*value/100,shape.endAngle).path;
      attr(part.track,"d",path);attr(part.track,"stroke-dasharray",unknown?"1.5 3":style==="dots"?"0.01 2.6":"1.8 2.2");attr(part.track,"stroke-dashoffset",0);
    }else{
      attr(part.track,"pathLength",100);attr(part.track,"d",shape.path);attr(part.track,"stroke-dasharray",`${100-value} 100`);attr(part.track,"stroke-dashoffset",-value);
    }
  }

  function replacementVisible(svg,meter,button) {
    const b=svg.getBoundingClientRect(),n=meter.getBoundingClientRect(),q=button.getBoundingClientRect();
    if (b.width<8 || b.height<8 || b.width>q.width || b.height>q.height) return false;
    if (Math.abs((b.x+b.width/2)-(n.x+n.width/2))>3 || Math.abs((b.y+b.height/2)-(n.y+n.height/2))>3) return false;
    for(let node=svg;node && node!==button.parentElement;node=node.parentElement) {
      const style=getComputedStyle(node);
      if(style.display==="none" || style.visibility!=="visible" || Number(style.opacity)<=.01) return false;
    }
    return true;
  }

  function restore() {
    if (!current) return;
    cancelCenterFlip();
    current.details.destroy();
    restoreSymbol();
    current.svg.remove();
    if (current.oldVisibility) current.meter.style.setProperty("visibility",current.oldVisibility,current.oldPriority);
    else current.meter.style.removeProperty("visibility");
    current.meter.removeAttribute("data-quota-previous-visibility");
    current.meter.removeAttribute("data-quota-previous-priority");
    current = null;
  }

  function selectButton() {
    return Array.from(document.querySelectorAll("button[aria-label]"))
      .filter((button) => LABELS.has(button.getAttribute("aria-label")))
      .filter((button) => {
        const box = button.getBoundingClientRect();
        return box.width>0 && box.height>0 && box.width<=90 && box.height<=90 && box.x<180;
      });
  }

  function refresh() {
    navigationFallback?.refresh();
    localQuotaFallback?.refresh();
    pending = false;
    if (stopped) return;
    const buttons = selectButton();
    if (buttons.length !== 1) {
      restore();
      status = buttons.length ? "skipped-ambiguous-buttons" : "waiting-for-quota-button";
      return;
    }
    const button = buttons[0],reading=dataFromButton(button),data=reading?.values;
    const meter = Array.from(button.querySelectorAll("svg"))
      .find((svg) => !svg.hasAttribute(MARKER) && svg.querySelector('path[pathLength="100"]'));
    if (!data || !meter || !meter.parentElement) {
      restore();
      status = "skipped-unrecognized-quota-structure";
      return;
    }
    if (current && (current.button !== button || current.meter !== meter || !current.svg.isConnected)) restore();
    if (!current && (retryAfter.get(meter) ?? 0)>Date.now()) {
      status="skipped-unrendered-dual-arc";
      return;
    }
    if (!current) {
      const palette=paletteFor(button);
      const svg = svgElement("svg",{[MARKER]:VERSION,viewBox:"2.5 2.5 27 27",fill:"none","aria-hidden":"true","data-no-autosize":"true"});
      svg.style.cssText = "position:absolute;inset:0;margin:auto;width:28px;height:28px;overflow:visible;pointer-events:none;z-index:1";
      const top = makeArc("five-hour",geometry.top,palette.upper);
      const bottom = makeArc("weekly",geometry.bottom,palette.lower);
      const centerGroup=svgElement("g",{"data-quota-center":"true"});
      centerGroup.style.cssText="transform-box:fill-box;transform-origin:50% 50%;backface-visibility:hidden";
      const centerTitle=svgElement("title",{});
      const centerText=svgElement("text",{x:16,y:16.6,"text-anchor":"middle","dominant-baseline":"central","font-family":"Consolas, monospace","font-weight":600,"letter-spacing":"-.35px"});
      const dualGroup=svgElement("g",{});
      const dualTexts=[12.3,20.8].map(y=>svgElement("text",{x:16,y,"text-anchor":"middle","dominant-baseline":"central","font-family":"Consolas, monospace","font-size":8,"font-weight":600}));
      dualGroup.append(...dualTexts);centerGroup.append(centerTitle,centerText,dualGroup);svg.append(top.group,bottom.group,centerGroup);
      // Native hover boundaries use the old unequal arcs. Our SVG owns its titles instead.
      svg.addEventListener("pointermove",(event) => event.stopPropagation());
      const oldVisibility = meter.getAttribute("data-quota-previous-visibility") ?? meter.style.getPropertyValue("visibility");
      const oldPriority = meter.getAttribute("data-quota-previous-priority") ?? meter.style.getPropertyPriority("visibility");
      meter.setAttribute("data-quota-previous-visibility",oldVisibility);
      meter.setAttribute("data-quota-previous-priority",oldPriority);
      current = {button,meter,svg,top,bottom,oldVisibility,oldPriority,data:null,symbol:null,details:createDetails(button),center:{group:centerGroup,title:centerTitle,single:centerText,dualGroup,dualTexts,activeWindow:"fiveHour",mode:null,animation:null,animating:false,paused:new Set([...(button.matches(":hover")?["hover"]:[]),...(document.activeElement===button&&button.matches(":focus-visible")?["focus"]:[])])}};
      meter.parentElement.appendChild(svg);
    }
    const palette=paletteFor(button);
    for (const [part,value,label,color,shape] of [[current.top,data.fiveHour,"5 小时",palette.upper,geometry.top],[current.bottom,data.weekly,"一周",palette.lower,geometry.bottom]]) {
      const unknown = value === null;
      const text = unknown ? `${label}额度：应用暂未提供数据` : `${label}额度：剩余 ${Math.round(value)}%`;
      if (part.title.textContent !== text) part.title.textContent = text;
      attr(part.fill,"stroke",color);
      attr(part.fill,"stroke-dasharray",`${unknown ? 0 : value} 100`);
      attr(part.fill,"opacity",unknown || value === 0 ? 0 : 1);
      updateTrack(part,shape,value,palette);
      attr(part.group,"data-quota-state",unknown ? "unknown" : "known");
    }
    if (!replacementVisible(current.svg,meter,button)) {
      retryAfter.set(meter,Date.now()+650);
      restore();
      status="skipped-unrendered-dual-arc";
      return;
    }
    if (meter.style.getPropertyValue("visibility") !== "hidden") meter.style.setProperty("visibility","hidden","important");
    syncSymbol();
    current.data = data;
    current.conflicts=reading.conflicts;
    current.resets=reading.resets;
    updateCenter(data,reading.resets,palette);
    current.details.update(data,reading.conflicts,reading.resets,palette);
    status = data.fiveHour === null || data.weekly === null ? "applied-with-unknown-window" : "applied";
  }

  function schedule() {
    if (stopped || pending) return;
    pending = true;
    setTimeout(refresh,60);
  }
  const observer = new MutationObserver((records) => {
    if (records.some((record) => {
      const element = record.target.nodeType===1 ? record.target : record.target.parentElement;
      return !element?.closest?.(`[${MARKER}],[${DETAIL_MARKER}]`);
    })) schedule();
  });
  observer.observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:["aria-description","aria-label","aria-expanded","style","d"]});
  const timer = setInterval(schedule,2000);
  const api = {
    version:VERSION,
    refresh,
    setAppearance:next=>{if(["solid","dots","dashes"].includes(next.trackStyle))appearance.trackStyle=next.trackStyle;if(["soft","medium","bright"].includes(next.grayTone))appearance.grayTone=next.grayTone;if(["flip","lowest","countdown","dual","none"].includes(next.centerMode))appearance.centerMode=next.centerMode;refresh();return {...appearance};},
    inspect:() => ({version:VERSION,status,navigation:navigationFallback?.inspect() ?? null,localQuota:localQuotaFallback?.inspect() ?? null,data:current?.data ?? null,conflicts:current?.conflicts ?? null,resets:current?.resets ?? null,appearance:{...appearance},center:current?.centerValue ?? null,flip:current?{activeWindow:current.center.activeWindow,animating:current.center.animating,paused:[...current.center.paused],intervalMs:FLIP_INTERVAL_MS,reducedMotion:reducedMotion.matches}:null,rect:current?{x:current.button.getBoundingClientRect().x,y:current.button.getBoundingClientRect().y,width:current.button.getBoundingClientRect().width,height:current.button.getBoundingClientRect().height}:null}),
    uninstall:() => {stopped=true;observer.disconnect();clearInterval(timer);document.removeEventListener("visibilitychange",onFlipVisibility);reducedMotion.removeEventListener("change",onFlipMotionPreference);restore();localQuotaFallback?.uninstall();delete root.__chatgptQuotaDualArc;
      if(navigationSession){const owner=navigationSession;owner.notify=null;clearTimeout(owner.releaseTimer);owner.releaseTimer=setTimeout(()=>{if(root.__chatgptQuotaNavigationSession===owner&&!root.__chatgptQuotaDualArc){owner.fallback.uninstall();delete root.__chatgptQuotaNavigationSession;}},1500);}
    },
  };
  navigationSession=root.__chatgptQuotaNavigationSession;
  if(navigationSession){clearTimeout(navigationSession.releaseTimer);navigationSession.notify=schedule;}
  else {const owner={notify:schedule,releaseTimer:0,fallback:null};owner.fallback=createNavigationFallback(()=>owner.notify?.());root.__chatgptQuotaNavigationSession=owner;navigationSession=owner;}
  navigationFallback=navigationSession.fallback;
  localQuotaFallback=createLocalQuotaFallback(schedule);
  delete root.__quotaVerifiedLocalRate;
  root.__chatgptQuotaDualArc=api;
  refresh();
})(globalThis);
