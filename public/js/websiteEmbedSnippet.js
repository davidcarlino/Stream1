/**
 * Self-contained church-website embed.
 * Talks to YouTube directly (no STREAM1 / localhost) using the connected
 * channel id + a browser API key. Same layout as /embed.
 */

const VISIBLE = 5;

function escAttr(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/'/g, '&#39;');
}

function escJs(str) {
  return String(str == null ? '' : str)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/</g, '\\u003c');
}

const EMBED_CSS = `
.s1-embed{--s1-gap:clamp(12px,2.2vw,22px);--s1-radius:10px;--s1-panel:#121a2b;--s1-border:rgba(148,163,184,.22);--s1-muted:#94a3b8;--s1-live:#ef4444;--s1-accent:#38bdf8;display:grid;grid-template-columns:minmax(0,1.7fr) minmax(240px,.9fr);gap:var(--s1-gap);align-items:start;width:100%;max-width:1100px;margin:0 auto;padding:var(--s1-gap);box-sizing:border-box;font-family:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#e8eef7}
.s1-embed *,.s1-embed *::before,.s1-embed *::after{box-sizing:border-box}
.s1-player-col,.s1-list-col{min-width:0}
.s1-player{position:relative;width:100%;aspect-ratio:16/9;background:#000;border-radius:var(--s1-radius);overflow:hidden;border:1px solid var(--s1-border)}
.s1-player iframe{position:absolute;inset:0;width:100%;height:100%;border:0;background:#000}
.s1-player-empty{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;background:#000;color:var(--s1-muted);font-size:.95rem;letter-spacing:.02em;text-align:center;padding:1rem}
.s1-refresh-live{appearance:none;border:1px solid rgba(148,163,184,.35);background:rgba(255,255,255,.06);color:#e8eef7;font:inherit;font-size:.82rem;font-weight:600;letter-spacing:.03em;padding:8px 16px;border-radius:8px;cursor:pointer}
.s1-refresh-live:hover,.s1-refresh-live:focus-visible{background:rgba(56,189,248,.16);border-color:rgba(56,189,248,.45);outline:none}
.s1-refresh-live:disabled{opacity:.55;cursor:wait}
.s1-player-empty[hidden],.s1-player iframe[hidden],.s1-live-badge[hidden],.s1-more[hidden]{display:none!important}
.s1-live-badge{position:absolute;top:10px;left:10px;z-index:2;background:var(--s1-live);color:#fff;font-size:.7rem;font-weight:700;letter-spacing:.08em;padding:4px 8px;border-radius:4px;pointer-events:none}
.s1-list-col{display:flex;flex-direction:column;background:var(--s1-panel);border:1px solid var(--s1-border);border-radius:var(--s1-radius);overflow:hidden}
.s1-list-head{flex:0 0 auto;padding:12px 14px 8px;font-size:.8rem;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--s1-muted)}
.s1-list-wrap{flex:1 1 auto;min-height:0;overflow:hidden}
.s1-list{display:flex;flex-direction:column;gap:2px;padding:0 8px 8px}
.s1-item{display:grid;grid-template-columns:96px minmax(0,1fr);gap:10px;align-items:center;width:100%;padding:8px;border:0;border-radius:8px;background:transparent;color:inherit;text-align:left;cursor:pointer;font:inherit}
.s1-item:hover,.s1-item:focus-visible{background:rgba(56,189,248,.12);outline:none}
.s1-item.is-active{background:rgba(56,189,248,.18);box-shadow:inset 0 0 0 1px rgba(56,189,248,.35)}
.s1-item.is-overflow{display:none}
.s1-list-col.is-expanded .s1-item.is-overflow{display:grid}
.s1-thumb{position:relative;width:96px;aspect-ratio:16/9;border-radius:6px;overflow:hidden;background:#000;flex-shrink:0}
.s1-thumb img{width:100%;height:100%;object-fit:cover;display:block}
.s1-item-meta{min-width:0}
.s1-item-title{margin:0;font-size:.86rem;font-weight:600;line-height:1.3;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.s1-item-date{margin:4px 0 0;font-size:.72rem;color:var(--s1-muted)}
.s1-more{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;gap:4px;width:100%;padding:10px 12px 12px;border:0;border-top:1px solid var(--s1-border);background:transparent;color:var(--s1-accent);font:inherit;font-size:.85rem;font-weight:600;cursor:pointer}
.s1-more:hover,.s1-more:focus-visible{background:rgba(56,189,248,.08);outline:none}
.s1-list-col.is-expanded .s1-list-wrap{overflow-y:auto;max-height:min(52vh,420px);-webkit-overflow-scrolling:touch}
.s1-list-col.is-expanded .s1-more svg{transform:rotate(180deg)}
.s1-embed[data-state=error] .s1-player-empty span{color:#fca5a5}
@media (max-width:750px){.s1-embed{grid-template-columns:1fr;justify-items:center;padding:12px;gap:14px}.s1-player-col,.s1-list-col{width:100%;max-width:640px}.s1-list-col.is-expanded .s1-list-wrap{max-height:min(48vh,360px)}}
`.trim();

