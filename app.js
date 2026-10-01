
(() => {
'use strict';

const GAME_ID='lucky-numbers';
const GAME_NAME='ラッキーナンバー';
const MAX_PLAYERS=8;
const APP_VERSION='v0.5.6';
const COMMON_PLAYER_NAME_KEY='boardgamePlayerName';
const ROOM_IDS=['room1','room2','room3','room4'];
const WORKER_ORIGIN=String(window.LUCKY_NUMBERS_CONFIG?.WORKER_ORIGIN||'').replace(/\/$/,'');
const NAME_DRAFT_KEY=`${GAME_ID}-name-draft`;
const ACTIVE_ROOM_KEY=`${GAME_ID}-online-room`;
const ACTIVE_NAME_KEY=`${GAME_ID}-online-active-name`;

let ws=null;
let reconnectTimer=null;
let currentRoomId=null;
let currentPlayerName='';
let currentToken='';
let state=null;
let rooms=[];
let commonNameSavedForSession=null;
let lastTurnPlayerId=null;
let announcedReachIds=new Set();
let previousBoardCounts=new Map();
let actionSeq=0;

const $=s=>document.querySelector(s);
const $$=s=>[...document.querySelectorAll(s)];

function updateMobileUiClass(){
  const coarse = window.matchMedia?.('(pointer: coarse)').matches;
  const portraitNarrow = window.innerWidth <= 900 && window.innerHeight >= window.innerWidth;
  const narrow = window.innerWidth <= 700;
  document.documentElement.classList.toggle('mobile-ui', !!(coarse || portraitNarrow || narrow));
}
updateMobileUiClass();
window.addEventListener('resize', updateMobileUiClass);
window.addEventListener('orientationchange', ()=>setTimeout(updateMobileUiClass,100));

function updateResponsiveSizing(){
  const root=document.documentElement;
  const mobile=root.classList.contains('mobile-ui');
  if(!mobile){
    root.style.removeProperty('--draft-tile-size');
    root.style.removeProperty('--draft-board-cell');
    root.style.removeProperty('--opponent-reach-line');
    return;
  }

  const vw=Math.max(320,window.innerWidth||320);
  const vh=Math.max(480,window.innerHeight||480);

  const draftCount=Math.max(1,state?.draftPool?.length||4);
  const cols = draftCount >= 24 ? 6 : draftCount >= 16 ? 5 : 4;

  const availableDraftWidth = Math.max(180, vw - 16);
  const byWidth = Math.floor((availableDraftWidth - (cols-1)*4) / cols);

  // Keep enough vertical room for info + pool + player's 4x4 board.
  const poolRows = Math.ceil(draftCount / cols);
  const availableTop = Math.max(250, vh*0.72 - 74);
  const byHeightForPool = Math.floor((availableTop*0.46 - (poolRows-1)*4) / poolRows);

  const draftTile = Math.max(28, Math.min(54, byWidth, byHeightForPool));

  const boardAvailable = Math.max(150, Math.min(vw - 24, availableTop*0.50));
  const draftCell = Math.max(34, Math.min(56, Math.floor((boardAvailable-22)/4)));

  root.style.setProperty('--draft-cols', String(cols));
  root.style.setProperty('--draft-tile-size', `${draftTile}px`);
  root.style.setProperty('--draft-board-cell', `${draftCell}px`);
  root.style.setProperty('--opponent-reach-line', '11px');
}
window.addEventListener('resize', updateResponsiveSizing);
window.addEventListener('orientationchange', ()=>setTimeout(updateResponsiveSizing,120));

function commonSavedName(){
  return String(localStorage.getItem(COMMON_PLAYER_NAME_KEY)||'').trim().slice(0,32);
}
function saveCommonNameOnActualStart(name){
  name=String(name||'').trim().slice(0,32);
  if(name) localStorage.setItem(COMMON_PLAYER_NAME_KEY,name);
}
function tokenKey(roomId){return `${GAME_ID}-online-token-${roomId}`;}
function getToken(roomId){
  let t=localStorage.getItem(tokenKey(roomId));
  if(!t){t=crypto.randomUUID().replace(/-/g,'');localStorage.setItem(tokenKey(roomId),t);}
  return t;
}
function newActionId(prefix='op'){
  actionSeq=(actionSeq+1)%1000000;
  return [prefix,Date.now(),actionSeq,currentToken.slice(0,8)].join('-');
}
function cleanName(v){return String(v||'').trim().slice(0,32);}
function roomNo(id){return Math.max(1,ROOM_IDS.indexOf(id)+1);}
function serverConfigured(){return WORKER_ORIGIN && !WORKER_ORIGIN.includes('YOUR_SUBDOMAIN');}
function apiUrl(path){
  if(!serverConfigured()) throw new Error('Cloudflare Workers のURLが未設定です。');
  return WORKER_ORIGIN+path;
}
function wsUrl(roomId){
  const u=new URL(apiUrl('/ws'));
  u.protocol=u.protocol==='https:'?'wss:':'ws:';
  u.searchParams.set('roomId',roomId);
  u.searchParams.set('name',currentPlayerName);
  u.searchParams.set('token',currentToken);
  return u.toString();
}
function showToast(msg){
  const el=$('#toast'); el.textContent=msg; el.classList.remove('hidden');
  clearTimeout(showToast.t); showToast.t=setTimeout(()=>el.classList.add('hidden'),2600);
}
function showScreen(id){
  $$('.screen').forEach(x=>x.classList.toggle('active',x.id===id));
}
function statusLabel(s){return s==='playing'?'ゲーム中':s==='finished'?'終了':'待機中';}

async function fetchJson(url,opt){
  const r=await fetch(url,{cache:'no-store',...(opt||{})});
  const d=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(d.error||`通信エラー (${r.status})`);
  return d;
}

async function loadRooms(){
  if(!serverConfigured()){renderRooms([]);return;}
  try{
    const d=await fetchJson(apiUrl('/rooms'));
    rooms=Array.isArray(d.rooms)?d.rooms:[];
    renderRooms(rooms);
  }catch(e){showToast(e.message);}
}
function renderRooms(list){
  const root=$('#roomGrid'); root.innerHTML='';
  ROOM_IDS.forEach((id,i)=>{
    const r=list.find(x=>x.roomId===id)||{roomId:id,status:'lobby',players:[],count:0,maxPlayers:4};
    const names=(r.players||[]).map(p=>p.name).filter(Boolean);
    const card=document.createElement('article');card.className='room-card';
    card.innerHTML=`
      <div class="room-card-head"><h2>ROOM ${i+1}</h2><span class="room-status">${statusLabel(r.status)}</span></div>
      <div>${r.count||0} / ${r.maxPlayers||4}人</div>
      <div class="room-players">参加者：${names.length?escapeHtml(names.join(' / ')):'なし'}</div>
      <button class="join">${r.status==='playing'?'参加 / 再接続':'参加する'}</button>
      <button class="reset">初期化</button>`;
    card.querySelector('.join').onclick=()=>joinRoom(id);
    card.querySelector('.reset').onclick=()=>resetRoom(id);
    root.appendChild(card);
  });
}
function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}

async function resetRoom(roomId){
  if(!confirm(`ROOM ${roomNo(roomId)} を初期化しますか？`)) return;
  try{
    await fetchJson(apiUrl(`/reset-empty?roomId=${encodeURIComponent(roomId)}`),{method:'POST'});
    await loadRooms();
  }catch(e){showToast(e.message);}
}

async function joinRoom(roomId){
  const name=cleanName($('#nameInput').value);
  if(!name){showToast('プレイヤー名を入力してください。');return;}
  const token=getToken(roomId);
  try{
    const u=new URL(apiUrl('/join-check'));
    u.searchParams.set('roomId',roomId);u.searchParams.set('name',name);u.searchParams.set('token',token);
    await fetchJson(u.toString());
    currentRoomId=roomId;currentPlayerName=name;currentToken=token;
    localStorage.setItem(ACTIVE_ROOM_KEY,roomId);
    localStorage.setItem(ACTIVE_NAME_KEY,name);
    connectWs();
  }catch(e){showToast(e.message);}
}

function connectWs(){
  if(!currentRoomId) return;
  if(ws && (ws.readyState===0||ws.readyState===1)) return;
  try{ws=new WebSocket(wsUrl(currentRoomId));}
  catch(e){showToast(e.message);return;}
  ws.onopen=()=>{clearTimeout(reconnectTimer);};
  ws.onmessage=ev=>{
    let msg;try{msg=JSON.parse(ev.data)}catch{return}
    if(msg.type==='state'){applyState(msg.state);}
    else if(msg.type==='error') showToast(msg.error||'エラー');
  };
  ws.onclose=()=>{ if(currentRoomId) scheduleReconnect(); };
}
function scheduleReconnect(){
  clearTimeout(reconnectTimer);
  reconnectTimer=setTimeout(()=>connectWs(),1200);
}
function send(type,payload={}){
  if(!ws||ws.readyState!==1){showToast('再接続中です。');return;}
  ws.send(JSON.stringify({type,actionId:newActionId(type),...payload}));
}

function me(){return state?.players?.find(p=>p.token===currentToken)||null;}
function isHost(){return !!me()?.host;}
function isMyTurn(){return state?.status==='playing' && state?.currentPlayerId===me()?.id;}
function selected(){return state?.selected||null;}

function applyState(s){
  state=s;
  const player=me();
  if(!player){return;}

  if(s.status==='playing' && s.gameSessionId && commonNameSavedForSession!==s.gameSessionId){
    saveCommonNameOnActualStart(currentPlayerName);
    commonNameSavedForSession=s.gameSessionId;
  }

  if(s.status==='lobby'){showScreen('lobbyScreen');renderLobby();}
  else if(s.status==='draft'){showScreen('draftScreen');renderDraft();}
  else if(s.status==='playing'){showScreen('gameScreen');renderGame();}
  else if(s.status==='finished'){showScreen('resultScreen');renderResult();}
  requestAnimationFrame(updateResponsiveSizing);

  if(s.status==='playing'){
    for(const rp of s.players){
      const nowCount=countBoard(rp.board);
      const prevCount=previousBoardCounts.has(rp.id)?previousBoardCounts.get(rp.id):null;
      if(nowCount===15 && prevCount!==15 && !announcedReachIds.has(rp.id)){
        announcedReachIds.add(rp.id);
        showReachOverlay(`${rp.name} リーチ！`);
      }
      previousBoardCounts.set(rp.id,nowCount);
    }
  } else if(s.status==='lobby'){
    announcedReachIds=new Set();
    previousBoardCounts=new Map();
  }

  if(s.status==='playing' && lastTurnPlayerId!==s.currentPlayerId){
    lastTurnPlayerId=s.currentPlayerId;
    const p=s.players.find(x=>x.id===s.currentPlayerId);
    if(p) showTurnOverlay(p.id===player.id?'あなたの手番':`${p.name} の手番`);
  }
}
function showTurnOverlay(text){
  const el=$('#turnOverlay');
  el.classList.remove('reach-pop');
  el.textContent=text;
  el.classList.remove('hidden');
  clearTimeout(showTurnOverlay.t);
  showTurnOverlay.t=setTimeout(()=>el.classList.add('hidden'),1800);
}
function showReachOverlay(text){
  const el=$('#reachOverlay');
  el.textContent=text;
  el.classList.remove('hidden');
  clearTimeout(showReachOverlay.t);
  showReachOverlay.t=setTimeout(()=>el.classList.add('hidden'),2400);
}

function renderLobby(){
  $('#lobbyRoomTitle').textContent=`ROOM ${roomNo(currentRoomId)}`;
  $('#lobbyStatus').textContent=statusLabel(state.status);
  const list=$('#seatList');list.innerHTML='';
  state.players.forEach((p,i)=>{
    const el=document.createElement('div');el.className='seat';
    el.innerHTML=`<span class="${p.token===currentToken?'me':''}">${i+1}. ${escapeHtml(p.name)}${p.cpu?' [CPU]':''}</span><span>${p.host?'HOST':''}</span>`;
    list.appendChild(el);
  });
  $('#hostControls').classList.toggle('hidden',!isHost());
  $('#addCpuBtn').disabled=state.players.length>=MAX_PLAYERS;
  $('#removeCpuBtn').disabled=!state.players.some(p=>p.cpu);
  $('#startBtn').disabled=state.players.length<2||state.players.length>8;
  const mode=state.initialMode||'random';
  const radio=document.querySelector(`input[name="initialMode"][value="${mode}"]`);
  if(radio) radio.checked=true;
}



function renderDraft(){
  updateResponsiveSizing();
  const player=me();
  const current=state.players.find(x=>x.id===state.draftCurrentPlayerId);
  const round=Number(state.draftRound||0)+1;
  $('#draftTurnText').textContent=current?`${current.name} の選択`:'ドラフト';
  $('#draftInfo').textContent=`初期配置ドラフト ${round}/4枚目　${current?current.name+' が選択中':''}`;
  $('#draftMyName').textContent=player.name;

  const side=$('#draftPlayers');side.innerHTML='';
  for(const p of state.players){
    const el=document.createElement('div');
    el.className='mini-player'+(p.id===state.draftCurrentPlayerId?' active':'');
    el.innerHTML=`<div class="mini-head"><strong>${escapeHtml(p.name)}${p.cpu?' [CPU]':''}</strong><span>${p.draftPicks||0}/4</span></div>`;
    side.appendChild(el);
  }

  const pool=$('#draftPool');pool.innerHTML='';
  const sortedDraft=(state.draftPool||[])
    .map((value,index)=>({value,index}))
    .sort((a,b)=>a.value-b.value || a.index-b.index);
  sortedDraft.forEach(item=>{
    const b=document.createElement('button');
    b.className='number-tile draft-number-tile';
    b.textContent=item.value;
    b.disabled=state.draftCurrentPlayerId!==player.id || !!state.draftSelected;
    b.onclick=()=>send('draft-pick',{index:item.index});
    pool.appendChild(b);
  });

  renderDraftBoard($('#draftBoard'),player);
}

function renderDraftBoard(root,player){
  root.innerHTML='';
  const canPlace=state.draftCurrentPlayerId===player.id && state.draftSelected?.playerId===player.id;
  for(let r=0;r<4;r++)for(let c=0;c<4;c++){
    const cell=document.createElement('button');
    cell.className='cell'+(r===c?' diag':'');
    const n=player.board[r][c];
    if(n!=null) cell.innerHTML=`<span class="number-tile">${n}</span>`;
    const valid=canPlace && n==null && isValidPlacement(player.board,r,c,state.draftSelected.value);
    if(valid) cell.classList.add('valid');
    cell.disabled=!valid;
    if(valid) cell.onclick=()=>send('draft-place',{row:r,col:c});
    root.appendChild(cell);
  }
}

function renderGame(){
  const player=me();
  const cur=state.players.find(x=>x.id===state.currentPlayerId);
  $('#turnText').textContent=cur ? `${cur.name} の手番` : '手番';
  $('#drawCount').textContent=state.drawCount;
  $('#drawPileBtn').disabled=!isMyTurn()||!!selected()||state.drawCount<=0;

  const disc=$('#discardList');disc.innerHTML='';
  (state.discard||[]).forEach((n,idx)=>{
    const b=document.createElement('button');b.className='number-tile';
    b.textContent=n;
    b.disabled=!isMyTurn()||!!selected();
    if(!b.disabled)b.classList.add('usable');
    b.onclick=()=>send('take-discard',{index:idx});
    disc.appendChild(b);
  });
  if(!state.discard?.length) disc.innerHTML='<span style="color:#8eaa99;font-size:12px">なし</span>';

  const sel=selected();
  $('#selectedTileBox').classList.toggle('hidden',!sel||sel.playerId!==player.id);
  if(sel&&sel.playerId===player.id){
    $('#selectedTile').textContent=sel.value;
    $('#discardSelectedBtn').classList.toggle('hidden',sel.source!=='draw');
  }

  const myWaits=reachWaits(player.board);
  $('#myName').textContent=player.name + (countBoard(player.board)===15 ? `　${myWaits.length?myWaits.join('・'):'—'}` : '');
  renderBoard($('#myBoard'),player,true);

  const opp=$('#opponents');opp.innerHTML='';
  const boardPlayers=[...state.players];
  opp.dataset.count=String(boardPlayers.length);
  boardPlayers.forEach(p=>{
    const wrap=document.createElement('div');
    wrap.className='mini-player'+(p.id===state.currentPlayerId?' active':'')+(p.id===player.id?' self-mini':'');
    const waits=reachWaits(p.board);
    const reachText=countBoard(p.board)===15 ? (waits.length?waits.join('・'):'—') : '&nbsp;';
    wrap.innerHTML=`<div class="mini-head"><strong>${escapeHtml(p.name)}${p.cpu?' [CPU]':''}${p.id===player.id?' [自分]':''}</strong><span class="reach-line">${reachText}</span></div><div class="mini-board"></div>`;
    const mb=wrap.querySelector('.mini-board');
    p.board.flat().forEach(n=>{const c=document.createElement('div');c.className='mini-cell';c.textContent=n??'';mb.appendChild(c)});
    opp.appendChild(wrap);
  });
  renderLog();
}

function renderBoard(root,player,interactive){
  root.innerHTML='';
  const sel=selected();
  for(let r=0;r<4;r++) for(let c=0;c<4;c++){
    const cell=document.createElement('button');
    cell.className='cell'+(r===c?' diag':'');
    const n=player.board[r][c];
    if(n!=null){cell.innerHTML=`<span class="number-tile">${n}</span>`;}
    const valid=interactive && isMyTurn() && sel?.playerId===player.id && isValidPlacement(player.board,r,c,sel.value);
    if(valid) cell.classList.add('valid');
    cell.disabled=!valid;
    if(valid) cell.onclick=()=>send('place',{row:r,col:c});
    root.appendChild(cell);
  }
}
function isValidPlacement(board,r,c,v){
  for(let x=0;x<4;x++){
    if(x===c)continue; const n=board[r][x];
    if(n==null)continue;
    if(x<c && !(n<v)) return false;
    if(x>c && !(v<n)) return false;
  }
  for(let y=0;y<4;y++){
    if(y===r)continue; const n=board[y][c];
    if(n==null)continue;
    if(y<r && !(n<v)) return false;
    if(y>r && !(v<n)) return false;
  }
  return true;
}
function countBoard(b){return b?.flat().filter(x=>x!=null).length||0;}
function reachWaits(board){
  if(countBoard(board)!==15) return [];
  let er=-1,ec=-1;
  for(let r=0;r<4;r++)for(let c=0;c<4;c++){
    if(board[r][c]==null){er=r;ec=c;}
  }
  if(er<0)return [];
  const waits=[];
  for(let v=1;v<=20;v++){
    if(isValidPlacement(board,er,ec,v)) waits.push(v);
  }
  return waits;
}

function renderLog(){
  $('#logBody').textContent=(state?.log||[]).slice().reverse().join('\n')||'ログはありません。';
}
function renderResult(){
  const winners=state.winnerIds||[];
  const names=state.players.filter(p=>winners.includes(p.id)).map(p=>p.name);
  $('#resultTitle').textContent=names.length?`${names.join(' / ')} 勝利`:'ゲーム終了';
  const list=$('#resultList');list.innerHTML='';
  const sorted=[...state.players].sort((a,b)=>countBoard(b.board)-countBoard(a.board));
  sorted.forEach(p=>{
    const row=document.createElement('div');row.className='result-row'+(winners.includes(p.id)?' winner':'');
    row.innerHTML=`<strong>${escapeHtml(p.name)}${p.cpu?' [CPU]':''}</strong><span>${countBoard(p.board)} / 16</span>`;
    list.appendChild(row);
  });
}

function renderFinalBoards(){
  const root=$('#boardsDialogBody');
  root.innerHTML='';
  root.classList.add('no-scroll');
  const winners=state?.winnerIds||[];
  for(const p of state?.players||[]){
    const card=document.createElement('div');
    card.className='result-board-card';
    const waits=reachWaits(p.board);
    const right=countBoard(p.board)===15 && waits.length ? waits.join('・') : '';
    card.innerHTML=`<h3><span>${escapeHtml(p.name)}${p.cpu?' [CPU]':''}${winners.includes(p.id)?' 👑':''}</span><span class="reach-wait">${right}</span></h3><div class="result-board-grid"></div>`;
    const grid=card.querySelector('.result-board-grid');
    p.board.flat().forEach(n=>{
      const c=document.createElement('div');
      c.className='result-board-cell';
      c.textContent=n??'';
      grid.appendChild(c);
    });
    root.appendChild(card);
  }
}

function leaveRoom(){
  if(ws&&ws.readyState===1) ws.send(JSON.stringify({type:'leave',actionId:newActionId('leave')}));
  currentRoomId=null;state=null;lastTurnPlayerId=null;announcedReachIds=new Set();previousBoardCounts=new Map();
  localStorage.removeItem(ACTIVE_ROOM_KEY);localStorage.removeItem(ACTIVE_NAME_KEY);
  const oldWs=ws;
  ws=null;
  setTimeout(()=>{try{oldWs?.close()}catch{}},150);
  showScreen('titleScreen');loadRooms();
}

$('#nameInput').value=sessionStorage.getItem(NAME_DRAFT_KEY)??commonSavedName()??'';
$('#nameInput').addEventListener('input',e=>sessionStorage.setItem(NAME_DRAFT_KEY,e.target.value));
$('#refreshRoomsBtn').onclick=loadRooms;
$('#rulesBtn').onclick=()=>$('#rulesDialog').showModal();
$$('[data-close-dialog]').forEach(b=>b.onclick=()=>$('#'+b.dataset.closeDialog).close());
$('#leaveLobbyBtn').onclick=leaveRoom;
$('#leaveGameBtn').onclick=leaveRoom;
$('#leaveResultBtn').onclick=leaveRoom;
document.querySelectorAll('input[name="initialMode"]').forEach(r=>{
  r.addEventListener('change',()=>{ if(r.checked) send('set-initial-mode',{mode:r.value}); });
});
$('#leaveDraftBtn').onclick=leaveRoom;
$('#addCpuBtn').onclick=()=>send('add-cpu');
$('#removeCpuBtn').onclick=()=>send('remove-cpu');
$('#startBtn').onclick=()=>send('start');
$('#drawPileBtn').onclick=()=>send('draw');
$('#discardSelectedBtn').onclick=()=>send('discard-selected');
$('#logBtn').onclick=()=>{renderLog();$('#logDialog').showModal();};
$('#viewBoardsBtn').onclick=()=>{renderFinalBoards();$('#boardsDialog').showModal();};
$('#backLobbyBtn').onclick=()=>send('back-lobby');

$('#serverWarning').classList.toggle('hidden',serverConfigured());
loadRooms();

// 再読込時は現在ROOMへの再接続を試みる。
// ROOM一覧の定期ポーリングは行わない。
const savedRoom=localStorage.getItem(ACTIVE_ROOM_KEY);
const savedName=cleanName(localStorage.getItem(ACTIVE_NAME_KEY));
if(savedRoom&&savedName&&ROOM_IDS.includes(savedRoom)&&serverConfigured()){
  currentRoomId=savedRoom;currentPlayerName=savedName;currentToken=getToken(savedRoom);connectWs();
}
document.addEventListener('visibilitychange',()=>{
  if(document.visibilityState==='visible'&&currentRoomId&&(!ws||ws.readyState!==1))scheduleReconnect();
});
window.addEventListener('online',()=>{if(currentRoomId&&(!ws||ws.readyState!==1))scheduleReconnect();});

})();
