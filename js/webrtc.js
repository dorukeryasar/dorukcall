import { supabase } from './supabase.js';
import { formatDuration, escapeHtml, avatarMarkup, humanError } from './utils.js';

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' }
];

export class WebRTCCallManager {
  constructor(state, ui) {
    this.state = state;
    this.ui = ui;
    this.call = null;
    this.channel = null;
    this.ringtoneTimer = null;
    this.signalsSub = null;
  }

  async startOutgoing({ conversationId, peerId = null, mode = 'audio', groupName = null }) {
    if (this.call) throw new Error('Zaten aktif bir arama var.');
    const { data: session, error } = await supabase.from('call_sessions').insert({
      conversation_id: conversationId, caller_id: this.state.user.id, callee_id: peerId,
      type: mode === 'video' ? 'video' : 'voice', status: 'ringing'
    }).select('*,caller:profiles!call_sessions_caller_id_fkey(id,name,avatar_url)').single();
    if (error) throw error;

    const { error: pErr } = await supabase.from('call_participants').insert({ call_id: session.id, user_id: this.state.user.id, state: 'joined' });
    if (pErr) throw pErr;

    if (peerId) {
      await supabase.from('notifications').insert({
        user_id: peerId, type: mode === 'video' ? 'video_call' : 'voice_call',
        title: `${this.state.name} seni arıyor`, body: mode === 'video' ? 'Gelen görüntülü arama' : 'Gelen sesli arama',
        call_id: session.id, data: { call_session_id: session.id }
      });
    } else {
      const { data: members } = await supabase.from('conversation_members').select('user_id').eq('conversation_id',conversationId).neq('user_id',this.state.user.id);
      for (const m of members || []) await supabase.from('notifications').insert({
        user_id:m.user_id,type:'group_call',title:`${groupName || 'Grup'} araması başladı`,body:`${this.state.name} ${mode === 'video' ? 'görüntülü' : 'sesli'} grup araması başlattı`,call_id:session.id,data:{call_session_id:session.id,conversation_id:conversationId}
      });
    }
    await this._enterCall(session, { mode, peerIds: peerId ? [peerId] : [], outgoing:true });
    return session;
  }

  async acceptIncoming(callId) {
    const { data: session, error }=await supabase.from('call_sessions').select('*,caller:profiles!call_sessions_caller_id_fkey(id,name,avatar_url),groups(name)').eq('id',callId).single();
    if(error)throw error;
    await supabase.from('call_participants').upsert({call_id:callId,user_id:this.state.user.id,state:'joined'});
    await supabase.from('call_sessions').update({status:'active',answered_at:new Date().toISOString()}).eq('id',callId);
    const { data: participants }=await supabase.from('call_participants').select('user_id').eq('call_id',callId).neq('user_id',this.state.user.id);
    await this._enterCall(session,{mode:session.type,peerIds:(participants||[]).map(x=>x.user_id),outgoing:false});
    this._dismissIncoming();
  }

  async rejectIncoming(callId) {
    await supabase.from('call_sessions').update({status:'rejected',ended_at:new Date().toISOString()}).eq('id',callId);
    this._dismissIncoming();
  }

  async _enterCall(session, {mode, peerIds, outgoing}) {
    const stream=await this._getMedia(mode);
    this.call={session,mode,stream,peerIds:new Set(peerIds),pcs:new Map(),outgoing,startedAt:null};
    this._renderOverlay();
    this._bindSignals();
    for(const peerId of [...this.call.peerIds]) await this._ensurePeer(peerId, outgoing);
    if(outgoing) await supabase.from('call_sessions').update({status:'connecting'}).eq('id',session.id);
  }

  async _getMedia(mode) {
    try {
      return await navigator.mediaDevices.getUserMedia({audio:true,video:mode==='video'});
    } catch (e) {
      throw new Error(e?.name==='NotAllowedError' ? 'Mikrofon/kamera izni verilmedi.' : 'Mikrofon veya kamera açılamadı.');
    }
  }

