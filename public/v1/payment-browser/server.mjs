// Private, development-only Chromium worker. The platform API authenticates every
// request; neither provider credentials nor browser control URLs reach the model.
import http from 'node:http';
import net from 'node:net';
import { lookup } from 'node:dns/promises';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

export function publicAddress(address) {
  if (net.isIP(address) !== 4) return false; // Resolve/connect public IPv4 only.
  const [a,b] = address.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && [0,168].includes(b)) ||
    (a === 198 && [18,19,51].includes(b)) || (a === 203 && b === 0));
}

export function signupUrl(raw) {
  const u = new URL(raw);
  if (u.protocol !== 'https:' || u.username || u.password || u.port ||
      !u.hostname.endsWith('.getfwd.com') || !u.hostname.includes('sandbox')) {
    throw new Error('Only Forward sandbox application links are supported.');
  }
  return u.href;
}

// Resolve once, check the resulting address, then connect to that literal IP.
// This protects the host/VPC/metadata service even after a provider redirect.
async function egressProxy() {
  const proxy = http.createServer((_req,res) => { res.writeHead(403); res.end(); });
  proxy.on('connect', async (req,socket,head) => {
    try {
      const u = new URL('https://' + req.url);
      if (u.port && u.port !== '443') throw new Error('port');
      const addresses = await lookup(u.hostname, { family:4, all:true });
      if (!addresses.length || addresses.some(a => !publicAddress(a.address))) throw new Error('private');
      const upstream = net.connect(443, addresses[0].address);
      upstream.setTimeout(60000, () => upstream.destroy());
      socket.on('error', () => upstream.destroy());
      upstream.on('error', () => socket.destroy());
      upstream.on('connect', () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        upstream.pipe(socket); socket.pipe(upstream);
      });
    } catch { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); }
  });
  await new Promise(resolve => proxy.listen(0,'127.0.0.1',resolve));
  return proxy;
}

