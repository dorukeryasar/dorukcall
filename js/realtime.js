import { supabase } from './supabase.js';

export function createRealtimeManager(state) {
  const channels = new Set();

  function subscribeConversation(conversationId, handlers) {
    const channel = supabase.channel(`conversation:${conversationId}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `conversation_id=eq.${conversationId}` }, p => handlers.message?.(p.new))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'message_reactions' }, p => handlers.reaction?.(p))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'pinned_messages', filter: `conversation_id=eq.${conversationId}` }, p => handlers.pin?.(p))
      .subscribe();
    channels.add(channel);
    return () => { supabase.removeChannel(channel); channels.delete(channel); };
  }

  function subscribeProfiles(handlers) {
    const channel = supabase.channel('profiles-presence')
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'profiles' }, p => handlers.profile?.(p.new))
      .subscribe();
    channels.add(channel);
    return () => { supabase.removeChannel(channel); channels.delete(channel); };
  }

  function presenceChannel() {
    const channel = supabase.channel('dorukcall:presence', {
      config: { presence: { key: state.user.id } }
    });
    channels.add(channel);
    channel.on('presence', { event: 'sync' }, () => {
      state.presence = channel.presenceState();
      state.onPresenceChanged?.();
    });
    channel.on('presence', { event: 'join' }, ({ key }) => state.onPresenceChanged?.(key, true));
    channel.on('presence', { event: 'leave' }, ({ key }) => state.onPresenceChanged?.(key, false));
    channel.subscribe(async status => {
      if (status === 'SUBSCRIBED') {
        await channel.track({ user_id: state.user.id, online_at: new Date().toISOString() });
      }
    });
    return channel;
  }

  return {
    subscribeConversation,
    subscribeProfiles,
    presenceChannel,
    cleanup() { [...channels].forEach(c => supabase.removeChannel(c)); channels.clear(); }
  };
}