  _renderOverlay() {
    const s=this.call.stream;
    this.ui.callRoot.innerHTML=`<div class="call-overlay">
      <div class="call-head"><div><strong>${escapeHtml(this.call.session.caller?.name || this.state.name || 'Arama')}</strong><small id="callStatusText">Bağlanıyor…</small></div><div id="callTimer">00:00</div></div>
      <div class="call-stage"><div id="videoGrid" class="video-grid"></div></div>
      <div class="call-controls">
        <button id="muteCallBtn" title="Mikrofon">🎙</button>
        ${this.call.mode==='video' ? '<button id="cameraCallBtn" title="Kamera">▣</button>' : ''}
        <button id="endCallBtn" class="end" title="Bitir">⏹</button>
      </div>
    </div>`;
    if(this.call.mode==='video') this._addVideoTile(this.state.user.id,this.state.name||'Sen',s,true);
    document.getElementById('muteCallBtn').onclick=()=>{const t=s.getAudioTracks()[0];if(t){t.enabled=!t.enabled;document.getElementById('muteCallBtn').textContent=t.enabled?'🎙':'🔇';}};
    document.getElementById('cameraCallBtn')?.addEventListener('click',()=>{const t=s.getVideoTracks()[0];if(t){t.enabled=!t.enabled;document.getElementById('cameraCallBtn').textContent=t.enabled?'▣':'◻';}});
    document.getElementById('endCallBtn').onclick=()=>this.endCall('ended');
    this._startTimer();
  }

  _addVideoTile(userId,name,stream,isSelf=false){
    const grid=document.getElementById('videoGrid'); if(!grid)return;
    if(document.getElementById(`tile-${userId}`))return;
    const tile=document.createElement('div');tile.className='video-tile';tile.id=`tile-${userId}`;
    tile.innerHTML=`<video ${isSelf?'muted':''} autoplay playsinline></video><div class="video-label">${escapeHtml(name)}</div>`;
    grid.appendChild(tile); tile.querySelector('video').srcObject=stream;
  }

  _startTimer(){
    const tick=()=>{if(!this.call)return;const text=this.call.startedAt?formatDuration((Date.now()-this.call.startedAt)/1000):'00:00';const el=document.getElementById('callTimer');if(el)el.textContent=text;this._timer=requestAnimationFrame(tick);};
    this._timer=requestAnimationFrame(tick);
  }

  async _ensurePeer(peerId, initiator){
    if(!this.call||this.call.pcs.has(peerId))return;
    const pc=new RTCPeerConnection({iceServers:ICE_SERVERS});
    this.call.pcs.set(peerId,pc);
    for(const track of this.call.stream.getTracks())pc.addTrack(track,this.call.stream);
    pc.onicecandidate=e=>e.candidate&&this._sendSignal(peerId,'ice',{candidate:e.candidate});
    pc.ontrack=e=>{
      const stream=e.streams[0]; if(this.call.mode==='video') {
        const name=this.state.getProfileName?.(peerId)||'Katılımcı'; this._addVideoTile(peerId,name,stream,false);
      }
    };
    pc.onconnectionstatechange=()=>{if(pc.connectionState==='connected'){this.call.startedAt ||= Date.now();const el=document.getElementById('callStatusText');if(el)el.textContent='Bağlandı';}};
    if(initiator){
      const offer=await pc.createOffer();await pc.setLocalDescription(offer);await this._sendSignal(peerId,'offer',{sdp:pc.localDescription});
    }
  }

  async _handleSignal(sig){
    if(!this.call)return;
    if(sig.recipient_id!==this.state.user.id)return;
    const peerId=sig.sender_id; await this._ensurePeer(peerId,false);
    const pc=this.call.pcs.get(peerId);
    if(sig.type==='offer'){await pc.setRemoteDescription(sig.payload.sdp);const ans=await pc.createAnswer();await pc.setLocalDescription(ans);await this._sendSignal(peerId,'answer',{sdp:pc.localDescription});}
    else if(sig.type==='answer'){await pc.setRemoteDescription(sig.payload.sdp);}
    else if(sig.type==='ice' && sig.payload?.candidate){try{await pc.addIceCandidate(sig.payload.candidate)}catch{}}
  }

