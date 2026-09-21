const CACHE='ytshield-v2';
const CORE=['/','/styles.css','/app.js','/icon.svg','/manifest.webmanifest'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(CORE)));self.skipWaiting();});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))));self.clients.claim();});
self.addEventListener('fetch',e=>{
  if(e.request.method!=='GET')return;
  const url=new URL(e.request.url);
  if(url.pathname.startsWith('/api/')||url.pathname==='/ws')return;
  e.respondWith(fetch(e.request).then(r=>{const copy=r.clone();caches.open(CACHE).then(c=>c.put(e.request,copy));return r;}).catch(()=>caches.match(e.request).then(r=>r||caches.match('/'))));
});
self.addEventListener('push',e=>{
  let data={title:'YT Shield Live',body:'Yangi ogohlantirish',data:{}};
  try{data={...data,...e.data.json()};}catch{}
  e.waitUntil(self.registration.showNotification(data.title,{body:data.body,icon:'/icon.svg',badge:'/icon.svg',data:data.data,tag:'ytshield-alert',renotify:true}));
});
self.addEventListener('notificationclick',e=>{e.notification.close();e.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then(list=>{for(const c of list){if('focus'in c)return c.focus();}return clients.openWindow('/');}));});