function buildEmbedScript(channelId, apiKey) {
  return `
(function(){
  var CHANNEL_ID='${escJs(channelId)}';
  var API_KEY='${escJs(apiKey)}';
  var VISIBLE=${VISIBLE};
  var YT='https://www.googleapis.com/youtube/v3';
  var root=document.getElementById('s1Embed');
  if(!root) return;
  var playerEmpty=document.getElementById('s1PlayerEmpty');
  var emptyMsg=document.getElementById('s1EmptyMsg');
  var refreshLiveBtn=document.getElementById('s1RefreshLive');
  var frame=document.getElementById('s1Frame');
  var liveBadge=document.getElementById('s1LiveBadge');
  var list=document.getElementById('s1List');
  var moreBtn=document.getElementById('s1More');
  var listCol=root.querySelector('.s1-list-col');
  var liveId=null;
  var expanded=false;
  var refreshingLive=false;

  function esc(str){
    return String(str==null?'':str)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  function formatDate(iso){
    if(!iso) return '';
    var d=new Date(iso);
    if(isNaN(d.getTime())) return '';
    return d.toLocaleDateString(undefined,{day:'numeric',month:'short',year:'numeric'});
  }
  function livePlaylistId(channelId){
    if(!channelId||channelId.indexOf('UC')!==0) return '';
    return 'UULV'+channelId.slice(2);
  }
  function thumbUrl(id){ return 'https://i.ytimg.com/vi/'+encodeURIComponent(id)+'/mqdefault.jpg'; }
  function embedUrl(videoId, autoplay){
    var p=new URLSearchParams();
    p.set('rel','0'); p.set('modestbranding','1'); p.set('playsinline','1');
    if(autoplay) p.set('autoplay','1');
    try{ if(location.origin) p.set('origin',location.origin); }catch(e){}
    return 'https://www.youtube-nocookie.com/embed/'+encodeURIComponent(videoId)+'?'+p.toString();
  }
  function ytGet(path, params){
    var q=new URLSearchParams(params||{});
    q.set('key', API_KEY);
    return fetch(YT+path+'?'+q.toString(),{credentials:'omit',cache:'no-store'})
      .then(function(res){
        return res.json().then(function(data){
          if(!res.ok){
            var msg=(data&&data.error&&data.error.message)||('YouTube error '+res.status);
            throw new Error(msg);
          }
          return data;
        });
      });
  }
  function setEmptyMessage(message){
    if(emptyMsg) emptyMsg.textContent=message||'Nothing live right now';
  }
  function showBlack(message){
    frame.hidden=true;
    frame.removeAttribute('src');
    playerEmpty.hidden=false;
    setEmptyMessage(message||'Nothing live right now');
    if(refreshLiveBtn){
      refreshLiveBtn.hidden=false;
      refreshLiveBtn.disabled=false;
      refreshLiveBtn.textContent='Refresh';
    }
    liveBadge.hidden=true;
    list.querySelectorAll('.s1-item').forEach(function(el){ el.classList.remove('is-active'); });
  }
  function playVideo(videoId, opts){
    opts=opts||{};
    if(!videoId){ showBlack(); return; }
    playerEmpty.hidden=true;
    if(refreshLiveBtn) refreshLiveBtn.hidden=true;
    frame.hidden=false;
    frame.src=embedUrl(videoId, !!opts.autoplay);
    liveBadge.hidden=!opts.isLive;
    list.querySelectorAll('.s1-item').forEach(function(el){
      el.classList.toggle('is-active', el.getAttribute('data-id')===videoId);
    });
  }
  function applyOverflow(){
    var items=[].slice.call(list.querySelectorAll('.s1-item'));
    items.forEach(function(el,i){ el.classList.toggle('is-overflow', i>=VISIBLE); });
    var needsMore=items.length>VISIBLE;
    moreBtn.hidden=!needsMore;
    if(!needsMore){
      expanded=false;
      listCol.classList.remove('is-expanded');
      moreBtn.querySelector('span').textContent='More';
    }
  }
  function renderList(videos){
    if(!videos.length){
      list.innerHTML='<p class="s1-item-date" style="padding:8px 10px;">No recent streams yet.</p>';
      moreBtn.hidden=true;
      return;
    }
    list.innerHTML=videos.map(function(v,i){
      var thumb=v.thumbnail?'<img src="'+esc(v.thumbnail)+'" alt="" loading="lazy" />':'';
      var date=formatDate(v.publishedAt);
      return '<button type="button" class="s1-item'+(i>=VISIBLE?' is-overflow':'')+'" data-id="'+esc(v.id)+'" role="listitem">'
        +'<span class="s1-thumb">'+thumb+'</span>'
        +'<span class="s1-item-meta"><p class="s1-item-title">'+esc(v.title)+'</p>'
        +(date?'<p class="s1-item-date">'+esc(date)+'</p>':'')
        +'</span></button>';
    }).join('');
    list.querySelectorAll('.s1-item').forEach(function(btn){
      btn.addEventListener('click', function(){
        var id=btn.getAttribute('data-id');
        playVideo(id,{autoplay:true,isLive:id===liveId});
      });
    });
    applyOverflow();
  }
  function prependLiveToList(live){
    if(!live||!live.id) return;
    var existing=list.querySelector('.s1-item[data-id="'+live.id.replace(/"/g,'')+'"]');
    if(existing){ existing.classList.add('is-active'); return; }
    var thumb=live.thumbnail?'<img src="'+esc(live.thumbnail)+'" alt="" loading="lazy" />':'';
    var btn=document.createElement('button');
    btn.type='button';
    btn.className='s1-item is-active';
    btn.setAttribute('data-id', live.id);
    btn.setAttribute('role','listitem');
    btn.innerHTML='<span class="s1-thumb">'+thumb+'</span><span class="s1-item-meta"><p class="s1-item-title">'+esc(live.title||'Live now')+'</p></span>';
    btn.addEventListener('click', function(){
      playVideo(live.id,{autoplay:true,isLive:live.id===liveId});
    });
    var note=list.querySelector(':scope > p');
    if(note) note.remove();
    list.insertBefore(btn, list.firstChild);
    applyOverflow();
  }

  function fetchLive(){
    return ytGet('/search',{
      part:'snippet',
      channelId:CHANNEL_ID,
      eventType:'live',
      type:'video',
      maxResults:'1'
    }).then(function(data){
      var hit=data.items&&data.items[0];
      var id=hit&&hit.id&&hit.id.videoId;
      if(!id) return null;
      var sn=hit.snippet||{};
      return {
        id:id,
        title:sn.title||'Live now',
        thumbnail:(sn.thumbnails&&((sn.thumbnails.medium&&sn.thumbnails.medium.url)||(sn.thumbnails.default&&sn.thumbnails.default.url)))||thumbUrl(id)
      };
    }).catch(function(){ return null; });
  }

  function fetchLatestLives(){
    var pl=livePlaylistId(CHANNEL_ID);
    if(!pl) return Promise.resolve([]);
    return ytGet('/playlistItems',{
      part:'snippet,status',
      playlistId:pl,
      maxResults:'12'
    }).then(function(data){
      var out=[];
      (data.items||[]).forEach(function(item){
        var sn=item.snippet||{};
        var id=sn.resourceId&&sn.resourceId.videoId;
        if(!id) return;
        if(sn.title==='Private video'||sn.title==='Deleted video') return;
        var privacy=item.status&&item.status.privacyStatus;
        if(privacy&&privacy!=='public'&&privacy!=='unlisted') return;
        out.push({
          id:id,
          title:sn.title||'Untitled',
          publishedAt:sn.publishedAt||null,
          thumbnail:(sn.thumbnails&&((sn.thumbnails.medium&&sn.thumbnails.medium.url)||(sn.thumbnails.default&&sn.thumbnails.default.url)))||thumbUrl(id)
        });
      });
      // Newest → oldest
      out.sort(function(a,b){
        return new Date(b.publishedAt||0).getTime()-new Date(a.publishedAt||0).getTime();
      });
      return out;
    }).catch(function(){ return []; });
  }

  function loadAll(){
    root.setAttribute('data-state','loading');
    return Promise.all([fetchLive(), fetchLatestLives()]).then(function(parts){
      var live=parts[0];
      var videos=parts[1].slice();
      liveId=live&&live.id?live.id:null;
      if(live&&live.id){
        var already=videos.some(function(v){ return v.id===live.id; });
        if(!already){
          videos.unshift({
            id:live.id,
            title:live.title||'Live now',
            publishedAt:null,
            thumbnail:live.thumbnail||null
          });
        }
      }
      renderList(videos);
      if(liveId) playVideo(liveId,{autoplay:false,isLive:true});
      else showBlack('Nothing live right now');
      root.setAttribute('data-state','ready');
    }).catch(function(err){
      root.setAttribute('data-state','error');
      showBlack((err&&err.message)||'Could not load streams.');
      list.innerHTML='';
      moreBtn.hidden=true;
    });
  }

  function refreshLiveOnly(){
    if(refreshingLive||!refreshLiveBtn||playerEmpty.hidden) return;
    refreshingLive=true;
    refreshLiveBtn.disabled=true;
    refreshLiveBtn.textContent='Checking…';
    setEmptyMessage('Looking for a live stream…');
    fetchLive().then(function(live){
      if(live&&live.id){
        liveId=live.id;
        prependLiveToList(live);
        playVideo(live.id,{autoplay:true,isLive:true});
        root.setAttribute('data-state','ready');
        return;
      }
      liveId=null;
      showBlack('Nothing live right now');
    }).catch(function(err){
      showBlack((err&&err.message)||'Could not check for live.');
    }).then(function(){
      refreshingLive=false;
      if(refreshLiveBtn&&!playerEmpty.hidden){
        refreshLiveBtn.disabled=false;
        refreshLiveBtn.textContent='Refresh';
      }
    });
  }

  if(moreBtn){
    moreBtn.addEventListener('click', function(){
      expanded=!expanded;
      listCol.classList.toggle('is-expanded', expanded);
      moreBtn.querySelector('span').textContent=expanded?'Less':'More';
      if(expanded) listCol.querySelector('.s1-list-wrap').scrollTop=0;
    });
  }
  if(refreshLiveBtn){
    refreshLiveBtn.addEventListener('click', function(e){
      e.preventDefault();
      e.stopPropagation();
      refreshLiveOnly();
    });
  }

  if(!CHANNEL_ID||!API_KEY){
    showBlack(!API_KEY?'Embed API key missing — add YOUTUBE_API_KEY in STREAM1 .env.':'YouTube channel not connected.');
    return;
  }
  loadAll();
  setInterval(loadAll, 90*1000);
})();
`.trim();
}

