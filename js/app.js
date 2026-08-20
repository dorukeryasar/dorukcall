import { supabase } from './supabase.js';
import { $, humanError } from './utils.js';
import { initAuth } from './auth.js';
import { createRealtimeManager } from './realtime.js';
import { createChatManager } from './chat.js';
import { createNotificationManager } from './notifications.js';
import { loadMyProfile, openSettings, setTheme } from './profile.js';
import { WebRTCCallManager } from './webrtc.js';
import { initCallLayer } from './calls.js';

const state = {
  user:null, profile:null, name:'', avatarUrl:null,
  theme:localStorage.getItem('dorukcall-theme') || 'light',
  presence:{}, notifications:[], activeConversationId:null, activeConversation:null, messages:[],
  conversationFilter:'all', searchQuery:'', realtime:null, openModal:null, closeModal:null,
  getProfileName:id => state.profileCache?.[id]?.name || 'Katılımcı', profileCache:{}
};

document.documentElement.dataset.theme=state.theme;

const ui = {
  authView:$('#authView'), mainView:$('#mainView'),
  conversationList:$('#conversationList'), searchInput:$('#searchInput'),
  emptyChat:$('#emptyChat'), conversationView:$('#conversationView'), chatAvatar:$('#chatAvatar'),
  chatTitle:$('#chatTitle'), chatStatus:$('#chatStatus'), messageList:$('#messageList'),
  messageForm:$('#messageForm'), messageInput:$('#messageInput'), emojiBtn:$('#emojiBtn'), emojiPicker:$('#emojiPicker'),
  replyBar:$('#replyBar'), replyPreview:$('#replyPreview'), cancelReplyBtn:$('#cancelReplyBtn'), pinnedBar:$('#pinnedBar'),
  audioCallBtn:$('#audioCallBtn'), videoCallBtn:$('#videoCallBtn'), incomingRoot:$('#incomingCallRoot'), callRoot:$('#callOverlayRoot'),
  toast:msg=>toast(msg)
};

function toast(message) {
  if(!message)return;
  const el=document.createElement('div');el.className='toast';el.textContent=message;$('#toastRoot').appendChild(el);
  setTimeout(()=>el.remove(),4200);
}

ui.openModal = html => {
  $('#modalRoot').innerHTML=html;
  document.querySelectorAll('[data-close-modal]').forEach(b=>b.addEventListener('click',ui.closeModal));
  document.querySelectorAll('.modal-backdrop').forEach(b=>b.addEventListener('click',e=>{if(e.target===b)ui.closeModal();}));
};
ui.closeModal=()=>$('#modalRoot').innerHTML='';
ui.refreshMe=()=>{ $('#meName').textContent=state.name || '—'; $('#meAvatar').src=state.avatarUrl || ''; $('#meAvatar').alt=state.name || 'Profil'; };

async function enterApp(user) {
  if(state.user?.id===user.id)return;
  state.user=user;
  ui.authView.classList.add('hidden'); ui.mainView.classList.remove('hidden');
  try {
    await loadMyProfile(state);
    ui.refreshMe();
    state.realtime=createRealtimeManager(state);
    state.realtime.presenceChannel();
    state.realtime.subscribeProfiles({profile:p=>{state.profileCache[p.id]=p;if(p.id===state.user.id){state.name=p.name;state.avatarUrl=p.avatar_url;ui.refreshMe();}}});
    const chat=createChatManager(state,{...ui,toast,openModal:ui.openModal,closeModal:ui.closeModal,conversationList:ui.conversationList,searchInput:ui.searchInput});
    state.chat=chat; await chat.loadConversations();
    state.profileCache[state.user.id]=state.profile;

    const notifications=createNotificationManager({...state,onNotificationsChanged:n=>{/* handled in app */},openModal:ui.openModal,closeModal:ui.closeModal});
    state.notificationsManager=notifications; await notifications.start();

    const callManager=new WebRTCCallManager({...state,beep:type=>beep(type),toast},ui);
    state.callManager=callManager;
    state.calls=initCallLayer(state,ui,callManager); await state.calls.start();

    $('#notificationBtn').onclick=()=>notifications.open();
    $('#settingsBtn').onclick=()=>openSettings(state,ui);
    $('#profileStrip').onclick=()=>openSettings(state,ui);
    window.addEventListener('beforeunload',cleanupSession,{once:true});
    maybeAskNotificationPermission();
  } catch(e) {
    toast(humanError(e));
  }
}

function cleanupSession() {
  state.notificationsManager?.stop();state.calls?.stop();state.realtime?.cleanup();
}

function onLoggedOut() {
  cleanupSession();
  state.user=null;state.profile=null;state.name='';state.activeConversationId=null;
  ui.mainView.classList.add('hidden');ui.authView.classList.remove('hidden');
}

function beep(type='message'){
  try{
    const ctx=new (window.AudioContext||window.webkitAudioContext)(),osc=ctx.createOscillator(),gain=ctx.createGain(),t=ctx.currentTime;
    osc.frequency.value=type==='call'?660:520;gain.gain.setValueAtTime(.0001,t);gain.gain.exponentialRampToValueAtTime(type==='call'?.18:.07,t+.02);gain.gain.exponentialRampToValueAtTime(.0001,t+(type==='call'?.5:.12));osc.connect(gain).connect(ctx.destination);osc.start(t);osc.stop(t+(type==='call'?.52:.14));
  }catch{}
}

function maybeAskNotificationPermission() {
  if(!('Notification' in window) || Notification.permission!=='default') return;
  setTimeout(()=>{if(confirm('DorukCall bildirimleri için tarayıcı bildirimlerini açmak ister misin?')) window.dispatchEvent(new CustomEvent('dorukcall:request-notification-permission'));},2200);
}

async function handlePasswordRecovery(){
  if(!location.search.includes('reset=1'))return;
  setTimeout(()=>{const pw=prompt('Yeni şifre (en az 8 karakter):');if(pw)supabase.auth.updateUser({password:pw}).then(({error})=>toast(error?humanError(error):'Şifren güncellendi.'));},600);
}

initAuth({onAuthenticated:enterApp,onLoggedOut});
handlePasswordRecovery();
