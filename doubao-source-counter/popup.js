const $=s=>document.querySelector(s),message=p=>chrome.runtime.sendMessage(p);
const SITE_NAMES={"douyin.com":"抖音","sohu.com":"搜狐","volcengine.com":"火山引擎","100ec.cn":"网经社","china.com":"中华网","weixin.qq.com":"微信公众平台","qq.com":"腾讯网","baidu.com":"百度","zhihu.com":"知乎","toutiao.com":"今日头条","163.com":"网易","sina.com.cn":"新浪","thepaper.cn":"澎湃新闻","ithome.com":"IT之家","36kr.com":"36氪","cnblogs.com":"博客园","csdn.net":"CSDN","bilibili.com":"哔哩哔哩","xiaohongshu.com":"小红书","taogaofen.com":"淘高分"};
const siteLabel=s=>SITE_NAMES[s]?`${SITE_NAMES[s]} · ${s}`:s;
function esc(s){let d=document.createElement("div");d.textContent=s??"";return d.innerHTML}
function flash(b,t="完成"){let old=b.textContent;b.textContent=t;setTimeout(()=>b.textContent=old,1000)}
async function render(){
  let{data}=await message({type:"GET_STATS"}),ss=data.sessions||[],active=ss.find(s=>s.id===data.activeSessionId),last=active||ss.at(-1),counts=last?.counts||{},rows=Object.entries(counts).sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])),records=last?data.records.filter(r=>r.sessionId===last.id):[],total=rows.reduce((n,[,v])=>n+v,0);
  $("#summary").textContent=active?"正在扫描当前聊天窗口":last?`扫描完成于 ${new Date(last.endedAt||last.startedAt).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"})}`:"尚未扫描";
  $("#refCount").textContent=total;$("#siteCount").textContent=rows.length;$("#answerCount").textContent=records.length;
  $("#scan").disabled=!!active;$("#empty").hidden=!!last;$("#result").hidden=!last;
  $("tbody").innerHTML=rows.map(([s,n])=>`<tr><td title="${esc(s)}">${esc(siteLabel(s))}</td><td>${n}</td></tr>`).join("");
  let items=records.flatMap(r=>(r.items||r.urls?.map(u=>({title:u,url:u,site:(()=>{try{return new URL(u).hostname}catch{return""}})()}))||[])).slice(-5).reverse();
  $("#recent").innerHTML=items.length?items.map(x=>`<div class="recent-item" title="${esc(x.title)}"><div class="recent-title">${esc(x.title||x.url)}</div><div class="recent-meta">${esc(siteLabel(x.site||""))}</div></div>`).join(""):`<div class="empty-recent">暂无明细</div>`;
}
$("#scan").onclick=async e=>{
  let[t]=await chrome.tabs.query({active:true,currentWindow:true}),button=e.currentTarget,poll;
  button.disabled=true;
  button.textContent="正在准备扫描…";
  const updateProgress=async()=>{
    try{
      const status=await chrome.tabs.sendMessage(t.id,{type:"GET_SCAN_STATUS"});
      if(status?.ok){button.textContent=status.text;$("#summary").textContent=status.text}
    }catch{}
  };
  poll=setInterval(updateProgress,200);
  try{
    let response=await chrome.tabs.sendMessage(t.id,{type:"SCAN_ONCE"});
    if(!response?.ok)throw new Error(response?.error||"扫描失败");
    await updateProgress();
    await render();
    const count=response.result?.referenceCount||0;
    button.textContent=count?`扫描完成（${count} 条）`:"扫描完成（未找到资料）";
    $("#summary").textContent=button.textContent;
  }catch(error){
    button.textContent="扫描失败，请刷新豆包页";
    $("#summary").textContent=error?.message||"扫描失败";
  }finally{
    clearInterval(poll);
    setTimeout(()=>{button.textContent="重新扫描";button.disabled=false},1600);
  }
};
$("#csv").onclick=async e=>{await message({type:"EXPORT_CSV"});flash(e.target)};$("#json").onclick=async e=>{await message({type:"EXPORT_JSON"});flash(e.target)};
$("#clear").onclick=async e=>{if(confirm("确定清空全部统计记录吗？")){await message({type:"CLEAR_STATS"});await render();flash(e.target)}};render();
