import { supabase } from './supabase.js';
import { $, escapeHtml, formatRelative, formatTime, avatarMarkup, debounce, humanError } from './utils.js';

const REACTIONS = ['👍','❤️','😂','😮','😢','😡','🎉'];

export function createChatManager(state, ui) {
  let activeCleanup = null;
  let conversationsCache = [];

  function convoLabel(c) { return c.kind === 'group' ? c.group?.name : c.other?.name; }
  function convoAvatar(c) { return c.kind === 'group' ? c.group?.avatar_url : c.other?.avatar_url; }

  async function loadConversations() {
    const { data, error } = await supabase
      .from('conversation_members')
      .select(`conversation_id,read_at,last_seen_at,conversations(
        id,kind,created_at,updated_at,
        groups(id,name,avatar_url,owner_id),
        conversation_members(user_id,read_at,last_seen_at,profiles(id,name,avatar_url))
      )`)
      .eq('user_id', state.user.id)
      .order('last_seen_at', { ascending: false });

    if (error) { ui.toast(humanError(error)); return; }
    conversationsCache = (data || []).map(row => {
      const c = row.conversations;
      if (!c) return null;
      const members = (c.conversation_members || []).filter(m => m.user_id !== state.user.id);
      c.group = Array.isArray(c.groups) ? c.groups[0] : c.groups;
      c.other = c.kind === 'direct'
        ? (members[0]?.profiles || { id: members[0]?.user_id, name: 'Kullanıcı', avatar_url: null })
        : null;
      c.read_at = row.read_at;
      c.last_seen_at = row.last_seen_at;
      return c;
    }).filter(Boolean);

    await hydrateLastMessages();
    renderConversationList();
  }

  async function hydrateLastMessages() {
    if (!conversationsCache.length) return;
    const ids = conversationsCache.map(c => c.id);
    const { data } = await supabase.from('messages')
      .select('id,conversation_id,sender_id,body,created_at')
      .in('conversation_id', ids).order('created_at', { ascending: false }).limit(Math.min(300, ids.length * 25));
    const latest = new Map();
    for (const m of data || []) if (!latest.has(m.conversation_id)) latest.set(m.conversation_id, m);
    for (const c of conversationsCache) {
      c.last_message = latest.get(c.id);
      c.unread = c.read_at && c.last_message ? new Date(c.last_message.created_at) > new Date(c.read_at) && c.last_message.sender_id !== state.user.id : false;
    }
  }

  function renderConversationList() {
    const filter = state.conversationFilter || 'all';
    const query = (state.searchQuery || '').trim().toLowerCase();
    const items = conversationsCache.filter(c => {
      if (filter === 'unread' && !c.unread) return false;
      if (!query) return true;
      return [convoLabel(c), c.last_message?.body, c.other?.email].filter(Boolean).some(v => String(v).toLowerCase().includes(query));
    });

    ui.conversationList.innerHTML = items.map(c => `
      <div class="conversation-item ${c.id === state.activeConversationId ? 'active' : ''}" data-conversation-id="${c.id}">
        ${avatarMarkup(convoAvatar(c), convoLabel(c) || 'Kullanıcı')}
        <div class="conversation-meta">
          <strong>${escapeHtml(convoLabel(c) || 'Kullanıcı')}</strong>
          <small>${escapeHtml(c.last_message?.body || 'Yeni konuşma')}</small>
        </div>
        <div class="conversation-side">
          <span class="time">${formatRelative(c.last_message?.created_at || c.updated_at)}</span>
          ${c.unread ? `<span class="unread-badge">•</span>` : ''}
        </div>
      </div>
    `).join('') || `<div class="muted" style="padding:30px;text-align:center">Henüz sohbet yok.</div>`;

    ui.conversationList.querySelectorAll('[data-conversation-id]').forEach(el => {
      el.addEventListener('click', () => openConversation(el.dataset.conversationId));
    });
  }

  async function fetchConversation(id) {
    return conversationsCache.find(c => c.id === id);
  }

  async function markRead(conversationId) {
    await supabase.from('conversation_members')
      .update({ read_at: new Date().toISOString(), last_seen_at: new Date().toISOString() })
      .eq('conversation_id', conversationId).eq('user_id', state.user.id);
    const c = conversationsCache.find(x => x.id === conversationId);
    if (c) { c.read_at = new Date().toISOString(); c.unread = false; }
    renderConversationList();
  }

  async function loadMessages(conversationId) {
    const { data, error } = await supabase.from('messages')
      .select(`id,conversation_id,sender_id,body,reply_to_id,created_at,profiles(id,name,avatar_url),message_reactions(id,user_id,emoji)`)
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true })
      .limit(500);
    if (error) { ui.toast(humanError(error)); return []; }
    const ids = (data || []).map(m => m.id);
    const { data: pins } = ids.length ? await supabase.from('pinned_messages').select('message_id,user_id').in('message_id', ids) : { data: [] };
    const pinSet = new Set((pins || []).map(p => p.message_id));
    return (data || []).map(m => ({ ...m, pinned: pinSet.has(m.id) }));
  }

  function messageHtml(m) {
    const mine = m.sender_id === state.user.id;
    const reactions = new Map();
    for (const r of m.message_reactions || []) reactions.set(r.emoji, (reactions.get(r.emoji) || 0) + 1);
    return `<div class="msg-row ${mine ? 'mine' : ''}" id="msg-${m.id}">
      <div class="bubble">
        <div class="msg-menu">
          <button class="mini-action" data-reply="${m.id}" title="Yanıtla">↩</button>
          <button class="mini-action" data-react="${m.id}" title="Tepki">☺</button>
          <button class="mini-action" data-pin="${m.id}" title="${m.pinned ? 'Sabitlemeyi kaldır' : 'Sabitle'}">⌖</button>
          ${mine ? `<button class="mini-action" data-delete="${m.id}" title="Sil">⌫</button>` : ''}
        </div>
        ${!mine && state.activeConversation?.kind === 'group' ? `<div class="sender-name">${escapeHtml(m.profiles?.name || 'Kullanıcı')}</div>` : ''}
        ${m.reply_to_id ? `<div class="reply-mini">↳ yanıt</div>` : ''}
        <div class="msg-text">${escapeHtml(m.body)}</div>
        <div class="msg-time">${formatTime(m.created_at)}${mine ? ' ✓' : ''}</div>
        <div class="reactions">
          ${[...reactions.entries()].map(([emoji,count]) => `<button class="reaction ${m.message_reactions?.some(r => r.user_id === state.user.id && r.emoji === emoji) ? 'mine' : ''}" data-react-one="${m.id}" data-emoji="${emoji}">${emoji} ${count}</button>`).join('')}
        </div>
      </div>
    </div>`;
  }

  function scrollBottom() {
    ui.messageList.scrollTop = ui.messageList.scrollHeight;
  }

  async function openConversation(id) {
    if (activeCleanup) activeCleanup();
    const c = await fetchConversation(id);
    if (!c) return;
    state.activeConversationId = id;
    state.activeConversation = c;
    ui.emptyChat.classList.add('hidden');
    ui.conversationView.classList.remove('hidden');
    document.querySelector('.main-view').classList.add('chat-open');
    ui.chatTitle.textContent = convoLabel(c) || 'Kullanıcı';
    ui.chatStatus.textContent = c.kind === 'group' ? `${c.group?.name || ''} grup` : getOnlineText(c.other?.id, c.other?.last_seen_at);
    ui.chatAvatar.outerHTML = avatarMarkup(convoAvatar(c), convoLabel(c), 'avatar large');
    ui.messageList.innerHTML = `<div class="muted" style="text-align:center;padding:40px">Yükleniyor…</div>`;

    const messages = await loadMessages(id);
    state.messages = messages;
    renderMessages();
    await markRead(id);

    activeCleanup = state.realtime.subscribeConversation(id, {
      message: async m => {
        if (m.sender_id !== state.user.id && m.conversation_id === state.activeConversationId) {
          const { data } = await supabase.from('messages').select(`id,conversation_id,sender_id,body,reply_to_id,created_at,profiles(id,name,avatar_url),message_reactions(id,user_id,emoji)`).eq('id', m.id).single();
          if (data && !state.messages.some(x => x.id === data.id)) { state.messages.push(data); renderMessages(); scrollBottom(); markRead(id); }
        } else {
          loadConversations();
        }
      },
      reaction: () => reloadActiveMessages(),
      pin: () => reloadActiveMessages()
    });
    await renderPinned();
  }

  function getOnlineText(userId, lastSeen) {
    return state.presence?.[userId] ? 'çevrimiçi' : (lastSeen ? `son görülme ${formatRelative(lastSeen)}` : 'çevrimdışı');
  }

  async function reloadActiveMessages() {
    if (!state.activeConversationId) return;
    state.messages = await loadMessages(state.activeConversationId);
    renderMessages();
    renderPinned();
  }

  function renderMessages() {
    ui.messageList.innerHTML = state.messages.map(messageHtml).join('') || `<div class="muted" style="text-align:center;padding:40px">İlk mesajı sen gönder.</div>`;
    bindMessageActions();
    scrollBottom();
  }

  function bindMessageActions() {
    ui.messageList.querySelectorAll('[data-reply]').forEach(btn => btn.addEventListener('click', () => {
      const m = state.messages.find(x => x.id === btn.dataset.reply);
      state.replyTo = m;
      ui.replyBar.classList.remove('hidden');
      ui.replyPreview.textContent = m?.body || '';
      ui.messageInput.focus();
    }));
    ui.messageList.querySelectorAll('[data-delete]').forEach(btn => btn.addEventListener('click', async () => {
      const { error } = await supabase.from('messages').delete().eq('id', btn.dataset.delete).eq('sender_id', state.user.id);
      if (error) ui.toast(humanError(error)); else await reloadActiveMessages();
    }));
    ui.messageList.querySelectorAll('[data-pin]').forEach(btn => btn.addEventListener('click', async () => {
      const m = state.messages.find(x => x.id === btn.dataset.pin);
      if (!m) return;
      const existing = await supabase.from('pinned_messages').select('id').eq('message_id', m.id).maybeSingle();
      let error;
      if (existing.data) ({ error } = await supabase.from('pinned_messages').delete().eq('message_id', m.id).eq('user_id', state.user.id));
      else ({ error } = await supabase.from('pinned_messages').insert({ conversation_id: state.activeConversationId, message_id: m.id, user_id: state.user.id }));
      if (error) ui.toast(humanError(error)); else await reloadActiveMessages();
    }));
    ui.messageList.querySelectorAll('[data-react]').forEach(btn => btn.addEventListener('click', () => openReactionPicker(btn.dataset.react)));
    ui.messageList.querySelectorAll('[data-react-one]').forEach(btn => btn.addEventListener('click', async () => toggleReaction(btn.dataset.reactOne, btn.dataset.emoji)));
  }

  function openReactionPicker(messageId) {
    const picker = document.createElement('div');
    picker.className = 'emoji-picker';
    picker.style.position='fixed'; picker.style.left='auto'; picker.style.right='30px'; picker.style.bottom='90px'; picker.style.zIndex='120';
    picker.innerHTML = REACTIONS.map(e => `<button data-pick="${e}">${e}</button>`).join('');
    document.body.appendChild(picker);
    picker.querySelectorAll('[data-pick]').forEach(b => b.addEventListener('click', async () => { await toggleReaction(messageId, b.dataset.pick); picker.remove(); }));
    setTimeout(() => { if (picker.isConnected) picker.remove(); }, 5000);
  }

  async function toggleReaction(messageId, emoji) {
    const { data: existing } = await supabase.from('message_reactions').select('id').eq('message_id', messageId).eq('user_id', state.user.id).eq('emoji', emoji).maybeSingle();
    const result = existing
      ? await supabase.from('message_reactions').delete().eq('id', existing.id)
      : await supabase.from('message_reactions').insert({ message_id: messageId, user_id: state.user.id, emoji });
    if (result.error) ui.toast(humanError(result.error)); else await reloadActiveMessages();
  }

  async function sendMessage() {
    const body = ui.messageInput.value.trim();
    if (!body || !state.activeConversationId) return;
    ui.messageInput.value = '';
    ui.messageInput.style.height = '42px';
    const payload = { conversation_id: state.activeConversationId, sender_id: state.user.id, body, reply_to_id: state.replyTo?.id || null };
    const { error } = await supabase.from('messages').insert(payload);
    if (error) { ui.toast(humanError(error)); ui.messageInput.value = body; return; }
    state.replyTo = null; ui.replyBar.classList.add('hidden');
    const c = conversationsCache.find(x => x.id === state.activeConversationId);
    if (c) { c.last_message = { body, created_at: new Date().toISOString(), sender_id: state.user.id }; c.unread = false; }
    renderConversationList();
  }

  async function createDirectChat(profile) {
    const { data: existing } = await supabase.rpc('find_direct_conversation', { other_user_id: profile.id });
    let id = existing;
    if (!id) {
      const { data: newConversation, error } = await supabase.from('conversations').insert({ kind: 'direct' }).select('id').single();
      if (error) throw error;
      id = newConversation.id;
      const { error: memberError } = await supabase.from('conversation_members').insert([
        { conversation_id: id, user_id: state.user.id },
        { conversation_id: id, user_id: profile.id }
      ]);
      if (memberError) throw memberError;
    }
    await loadConversations();
    await openConversation(id);
  }

  async function showNewChatModal() {
    ui.openModal(`<div class="modal-backdrop" data-modal="new-chat"><div class="modal sm">
      <div class="modal-head"><h3>Yeni sohbet</h3><button class="icon-btn" data-close-modal>×</button></div>
      <div class="modal-body"><input id="userSearchModal" placeholder="İsim veya e-posta ara…"><div id="userResults" class="list"></div></div>
    </div></div>`);
    const input = $('#userSearchModal'), results = $('#userResults');
    const search = debounce(async () => {
      const q = input.value.trim();
      if (q.length < 2) { results.innerHTML = `<div class="muted">En az 2 karakter yaz.</div>`; return; }
      const { data, error } = await supabase.rpc('search_profiles', { search_text: q, max_rows: 20 });
      if (error) { results.innerHTML = `<div class="muted">${escapeHtml(humanError(error))}</div>`; return; }
      results.innerHTML = (data || []).filter(p => p.id !== state.user.id).map(p => `
        <button class="list-item" data-user-id="${p.id}" style="text-align:left">${avatarMarkup(p.avatar_url,p.name)}
        <span class="grow"><strong>${escapeHtml(p.name)}</strong><small>${escapeHtml(p.email || '')}</small></span></button>`).join('') || `<div class="muted">Kullanıcı bulunamadı.</div>`;
      results.querySelectorAll('[data-user-id]').forEach(b => b.addEventListener('click', async () => {
        const profile = (data || []).find(p => p.id === b.dataset.userId);
        ui.closeModal(); try { await createDirectChat(profile); } catch(e) { ui.toast(humanError(e)); }
      }));
    }, 250);
    input.addEventListener('input', search); input.focus();
  }

  async function showGroupCreateModal() {
    ui.openModal(`<div class="modal-backdrop" data-modal="group-create"><div class="modal">
      <div class="modal-head"><h3>Yeni grup</h3><button class="icon-btn" data-close-modal>×</button></div>
      <div class="modal-body">
        <div class="field"><label>Grup adı</label><input id="groupNameInput" maxlength="80" placeholder="Örn. Proje ekibi"></div>
        <div class="field"><label>Üyeleri ara</label><input id="groupMemberSearch" placeholder="Kullanıcı ara…"></div>
        <div id="groupCandidates" class="list"></div><div id="groupSelected" class="muted">Henüz üye seçilmedi.</div>
      </div>
      <div class="modal-actions"><button class="secondary-btn" data-close-modal>İptal</button><button id="createGroupSubmit" class="primary-btn" style="width:auto">Grubu oluştur</button></div>
    </div></div>`);
    const input = $('#groupMemberSearch'), candidates = $('#groupCandidates'), selectedEl = $('#groupSelected');
    const selected = new Map();
    const renderSelected = () => selectedEl.textContent = selected.size ? `${selected.size} üye seçildi: ${[...selected.values()].map(x => x.name).join(', ')}` : 'Henüz üye seçilmedi.';
    const search = debounce(async () => {
      const q = input.value.trim(); if (q.length < 2) return;
      const { data } = await supabase.rpc('search_profiles', { search_text:q, max_rows:20 });
      candidates.innerHTML=(data||[]).filter(p=>p.id!==state.user.id).map(p=>`<button class="list-item" data-id="${p.id}" style="text-align:left">${avatarMarkup(p.avatar_url,p.name)}<span class="grow"><strong>${escapeHtml(p.name)}</strong><small>${escapeHtml(p.email||'')}</small></span></button>`).join('');
      candidates.querySelectorAll('[data-id]').forEach(b=>b.addEventListener('click',()=>{const p=(data||[]).find(x=>x.id===b.dataset.id); selected.set(p.id,p); renderSelected();}));
    },250);
    input.addEventListener('input',search);
    $('#createGroupSubmit').addEventListener('click', async () => {
      const name=$('#groupNameInput').value.trim(); if (!name) return ui.toast('Grup adı gerekli.');
      if (!selected.size) return ui.toast('En az bir üye seç.');
      try {
        const { data: conv, error } = await supabase.from('conversations').insert({ kind:'group' }).select('id').single(); if(error)throw error;
        const { data: group, error: gmErr }=await supabase.from('groups').insert({conversation_id:conv.id,name,owner_id:state.user.id}).select('id').single(); if(gmErr)throw gmErr;
        const { error: selfMemberError}=await supabase.from('conversation_members').insert({conversation_id:conv.id,user_id:state.user.id}); if(selfMemberError)throw selfMemberError;
        const { error: selfGroupError}=await supabase.from('group_members').insert({group_id:group.id,user_id:state.user.id,role:'admin'}); if(selfGroupError)throw selfGroupError;
        const others=[...selected.keys()].map(user_id=>({conversation_id:conv.id,user_id}));
        const { error: mErr}=await supabase.from('conversation_members').insert(others); if(mErr)throw mErr;
        const { error: gErr}=await supabase.from('group_members').insert(others.map(x=>({group_id:group.id,user_id:x.user_id,role:'member'}))); if(gErr)throw gErr;
        ui.closeModal(); await loadConversations(); await openConversation(conv.id);
      }catch(e){ui.toast(humanError(e));}
    });
  }

  async function showConversationInfo() {
    const c=state.activeConversation;
    if(!c)return;
    if(c.kind!=='group'){ ui.openModal(`<div class="modal-backdrop"><div class="modal sm"><div class="modal-head"><h3>Sohbet bilgisi</h3><button class="icon-btn" data-close-modal>×</button></div><div class="modal-body">${avatarMarkup(c.other?.avatar_url,c.other?.name,'avatar xl')}<h3 style="margin:0">${escapeHtml(c.other?.name||'Kullanıcı')}</h3><div class="muted">${escapeHtml(c.other?.email||'')}</div></div></div></div>`);return;}
    const {data:members}=await supabase.from('group_members').select('user_id,role,profiles(id,name,avatar_url)').eq('group_id',c.id);
    ui.openModal(`<div class="modal"><div class="modal-head"><h3>${escapeHtml(c.group?.name||'Grup')}</h3><button class="icon-btn" data-close-modal>×</button></div><div class="list">${(members||[]).map(m=>`<div class="list-item">${avatarMarkup(m.profiles?.avatar_url,m.profiles?.name)}<span class="grow"><strong>${escapeHtml(m.profiles?.name)}</strong><small>${m.role==='admin'?'Yönetici':'Üye'}</small></span></div>`).join('')}</div></div>`);
  }

  async function renderPinned() {
    if (!state.activeConversationId) return;
    const {data}=await supabase.from('pinned_messages').select('message_id,messages(body,created_at)').eq('conversation_id',state.activeConversationId).order('created_at',{ascending:false}).limit(5);
    const pins=(data||[]).filter(x=>x.messages).map(x=>`<button data-jump-pin="${x.message_id}"><strong>⌖ Sabit</strong> · ${escapeHtml(x.messages.body.slice(0,120))}</button>`).join('');
    ui.pinnedBar.innerHTML=pins; ui.pinnedBar.classList.toggle('hidden',!pins);
    ui.pinnedBar.querySelectorAll('[data-jump-pin]').forEach(b=>b.addEventListener('click',()=>document.getElementById(`msg-${b.dataset.jumpPin}`)?.scrollIntoView({behavior:'smooth',block:'center'})));
  }

  function init() {
    ui.messageForm.addEventListener('submit',e=>{e.preventDefault();sendMessage();});
    ui.messageInput.addEventListener('input',()=>{ui.messageInput.style.height='auto';ui.messageInput.style.height=Math.min(ui.messageInput.scrollHeight,120)+'px';});
    ui.messageInput.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMessage();}});
    ui.cancelReplyBtn.addEventListener('click',()=>{state.replyTo=null;ui.replyBar.classList.add('hidden');});
    ui.emojiBtn.addEventListener('click',()=>ui.emojiPicker.classList.toggle('hidden'));
    ui.emojiPicker.innerHTML=REACTIONS.map(e=>`<button data-emoji="${e}">${e}</button>`).join('');
    ui.emojiPicker.querySelectorAll('[data-emoji]').forEach(b=>b.addEventListener('click',()=>{ui.messageInput.value+=b.dataset.emoji;ui.messageInput.focus();ui.emojiPicker.classList.add('hidden');}));
    $('#newChatBtn').addEventListener('click',showNewChatModal);
    $('#newGroupBtn').addEventListener('click',showGroupCreateModal);
    $('#chatInfoBtn').addEventListener('click',showConversationInfo);
    $('#mobileBackBtn').addEventListener('click',()=>document.querySelector('.main-view').classList.remove('chat-open'));
    $('#pinnedBtn').addEventListener('click',()=>ui.pinnedBar.classList.toggle('hidden'));
    ui.searchInput.addEventListener('input',debounce(()=>{state.searchQuery=ui.searchInput.value;renderConversationList();},120));
    document.querySelectorAll('.tab-btn').forEach(b=>b.addEventListener('click',()=>{document.querySelectorAll('.tab-btn').forEach(x=>x.classList.remove('active'));b.classList.add('active');state.conversationFilter=b.dataset.filter;renderConversationList();}));
    return { loadConversations, renderConversationList, openConversation, get conversations(){return conversationsCache;} };
  }

  return init();
}