/** Full HTML document for Settings preview (srcdoc). */
export function websiteEmbedDocument({ channelId, apiKey }) {
  const script = buildEmbedScript(channelId, apiKey);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Live streams</title>
<style>${EMBED_CSS}</style>
</head>
<body style="margin:0;padding:0;background:transparent;">
<div class="s1-embed" id="s1Embed" data-state="loading">
  <div class="s1-player-col">
    <div class="s1-player" id="s1Player">
      <div class="s1-player-empty" id="s1PlayerEmpty" aria-hidden="false">
        <span id="s1EmptyMsg">Nothing live right now</span>
        <button type="button" class="s1-refresh-live" id="s1RefreshLive">Refresh</button>
      </div>
      <iframe id="s1Frame" title="YouTube player" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen referrerpolicy="strict-origin-when-cross-origin" hidden></iframe>
      <div class="s1-live-badge" id="s1LiveBadge" hidden>LIVE</div>
    </div>
  </div>
  <div class="s1-list-col">
    <div class="s1-list-head">Latest streams</div>
    <div class="s1-list-wrap"><div class="s1-list" id="s1List" role="list"></div></div>
    <button type="button" class="s1-more" id="s1More" hidden aria-label="Show more streams">
      <span>More</span>
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z"/></svg>
    </button>
  </div>
</div>
<script>${script}</script>
</body>
</html>`;
}

/**
 * Pasteable snippet for public church websites.
 * Self-contained: no STREAM1 server required on the public site.
 */
export function websiteEmbedSnippet({ channelId, apiKey }) {
  const script = buildEmbedScript(channelId, apiKey);
  return `<!-- STREAM1 church live embed — talks to YouTube directly -->
<div class="stream1-embed-root" style="width:100%;max-width:1100px;margin:0 auto;">
<style>${EMBED_CSS}</style>
<div class="s1-embed" id="s1Embed" data-state="loading">
  <div class="s1-player-col">
    <div class="s1-player" id="s1Player">
      <div class="s1-player-empty" id="s1PlayerEmpty" aria-hidden="false">
        <span id="s1EmptyMsg">Nothing live right now</span>
        <button type="button" class="s1-refresh-live" id="s1RefreshLive">Refresh</button>
      </div>
      <iframe id="s1Frame" title="YouTube player" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen referrerpolicy="strict-origin-when-cross-origin" hidden></iframe>
      <div class="s1-live-badge" id="s1LiveBadge" hidden>LIVE</div>
    </div>
  </div>
  <div class="s1-list-col">
    <div class="s1-list-head">Latest streams</div>
    <div class="s1-list-wrap"><div class="s1-list" id="s1List" role="list"></div></div>
    <button type="button" class="s1-more" id="s1More" hidden aria-label="Show more streams">
      <span>More</span>
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z"/></svg>
    </button>
  </div>
</div>
<script>${script}</script>
</div>`;
}

export function canBuildWebsiteEmbed({ channelId, apiKey }) {
  return Boolean(channelId && /^UC[\w-]{20,}$/.test(String(channelId).trim()) && apiKey);
}