export async function createBrowserService({ token, executablePath, host='127.0.0.1', port=3218, maxSessions=6 } = {}) {
  if (!token || token.length < 32) throw new Error('A private service token is required.');
  const sessions = new Map();
  const proxy = await egressProxy();
  const now = () => Date.now();
  async function close(s) {
    if (s.closing) return s.closing;
    s.closed=true;
    if (sessions.get(s.owner)===s) sessions.delete(s.owner);
    s.closing=(async()=>{
      await s.context?.close().catch(() => {});
      if (s.dir) await rm(s.dir,{recursive:true,force:true,maxRetries:10,retryDelay:200});
    })();
    return s.closing;
  }
  function view(s) {
    return { ok:true, session_id:s.id, state:s.ready ? 'ready' : 'starting',
      width:s.frameWidth||s.width, height:s.frameHeight||s.height, complete:s.complete === true,
      upload_requested:Boolean(s.chooser), dialog:s.dialog ? s.dialog.type() : null };
  }
  async function attach(s,page) {
    if (s.closed) return;
    if (s.attached?.has(page)) { s.page=page; s.cdp=s.attached.get(page); return; }
    s.page=page;
    const cdp = await s.context.newCDPSession(page);
    (s.attached ||= new Map()).set(page,cdp);
    s.cdp=cdp;
    page.on('filechooser', chooser => { s.chooser=chooser; });
    page.on('dialog', dialog => { s.dialog=dialog; });
    page.on('framenavigated', frame => {
      if (frame !== page.mainFrame()) return;
      try { const u=new URL(frame.url()); if (u.hostname==='dev.1m8.ai' && u.pathname==='/portal/payments-setup-complete.html') s.complete=true; } catch {}
    });
    cdp.on('Page.screencastFrame', event => {
      if (s.page===page) { s.frame=event.data; s.frameWidth=event.metadata.deviceWidth; s.frameHeight=event.metadata.deviceHeight; s.sequence=(s.sequence||0)+1; }
      void cdp.send('Page.screencastFrameAck',{sessionId:event.sessionId}).catch(()=>{});
    });
    await cdp.send('Page.startScreencast',{format:'jpeg',quality:80,maxWidth:s.width,maxHeight:s.height,everyNthFrame:1});
    page.on('close', () => {
      if (s.page !== page) return;
      const previous=s.context.pages().filter(p=>!p.isClosed()).at(-1);
      if (previous) void attach(s,previous).catch(()=>{});
      else void close(s);
    });
  }
  async function start(s,url) {
    const destination=signupUrl(url);
    s.dir=await mkdtemp(path.join(tmpdir(),'fm-payments-'));
    s.context=await chromium.launchPersistentContext(s.dir,{
      executablePath, channel:executablePath ? undefined : 'chromium', headless:true,
      viewport:{width:s.width,height:s.height}, acceptDownloads:false,
      env:{PATH:process.env.PATH,HOME:s.dir,LANG:'en_US.UTF-8'},
      proxy:{server:`http://127.0.0.1:${proxy.address().port}`},
      args:['--disable-dev-shm-usage','--disable-quic','--proxy-bypass-list=<-loopback>',
        '--force-webrtc-ip-handling-policy=disable_non_proxied_udp']
    });
    if(s.closed) { await s.context.close(); await rm(s.dir,{recursive:true,force:true,maxRetries:10,retryDelay:200}); throw new Error('Session closed'); }
    s.context.on('close',()=>{ if(!s.closed) void close(s); });
    s.context.on('page', page => { void attach(s,page).catch(()=>{}); });
    const page=s.context.pages()[0] || await s.context.newPage();
    await attach(s,page);
    await page.goto(destination,{waitUntil:'domcontentloaded',timeout:45000});
    // An initial frame is available even when the page never animates.
    s.frame=(await page.screenshot({type:'jpeg',quality:80})).toString('base64');
    s.sequence=(s.sequence||0)+1;
    s.ready=true;
  }
  async function input(s,event) {
    const page=s.page;
    if (!page || s.complete) return;
    const x=Math.max(0,Math.min(s.width-1,Number(event.x)||0));
    const y=Math.max(0,Math.min(s.height-1,Number(event.y)||0));
    if (event.type==='pointer') {
      const type=event.action;
      if (!['mousePressed','mouseReleased','mouseMoved'].includes(type)) throw new Error('input');
      await s.cdp.send('Input.dispatchMouseEvent',{type,x,y,button:event.button==='right'?'right':type==='mouseMoved'?'none':'left',clickCount:type==='mouseMoved'?0:Math.min(2,Number(event.clickCount)||1),buttons:Number(event.buttons)||0});
    } else if(event.type==='wheel') {
      await s.cdp.send('Input.dispatchMouseEvent',{type:'mouseWheel',x,y,deltaX:Math.max(-2000,Math.min(2000,Number(event.deltaX)||0)),deltaY:Math.max(-2000,Math.min(2000,Number(event.deltaY)||0))});
    } else if(event.type==='text') {
      if (typeof event.text!=='string'||event.text.length>10000) throw new Error('input');
      await page.keyboard.insertText(event.text);
    } else if(event.type==='key') {
      const key=String(event.key||'');
      if (!/^(?:(?:Control|Meta|Alt|Shift)\+)*(?:[a-zA-Z0-9]|Enter|Tab|Backspace|Delete|Escape|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown|Space)$/.test(key)) throw new Error('input');
      await page.keyboard.press(key);
    } else if(event.type==='resize') {
      s.width=Math.max(420,Math.min(1440,Math.round(Number(event.width)||800)));
      s.height=Math.max(400,Math.min(1200,Math.round(Number(event.height)||780)));
      await page.setViewportSize({width:s.width,height:s.height});
      await s.cdp.send('Page.stopScreencast');
      await s.cdp.send('Page.startScreencast',{format:'jpeg',quality:80,maxWidth:s.width,maxHeight:s.height});
    } else if(event.type==='upload') {
      if (!s.chooser || typeof event.data!=='string' || event.data.length>14000000) throw new Error('upload');
      const chooser=s.chooser;s.chooser=null;
      await chooser.setFiles({name:path.basename(String(event.name||'document')),mimeType:String(event.mime||'application/octet-stream'),buffer:Buffer.from(event.data,'base64')});
    } else if(event.type==='dialog') {
      const dialog=s.dialog;s.dialog=null;
      if (dialog) await (event.accept ? dialog.accept(String(event.text||'')) : dialog.dismiss());
    } else if(event.type==='back') await page.goBack({waitUntil:'domcontentloaded',timeout:15000});
    else if(event.type==='reload') await page.reload({waitUntil:'domcontentloaded',timeout:30000});
    else throw new Error('input');
  }
  const server=http.createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');
    res.setHeader('Content-Type','application/json');
    const send=(code,data)=>{res.writeHead(code);res.end(JSON.stringify(data));};
    try {
      const auth=Buffer.from(String(req.headers.authorization||''));const expected=Buffer.from('Bearer '+token);
      if (auth.length!==expected.length||!timingSafeEqual(auth,expected)) return send(401,{ok:false});
      if (req.method==='GET'&&req.url==='/health') return send(200,{ok:true,sessions:sessions.size});
      if (req.method!=='POST') return send(405,{ok:false});
      let chunks=[],length=0;
      for await(const chunk of req){length+=chunk.length;if(length>15000000){send(413,{ok:false});req.destroy();return;}chunks.push(chunk);}
      const body=JSON.parse(Buffer.concat(chunks).toString());
      if (!/^[a-f0-9]{64}$/.test(body.owner||'')) return send(400,{ok:false});
      let s=sessions.get(body.owner);
      if(req.url==='/reserve') {
        if(s) return send(200,{...view(s),claimed:false});
        const tenant=body.tenant||body.owner;
        if([...sessions.values()].some(existing=>existing.tenant===tenant)) return send(409,{ok:false,message:'Another user in your organization has payment setup open. Ask them to close it before starting your session.'});
        if(sessions.size>=maxSessions) return send(429,{ok:false,message:'All signup browsers are busy. Try again shortly.'});
        s={owner:body.owner,tenant,id:randomUUID(),created:now(),touched:now(),width:900,height:780,queue:Promise.resolve()};
        sessions.set(body.owner,s);return send(200,{...view(s),claimed:true});
      }
      if(!s||body.session_id!==s.id) return send(410,{ok:false,message:'This signup browser has expired. Reopen payment setup to continue.'});
      s.touched=now();
      if(req.url==='/close'){await close(s);return send(200,{ok:true});}
      if(req.url==='/start') {
        if(s.context||s.starting) return send(409,{ok:false});
        s.starting=true;
        try {await start(s,body.url);} catch {await close(s);return send(502,{ok:false,message:'The signup browser could not load. Please try again.'});}
        return send(200,view(s));
      }
      if(req.url==='/frame') return send(200,{...view(s),sequence:s.sequence||0,frame:Number(body.after)===(s.sequence||0)?null:s.frame||null});
      if(req.url==='/input') {
        const work=s.queue.then(()=>input(s,body.event));s.queue=work.catch(()=>{});
        await work;return send(200,view(s));
      }
      send(404,{ok:false});
    }catch {send(400,{ok:false,message:'The browser request could not be completed.'});}
  });
  const cleanup=setInterval(()=>{for(const s of sessions.values()) if(now()-s.touched>(s.context?30*60000:90000)||now()-s.created>2*3600000) void close(s);},30000);cleanup.unref();
  await new Promise(resolve=>server.listen(port,host,resolve));
  return {server,sessions,async close(){clearInterval(cleanup);await Promise.all([...sessions.values()].map(close));server.close();proxy.close();}};
}

if (process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  if(process.env.FIRSTMEASURE_DATA_ENVIRONMENT!=='development') throw new Error('Development only.');
  const service=await createBrowserService({token:process.env.PAYMENTS_BROWSER_TOKEN,executablePath:process.env.PAYMENTS_CHROMIUM_EXECUTABLE,host:process.env.PAYMENTS_BROWSER_BIND||'127.0.0.1',port:Number(process.env.PAYMENTS_BROWSER_PORT||3218)});
  console.log('Payments browser ready');
  for(const signal of ['SIGTERM','SIGINT']) process.on(signal,()=>void service.close().then(()=>process.exit(0)));
}