  async _sendSignal(recipientId,type,payload){
    await supabase.from('call_signals').insert({call_id:this.call.session.id,sender_id:this.state.user.id,recipient_id:recipientId,type,payload});
  }

  _bindSignals(){
    this.signalsSub=supabase.channel(`call:${this.call.session.id}`)
      .on('postgres_changes',{event:'INSERT',schema:'public',table:'call_signals',filter:`call_id=eq.${this.call.session.id}`},p=>this._handleSignal(p.new))
      .on('postgres_changes',{event:'INSERT',schema:'public',table:'call_participants',filter:`call_id=eq.${this.call.session.id}`},async p=>{
        if(!this.call || p.new.user_id===this.state.user.id || p.new.state!=='joined') return;
        this.call.peerIds.add(p.new.user_id);
        await this._ensurePeer(p.new.user_id, this.call.outgoing);
      })
      .on('postgres_changes',{event:'UPDATE',schema:'public',table:'call_participants',filter:`call_id=eq.${this.call.session.id}`},async p=>{
        if(!this.call || p.new.user_id===this.state.user.id) return;
        if(p.new.state==='left'){
          const pc=this.call.pcs.get(p.new.user_id); pc?.close(); this.call.pcs.delete(p.new.user_id);
          document.getElementById(`tile-${p.new.user_id}`)?.remove();
        }
      })
      .subscribe();
    this.callStatusSub=supabase.channel(`call-status:${this.call.session.id}`)
      .on('postgres_changes',{event:'UPDATE',schema:'public',table:'call_sessions',filter:`id=eq.${this.call.session.id}`},p=>{
        if(!this.call)return;
        if(p.new.status==='active'){this.call.startedAt ||= Date.now();}
        if(['ended','rejected','missed'].includes(p.new.status))this.endCall(p.new.status,true);
      }).subscribe();
  }

  async endCall(status='ended',remote=false){
    if(!this.call)return;
    const call=this.call; this.call=null;
    try{await supabase.from('call_sessions').update({status,ended_at:new Date().toISOString(),duration_seconds:call.startedAt?Math.max(0,Math.floor((Date.now()-call.startedAt)/1000)):0}).eq('id',call.session.id)}catch{}
    call.stream.getTracks().forEach(t=>t.stop());call.pcs.forEach(pc=>pc.close());
    if(this.signalsSub)supabase.removeChannel(this.signalsSub);
    if(this.callStatusSub)supabase.removeChannel(this.callStatusSub);
    if(this._timer)cancelAnimationFrame(this._timer);
    this.ui.callRoot.innerHTML='';
    if(!remote)this.ui.toast?.(`Arama ${status==='missed'?'cevapsız':status==='rejected'?'reddedildi':'sonlandırıldı'}.`);
  }

  showIncoming(call){
    this.ui.incomingRoot.innerHTML=`<div class="incoming-card"><div class="row">${avatarMarkup(call.caller?.avatar_url,call.caller?.name)}<span><strong>${escapeHtml(call.caller?.name||'Kullanıcı')}</strong><small class="muted">${call.type==='video'?'Gelen görüntülü arama':'Gelen sesli arama'}</small></span></div><div class="actions"><button class="accept">Kabul et</button><button class="reject">Reddet</button></div></div>`;
    this._startRingtone();
    this.ui.incomingRoot.querySelector('.accept').onclick=async()=>{this._stopRingtone();try{await this.acceptIncoming(call.id)}catch(e){this.ui.toast?.(humanError(e));}};
    this.ui.incomingRoot.querySelector('.reject').onclick=async()=>{this._stopRingtone();await this.rejectIncoming(call.id);};
  }

  _dismissIncoming(){this._stopRingtone();this.ui.incomingRoot.innerHTML='';}
  _startRingtone(){this._stopRingtone();this.ringtoneTimer=setInterval(()=>this.ui.beep?.('call'),1500);this.ui.beep?.('call');}
  _stopRingtone(){if(this.ringtoneTimer)clearInterval(this.ringtoneTimer);this.ringtoneTimer=null;}
}
