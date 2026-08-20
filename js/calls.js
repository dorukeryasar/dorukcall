import { supabase } from './supabase.js';
import { humanError } from './utils.js';

export function initCallLayer(state, ui, callManager) {
  let incomingSub = null;
  let callWatcher = null;

  async function watchIncoming() {
    incomingSub = supabase.channel(`incoming-calls:${state.user.id}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications', filter: `user_id=eq.${state.user.id}` }, async payload => {
        if (!['voice_call','video_call','group_call'].includes(payload.new.type)) return;
        const callId = payload.new.call_id || payload.new.data?.call_session_id;
        if (!callId) return;
        const { data: call } = await supabase.from('call_sessions')
          .select(`id,type,status,conversation_id,caller_id,callee_id,created_at,caller:profiles!call_sessions_caller_id_fkey(id,name,avatar_url)`)
          .eq('id', callId).maybeSingle();
        if (!call || !['ringing','active'].includes(call.status)) return;
        if (call.caller_id === state.user.id) return;
        callManager.showIncoming(call);
        if (callWatcher) supabase.removeChannel(callWatcher);
        callWatcher = supabase.channel(`incoming-call-status:${call.id}`)
          .on('postgres_changes',{event:'UPDATE',schema:'public',table:'call_sessions',filter:`id=eq.${call.id}`},p=>{
            if(['ended','rejected','missed'].includes(p.new.status)){
              callManager._dismissIncoming();
              supabase.removeChannel(callWatcher); callWatcher=null;
            }
          }).subscribe();
      }).subscribe();

    // Recover an active ringing call after refresh.
    const { data } = await supabase.from('call_sessions').select(`id,type,status,conversation_id,caller_id,callee_id,created_at,caller:profiles!call_sessions_caller_id_fkey(id,name,avatar_url)`)
      .eq('callee_id',state.user.id).eq('status','ringing').order('created_at',{ascending:false}).limit(1).maybeSingle();
    if (data) {
      callManager.showIncoming(data);
      callWatcher = supabase.channel(`incoming-call-status:${data.id}`)
        .on('postgres_changes',{event:'UPDATE',schema:'public',table:'call_sessions',filter:`id=eq.${data.id}`},p=>{
          if(['ended','rejected','missed'].includes(p.new.status)){
            callManager._dismissIncoming();
            supabase.removeChannel(callWatcher); callWatcher=null;
          }
        }).subscribe();
    }
  }

  async function startFromConversation(mode) {
    const c=state.activeConversation;if(!c)return;
    try {
      const peerId=c.kind==='direct'?c.other?.id:null;
      await callManager.startOutgoing({conversationId:c.id,peerId,mode,groupName:c.group?.name});
    } catch(e){ui.toast(humanError(e));}
  }

  ui.audioCallBtn.addEventListener('click',()=>startFromConversation('audio'));
  ui.videoCallBtn.addEventListener('click',()=>startFromConversation('video'));

  return {
    start: watchIncoming,
    stop(){if(incomingSub)supabase.removeChannel(incomingSub);if(callWatcher)supabase.removeChannel(callWatcher);}
  };
}
