import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer } from '../server.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const contactOnly = process.argv.includes('--contact-only');
const browser = [process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find((candidate) => candidate && existsSync(candidate));
if (!browser) throw new Error('Set CHROME_PATH to an installed Chrome/Chromium browser.');
const artifacts = path.join(root, '.cache', 'browser');
await mkdir(artifacts, { recursive: true });
const profile = await mkdtemp(path.join(os.tmpdir(), 'htss-browser-'));
const messages = [];
let rejectMail = false;
let releaseMail;
let holdMail = false;
const server = createServer({
  root: path.join(root, 'dist'),
  env: { CONTACT_TO: 'info@htss-co.kz', CONTACT_FROM: 'site@example.test', SMTP_HOST: 'smtp.example.test', SMTP_USER: 'test', SMTP_PASS: 'test' },
  rateLimit: { maximum: 100 },
  logger: { error() {} },
  mailer: { async sendMail(message) {
    messages.push(message);
    if (rejectMail) throw new Error('Simulated SMTP failure');
    if (holdMail) await new Promise((resolve) => { releaseMail = resolve; });
    return { accepted: ['info@htss-co.kz'] };
  } },
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const chrome = spawn(browser, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--no-proxy-server', '--host-resolver-rules=MAP formsubmit.co ~NOTFOUND', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
let socket;
let count = 0;
const errors = [];
const resources = [];
try {
  let endpoint;
  let startupOutput='';
  let startupError;
  chrome.stderr.on('data',(data)=>{startupOutput+=data;});
  chrome.on('error',(error)=>{startupError=error;});
  const startupDeadline=Date.now()+20_000;
  while (!endpoint && Date.now()<startupDeadline) {
    if (startupError) throw startupError;
    endpoint=startupOutput.match(/DevTools listening on (ws:\/\/\S+)/)?.[1];
    if (!endpoint) {
      // Windows launchers can hand off to a child without forwarding stderr.
      const active=await readFile(path.join(profile,'DevToolsActivePort'),'utf8').catch(()=> '');
      const [port,route]=active.trim().split(/\r?\n/);
      if (/^\d+$/.test(port) && /^\/devtools\/browser\/[\w-]+$/.test(route)) endpoint=`ws://127.0.0.1:${port}${route}`;
    }
    if (!endpoint) await new Promise((resolve)=>setTimeout(resolve,100));
  }
  if (!endpoint) throw new Error(`Browser startup timed out: ${startupOutput.slice(-500)}`);
  const tabs = await (await fetch(`http://${new URL(endpoint).host}/json/list`,{signal:AbortSignal.timeout(10000)})).json();
  socket = new WebSocket(tabs.find((tab) => tab.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { const timer=setTimeout(()=>reject(new Error('Browser websocket timed out')),10000); socket.addEventListener('open',()=>{clearTimeout(timer);resolve();},{once:true}); socket.addEventListener('error',(error)=>{clearTimeout(timer);reject(error);},{once:true}); });
  const pending = new Map();
  const listeners = new Map();
  let interceptRequest;
  let sequence = 0;
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const entry = pending.get(message.id);
      if (entry) { clearTimeout(entry.timer); pending.delete(message.id); message.error ? entry.reject(new Error(JSON.stringify(message.error))) : entry.resolve(message.result); }
      return;
    }
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
    if (message.method === 'Network.requestWillBeSent') resources.push(message.params.request.url);
    if (message.method === 'Log.entryAdded' && message.params.entry.source === 'security' && message.params.entry.level === 'error') errors.push(message.params.entry.text);
    if (message.method === 'Fetch.requestPaused' && interceptRequest) {
      Promise.resolve(interceptRequest(message.params)).catch((error) => errors.push(error.message));
    }
    (listeners.get(message.method) || []).splice(0).forEach((fn) => fn(message.params));
  });
  const cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timed out: ${method}`)); }, 25_000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  const event = (name) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Event timed out: ${name}`)), 20_000);
    if (!listeners.has(name)) listeners.set(name, []);
    listeners.get(name).push((value) => { clearTimeout(timer); resolve(value); });
  });
  const evaluate = async (expression) => {
    const result = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result?.value;
  };
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const check = (name, actual, expected = true) => { assert.deepEqual(actual, expected, name); count++; console.log(`PASS ${name}`); };
  const viewport = async (width, height) => { await cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 768 }); await pause(80); };
  const navigate = async (url) => { const loaded = event('Page.loadEventFired'); await cdp('Page.navigate', { url }); await loaded; await evaluate('document.fonts.ready.then(()=>true)'); };
  const screenshot = async (name) => { const result = await cdp('Page.captureScreenshot', { format: 'png' }); await writeFile(path.join(artifacts, name), Buffer.from(result.data, 'base64')); };
  const loadedBrandImages = async (selector) => evaluate(`(async()=>{
    const images=[...document.querySelectorAll(${JSON.stringify(selector)})];
    await Promise.all(images.map(image=>image.complete ? Promise.resolve() : new Promise(resolve=>{
      const timer=setTimeout(resolve,5000);
      const done=()=>{clearTimeout(timer);resolve()};
      image.addEventListener('load',done,{once:true});
      image.addEventListener('error',done,{once:true});
    })));
    return images.map(image=>{
      const rect=image.getBoundingClientRect();
      return image.complete && image.naturalWidth>0 && image.naturalHeight>0 && rect.width>0 && rect.height>0 && new URL(image.currentSrc,document.baseURI).pathname.endsWith('/assets/media/logo.webp');
    });
  })()`);
  const headerBrandLayout = async () => evaluate(`(()=>{
    const row=document.querySelector('.navbar .nav-inner');
    const brand=row?.querySelector('.brand');
    if(!row || !brand) return {issues:['Header brand is missing']};
    const visible=element=>{
      const rect=element.getBoundingClientRect(),style=getComputedStyle(element);
      return rect.width>0 && rect.height>0 && style.display!=='none' && style.visibility!=='hidden' && style.opacity!=='0';
    };
    const bounds=element=>{
      const rect=element.getBoundingClientRect();
      return {left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom};
    };
    const brandBounds=bounds(brand);
    const neighbors=[...row.children].filter(element=>element!==brand && visible(element));
    const issues=[];
    if(!visible(brand)) issues.push('Header brand is hidden');
    if(brandBounds.left<-.5 || brandBounds.right>innerWidth+.5) issues.push('Header brand leaves the viewport');
    for(const neighbor of neighbors){
      const rect=bounds(neighbor);
      const overlapWidth=Math.min(brandBounds.right,rect.right)-Math.max(brandBounds.left,rect.left);
      const overlapHeight=Math.min(brandBounds.bottom,rect.bottom)-Math.max(brandBounds.top,rect.top);
      if(overlapWidth>.5 && overlapHeight>.5) issues.push('Header brand overlaps '+neighbor.className);
    }
    for(const text of brand.querySelectorAll('.brand-name,.brand-tagline')){
      const rect=bounds(text);
      if(text.scrollWidth>text.clientWidth+1 || rect.left<-.5 || rect.right>innerWidth+.5) issues.push('Brand text is clipped: '+text.className);
    }
    return {issues,brand:brandBounds,neighbors:neighbors.map(element=>({className:element.className,...bounds(element)}))};
  })()`);
  const key = async (key, options = {}) => { const windowsVirtualKeyCode = { Escape: 27, Tab: 9 }[key]; await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode, ...options }); await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode, ...options }); };
  await cdp('Page.enable'); await cdp('Runtime.enable'); await cdp('Network.enable'); await cdp('Log.enable');
  const layouts = [];
  if (!contactOnly) {
  await viewport(320, 568); await navigate(base);
  check('configured recipient', await evaluate('window.HTSS_CONFIG.contactEmail'), 'info@htss-co.kz');
  check('no remote page dependencies', resources.filter((url) => /^https?:/.test(url) && !url.startsWith(base)), []);
  check('main header company logo loads', await loadedBrandImages('.navbar .brand-logo'), [true]);
  for (const [width, height] of [[320,568],[360,640],[390,844],[568,320],[768,1024]]) {
    await viewport(width, height);
    for (const lang of ['ru', 'kk', 'en']) {
      await evaluate(`window.HTSS_APP.setLanguage('${lang}')`);
      const layout = await evaluate(`(()=>({width:innerWidth,height:innerHeight,language:document.documentElement.lang,overflow:document.documentElement.scrollWidth>innerWidth,clipped:[...document.querySelectorAll('.hero-title span,.section-title,.principle h3,.direction-name,.capability-value,.service-card h3')].filter(x=>x.scrollWidth>x.clientWidth+2).map(x=>x.textContent),missing:[...document.querySelectorAll('[data-i18n],[data-i18n-content],[data-i18n-alt],[data-i18n-aria-label]')].flatMap(x=>[...x.attributes].filter(a=>a.name.startsWith('data-i18n')).filter(a=>!window.HTSS_TRANSLATIONS[document.documentElement.lang][a.value]).map(a=>a.value))}))()`);
      check(`${width}x${height} ${lang} layout`, !layout.overflow && !layout.clipped.length && !layout.missing.length);
      const brand = await headerBrandLayout();
      check(`${width}x${height} ${lang} header brand has room`, brand.issues, []);
      layouts.push({...layout,brand});
    }
  }
  check('mobile does not fetch video', resources.some((url) => url.endsWith('/hero.mp4')), false);
  await viewport(390, 844); await evaluate("HTSS_APP.setLanguage('ru');window.scrollTo({top:0,behavior:'instant'})"); await screenshot('mobile-390.png');
  await evaluate("document.querySelector('#mobile-menu-btn').click()");
  check('menu visible and background inert', await evaluate("!document.querySelector('#mobile-menu').hidden && document.querySelector('main').inert && getComputedStyle(document.body).overflow==='hidden'"));
  await screenshot('mobile-menu.png');
  await evaluate("document.querySelector('#mobile-menu [data-open-contact]').click()");
  check('mobile CTA keeps dialog scroll lock', await evaluate("document.querySelector('#contact-dialog').open && document.querySelector('#mobile-menu').hidden && getComputedStyle(document.body).overflow==='hidden' && document.activeElement.name==='name'"));
  await screenshot('mobile-dialog.png');
  await key('Escape'); await pause(80);
  check('Escape closes dialog and restores focus', await evaluate("({open:document.querySelector('#contact-dialog').open,focused:document.activeElement.id,locked:getComputedStyle(document.body).overflow==='hidden'})"), {open:false,focused:'mobile-menu-btn',locked:false});
  await evaluate("document.querySelector('[data-sector=eng]').click()");
  check('sector follows chosen card', await evaluate("document.querySelector('#contact-form').elements.sector.value"), 'eng');
  check('native dialog traps keyboard', await evaluate("document.querySelector('#contact-dialog').contains(document.activeElement)"));
  for (let i=0;i<12;i++) await key('Tab');
  check('Tab stays inside dialog', await evaluate("document.querySelector('#contact-dialog').contains(document.activeElement)"));
  await evaluate("HTSS_APP.closeContact()");
  await viewport(320,568); await evaluate("HTSS_APP.openContact(document.querySelector('[data-open-contact]'))");
  check('small dialog scrolls inside viewport', await evaluate("(()=>{const d=document.querySelector('#contact-dialog');const r=d.getBoundingClientRect();return r.left>=0 && r.right<=innerWidth && r.top>=0 && r.bottom<=innerHeight && d.scrollHeight>d.clientHeight;})()"));
  await evaluate("(()=>{const f=document.querySelector('#contact-form');f.elements.name.value='Тест';f.elements.phone.value='abc';f.elements.sector.value='eng';f.elements.consent.checked=true;f.requestSubmit()})()");
  check('invalid phone does not submit', messages.length, 0);
  check('invalid phone has accessible error state', await evaluate("document.querySelector('#contact-phone').getAttribute('aria-invalid')"), 'true');
  await evaluate("(()=>{const f=document.querySelector('#contact-form');f.elements.phone.value='+7 701 123 45 67';f.elements.message.value='Browser test';f.requestSubmit()})()");
  await pause(250);
  check('confirmed delivery shows success', await evaluate("document.querySelector('#contact-status').dataset.state"), 'success');
  check('one valid request delivered to mock', messages.length, 1);
  rejectMail = true;
  await evaluate("(()=>{const f=document.querySelector('#contact-form');f.elements.name.value='Ошибка';f.elements.phone.value='+7 701 123 45 67';f.elements.sector.value='other';f.elements.consent.checked=true;f.elements.message.value='Do not lose this';f.requestSubmit()})()"); await pause(250);
  check('failure preserves details', await evaluate("document.querySelector('#contact-status').dataset.state==='error' && document.querySelector('#contact-form').elements.message.value==='Do not lose this'"));
  rejectMail = false; holdMail = true;
  await evaluate("document.querySelector('#contact-form').requestSubmit();document.querySelector('#contact-form').requestSubmit()"); await pause(100);
  check('duplicate click sends once', messages.length, 3);
  check('sending disables button', await evaluate("document.querySelector('#contact-submit').disabled"));
  releaseMail(); holdMail = false; await pause(150); await evaluate("HTSS_APP.closeContact()");
  for (const [width,height] of [[1024,768],[1200,900],[1440,900],[1920,1080]]) {
    await viewport(width,height);
    for (const lang of ['ru','kk','en']) {
      await evaluate(`HTSS_APP.setLanguage('${lang}')`);
      check(`desktop ${width} ${lang}`, await evaluate("document.documentElement.scrollWidth<=innerWidth && [...document.querySelectorAll('.desktop-nav,.header-actions')].filter(x=>getComputedStyle(x).display!=='none').every(x=>x.getBoundingClientRect().right<=innerWidth)"));
      const brand = await headerBrandLayout();
      check(`desktop ${width} ${lang} header brand has room`, brand.issues, []);
      layouts.push({page:'main',width,height,language:lang,brand});
    }
  }
  await viewport(1440,900); await evaluate("HTSS_APP.setLanguage('ru');window.scrollTo({top:0,behavior:'instant'})");
  await evaluate("new Promise((resolve,reject)=>{let n=0;const timer=setInterval(()=>{const v=document.querySelector('#hero-video');if(!v.paused && v.readyState>=3 && v.classList.contains('is-playing')){clearInterval(timer);resolve(true)}else if(++n>100){clearInterval(timer);reject(Error('Background video did not start: '+JSON.stringify({src:v.currentSrc,paused:v.paused,readyState:v.readyState,error:v.error?.message,muted:v.muted,hidden:document.hidden,reducedMotion:matchMedia('(prefers-reduced-motion: reduce)').matches,connection:navigator.connection?.effectiveType,saveData:navigator.connection?.saveData,rect:v.getBoundingClientRect().toJSON()}))) }},50)})");
  check('playing video completely covers the still poster',await evaluate("getComputedStyle(document.querySelector('#hero-video')).opacity"),'1');
  check('video does not crossfade with a different still frame',await evaluate("getComputedStyle(document.querySelector('#hero-video')).transitionDuration"),'0s');
  check('background video advances rather than freezing',await evaluate("(async()=>{const v=document.querySelector('#hero-video');const start=v.currentTime;await new Promise(r=>setTimeout(r,200));return v.currentTime!==start && !v.paused})()"));
  await screenshot('desktop-1440.png');
  await evaluate("document.querySelector('#hero-video').pause()"); await pause(30);
  check('paused video restores the fallback poster',await evaluate("getComputedStyle(document.querySelector('#hero-video')).opacity==='0' && getComputedStyle(document.querySelector('.hero-background img')).visibility==='visible'"));
  await evaluate("document.querySelector('#hero-video').play()");
  await evaluate("document.querySelector('#about').scrollIntoView({behavior:'instant'})"); await screenshot('desktop-about.png');
  await evaluate("document.querySelector('#directions').scrollIntoView({behavior:'instant'})"); await screenshot('desktop-directions.png');
  await evaluate("document.querySelector('#contacts').scrollIntoView({behavior:'instant'})");
  check('main footer company logo loads', await loadedBrandImages('footer .brand-logo'), [true]);
  await screenshot('desktop-footer.png');
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  check('reduced motion stops video', await evaluate("document.querySelector('video').paused && getComputedStyle(document.documentElement).scrollBehavior==='auto'"));
  await navigate(`${base}/privacy.html`);
  check('privacy header company logo loads', await loadedBrandImages('.navbar .brand-logo'), [true]);
  for (const [width,height] of [[320,568],[390,844],[768,1024],[1440,900]]) {
    await viewport(width,height);
    for (const lang of ['ru','kk','en']) {
      await evaluate(`HTSS_APP.setLanguage('${lang}')`);
      check(width===1440 ? `privacy ${lang}` : `privacy ${width} ${lang}`, await evaluate("document.documentElement.scrollWidth<=innerWidth && document.title===HTSS_TRANSLATIONS[document.documentElement.lang].privacy_title"));
      const brand = await headerBrandLayout();
      check(`privacy ${width} ${lang} header brand has room`, brand.issues, []);
      layouts.push({page:'privacy',width,height,language:lang,brand});
      if(width===320 && lang==='ru') await screenshot('privacy-320.png');
    }
  }
  await cdp('Emulation.setScriptExecutionDisabled', { value: true }); await navigate(base);
  check('content readable without JavaScript', await evaluate("[...document.querySelectorAll('main section,h1,h2')].every(x=>getComputedStyle(x).visibility==='visible' && getComputedStyle(x).opacity!=='0')"));
  await cdp('Emulation.setScriptExecutionDisabled', { value: false });
  const badLanguage = await cdp('Page.addScriptToEvaluateOnNewDocument', { source: "localStorage.setItem('htss_lang','__proto__')" });
  await navigate(base);
  check('invalid saved language falls back safely', await evaluate('document.documentElement.lang'), 'ru');
  await cdp('Page.removeScriptToEvaluateOnNewDocument', { identifier: badLanguage.identifier });
  const noStorage = await cdp('Page.addScriptToEvaluateOnNewDocument', { source: "Object.defineProperty(window,'localStorage',{get(){throw new Error('Storage blocked for test')}})" });
  await navigate(base);
  check('blocked storage does not break page', await evaluate("Boolean(window.HTSS_APP) && document.documentElement.lang==='ru'"));
  await cdp('Page.removeScriptToEvaluateOnNewDocument', { identifier: noStorage.identifier });
  for (const delivery of ['email', 'unconfigured']) {
    const fallback = createServer({ root: path.join(root, 'dist'), env: delivery === 'email' ? {CONTACT_TO:'info@htss-co.kz'} : {} });
    await new Promise((resolve) => fallback.listen(0,'127.0.0.1',resolve));
    try {
      await navigate(`http://127.0.0.1:${fallback.address().port}`);
      check(`${delivery} config is honest`, await evaluate('HTSS_CONFIG.delivery'), delivery);
      check(`${delivery} button state`, await evaluate("document.querySelector('#contact-submit').disabled"), delivery === 'unconfigured');
      if (delivery === 'email') check('email mode asks to open a draft', await evaluate("document.querySelector('#contact-submit').textContent===HTSS_APP.t('modal_email_action') && document.querySelector('#contact-status').textContent===HTSS_APP.t('modal_email_hint')"));
      else check('unconfigured mode offers a phone call', await evaluate("document.querySelector('#contact-status').textContent===HTSS_APP.t('modal_unconfigured')"));
    } finally {
      await new Promise((resolve) => {fallback.close(resolve);fallback.closeAllConnections();});
    }
  }
  }
  // Mock the existing production provider. DNS for formsubmit.co is blocked in
  // this browser, so even an interception failure cannot send a real request.
  const provider = createServer({ root: path.join(root, 'dist'), env: { CONTACT_TO:'info@htss-co.kz', CONTACT_PROVIDER:'formsubmit' } });
  await new Promise((resolve) => provider.listen(0,'127.0.0.1',resolve));
  const providerRequests = [];
  let preflights = 0;
  let reply = { status: 200, data: { success: 'true' } };
  interceptRequest = async ({requestId,request}) => {
    const currentReply = reply;
    const preflight = request.method === 'OPTIONS';
    if (preflight) preflights++;
    if (!preflight) providerRequests.push({url:request.url,method:request.method,headers:request.headers,body:Object.fromEntries(new URLSearchParams(request.postData))});
    if (!preflight && currentReply.delayMs) await pause(currentReply.delayMs);
    if (!preflight && currentReply.networkError) {
      await cdp('Fetch.failRequest', { requestId, errorReason: 'ConnectionClosed' });
      return;
    }
    await cdp('Fetch.fulfillRequest', {
      requestId, responseCode:preflight ? 204 : currentReply.status,
      responseHeaders:[
        {name:'Access-Control-Allow-Origin',value:'*'},
        {name:'Access-Control-Allow-Methods',value:'POST, OPTIONS'},
        {name:'Access-Control-Allow-Headers',value:'Content-Type, Accept'},
        {name:'Access-Control-Max-Age',value:'0'},
        {name:'Content-Type',value:'application/json; charset=utf-8'},
      ],
      body:Buffer.from(preflight ? '' : currentReply.raw ?? JSON.stringify(currentReply.data)).toString('base64'),
    });
  };
  await cdp('Fetch.enable',{patterns:[{urlPattern:'https://formsubmit.co/*',requestStage:'Request'}]});
  try {
    await navigate(`http://127.0.0.1:${provider.address().port}`);
    check('production provider preserved',await evaluate('HTSS_CONFIG.delivery'),'formsubmit');
    await evaluate("HTSS_APP.setLanguage('ru');HTSS_APP.openContact(document.querySelector('[data-open-contact]'))");
    for (const item of [
      {name:'string false',status:200,data:{success:'false'}},
      {name:'boolean false',status:200,data:{success:false}},
      {name:'missing success',status:200,data:{}},
      {name:'SMTP response is not provider success',status:200,data:{ok:true}},
      {name:'truthy value is not provider success',status:200,data:{success:1}},
      {name:'HTTP error is not success',status:500,data:{success:true}},
      {name:'malformed JSON',status:200,raw:'<html>Upstream error</html>'},
      {name:'noncanonical success string',status:200,data:{success:'TRUE'}},
      {name:'activation required',status:200,data:{success:'false',message:'This form needs Activation. Check your email.'},statusKey:'modal_activation_required'},
      {name:'provider unavailable',status:503,data:{success:false},statusKey:'modal_unavailable'},
      {name:'rate limited',status:429,data:{success:false},statusKey:'modal_rate_limited'},
      {name:'network error',networkError:true},
      {name:'boolean true',status:200,data:{success:true},accepted:true},
      {name:'string true',status:200,data:{success:'true'},accepted:true},
      {name:'response slower than old 15 second timeout',status:200,data:{success:'true'},delayMs:16000,accepted:true},
    ]) {
      reply=item;
      await evaluate("(()=>{const f=document.querySelector('#contact-form');f.elements.name.value='Тест';f.elements.phone.value='+7 701 123 45 67';f.elements.sector.value='eng';f.elements.message.value='Provider mock only';f.elements.consent.checked=true;f.requestSubmit()})()");
      await evaluate("new Promise((resolve,reject)=>{let n=0;const timer=setInterval(()=>{if(!document.querySelector('#contact-submit').disabled){clearInterval(timer);resolve(true)}else if(++n>1000){clearInterval(timer);reject(Error('Mock delivery timed out'))}},20)})");
      check(`FormSubmit ${item.name}`,await evaluate("document.querySelector('#contact-status').dataset.state"),item.accepted?'success':'error');
      if (item.statusKey) check(`FormSubmit ${item.name} explains the cause`,await evaluate(`document.querySelector('#contact-status').textContent===HTSS_APP.t('${item.statusKey}')`));
      if (!item.accepted) check(`FormSubmit ${item.name} retains text`,await evaluate("document.querySelector('#contact-form').elements.message.value"),'Provider mock only');
    }
    check('provider acceptance wording',await evaluate("document.querySelector('#contact-status').textContent===HTSS_APP.t('modal_provider_success')"));
    check('all provider posts intercepted',providerRequests.length,15);
    check('provider does not require a CORS preflight',preflights,0);
    const payload=providerRequests[0].body;
    const contentType = Object.entries(providerRequests[0].headers).find(([name]) => name.toLowerCase() === 'content-type')?.[1];
    check('provider uses form encoding',contentType?.startsWith('application/x-www-form-urlencoded'));
    check('provider field names',Object.keys(payload).sort(),['Имя','Телефон','Направление','Сообщение','Язык','Согласие','_subject','_template','_honey'].sort());
    check('provider recipient preserved',decodeURIComponent(new URL(providerRequests[0].url).pathname),'/ajax/info@htss-co.kz');
    check('provider request describes consent',payload.Согласие,'Да');
    check('provider request preserves Cyrillic names and phone', {name:payload.Имя,phone:payload.Телефон}, {name:'Тест',phone:'+7 701 123 45 67'});
    check('provider does not disable captcha or invent source URL',!('_captcha' in payload) && !('_url' in payload));
  } finally {
    await cdp('Fetch.disable');
    interceptRequest=null;
    await new Promise((resolve)=>{provider.close(resolve);provider.closeAllConnections();});
  }
  check('no runtime or CSP errors', errors, []);
  await writeFile(path.join(artifacts,'layouts.json'),JSON.stringify(layouts,null,2));
  console.log(`${count} browser checks passed. Screenshots: .cache/browser/. No real emails sent.`);
} catch (error) {
  console.error('Browser verification failed:', error.message);
  throw error;
} finally {
  // Ask this isolated browser to exit before removing its profile. Killing the
  // parent first can leave Chromium children holding database files on Windows.
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({id:999999,method:'Browser.close'}));
  await new Promise((resolve)=>setTimeout(resolve,250));
  releaseMail?.();
  await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
  if (chrome.exitCode === null) await new Promise((resolve) => {
    const timer=setTimeout(resolve,2000);
    chrome.once('exit',()=>{clearTimeout(timer);resolve();});
  });
  if (chrome.exitCode === null) chrome.kill();
  socket?.close();
  const resolved = path.resolve(profile);
  if (path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('htss-browser-')) {
    await rm(resolved, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }).catch((error)=>{
      if (!['EBUSY','EPERM','ENOTEMPTY'].includes(error.code)) throw error;
      console.warn('The isolated temporary browser profile is still locked by Chromium; project files are unaffected.');
    });
  }
}
