import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {chromium} from 'playwright-core';

const libraries=new URL('../../libraries/',import.meta.url);
const contacts=[
  {id:'jane',name:'Jane Test',phone:'+14259700671',project_id:'project-one'},
  {id:'avery',name:'Avery Demo',phone:'+12068590917',project_id:'project-two'},
  {id:'erik',name:'Erik Sample',phone:'+15099600721',project_id:'project-three'},
  {id:'duplicate',name:'Jane duplicate',phone:'425-970-0671'},
  ...Array.from({length:7},(_,i)=>({id:`extra-${i}`,name:`Extra ${i}`,phone:`+1202555010${i}`}))
];

for(const surface of ['tray','modal'])test(`${surface} supports true group MMS, images, recipients, history and safe retries`,async()=>{
  const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1360,height:900}}),errors=[],requests=[];
    const now='2026-10-09T20:00:00Z',group={id:'group-one',local_number:'+12065550199',participants:contacts.slice(0,3).map(c=>({address:c.phone,name:c.name,contact_id:c.id})),updated_at:now,last_message_at:now};
    let messages=[{id:'incoming-one',direction:'inbound',sender:contacts[1].phone,text:'Photo from Avery',created_at:now,attachments:[{url:'https://group.test/photo.png',content_type:'image/png'},{url:'javascript:alert(1)',content_type:'image/png'}]},
      {id:'sent-one',direction:'outbound',text:'Hello everyone',status:'captured',created_at:'2026-10-09T19:59:00Z',image_media_id:'image-one',deliveries:contacts.slice(0,3).map(c=>({recipient:c.phone,status:'captured'}))}];
    let failNext=false,creations=0,oldPages=0,groupPages=0;
    const image=await readFile(new URL('../../portal/media/sample_diagram_cropped.png',import.meta.url));
    await page.route('https://group.test/**',async route=>{
      const req=route.request(),url=new URL(req.url()),path=url.pathname;
      if(path.endsWith('.js')||path.endsWith('.css')){
        const relative=path.replace(/^\/libraries\//,'');
        try{return await route.fulfill({body:await readFile(new URL(relative,libraries),'utf8'),contentType:path.endsWith('.css')?'text/css':'text/javascript'});}catch{return route.fulfill({status:404,body:''});}
      }
      if(path==='/photo.png'||path.startsWith('/media/'))return route.fulfill({contentType:'image/png',body:image});
      if(!path.startsWith('/v1/'))return route.fulfill({contentType:'text/html',body:'<style>body{margin:0;font-family:Arial,sans-serif}.main{height:100vh;position:relative}button,input,textarea{font-family:inherit}</style><main class="main"><header id="platformTopbar" style="height:50px"></header><div id="mainPanels"></div></main>'});
      const body=req.postData()?JSON.parse(req.postData()):undefined;requests.push({path,method:req.method(),body,csrf:req.headers()['x-platform-csrf']});
      let result={ok:true};
      if(path.endsWith('/inbox'))result.conversations=url.searchParams.get('channel')==='call'?[]:[{id:'private-one',channel:'sms',contact_name:'Private Jane',contact_address:contacts[0].phone,updated_at:'2026-10-09T19:00:00Z',last_message:{text:'Private hello'}}];
      else if(path.endsWith('/voice/voicemails'))result.voicemails=[];
      else if(path.endsWith('/voice/contacts'))result.contacts=contacts.filter(c=>!url.searchParams.get('query')||c.name.toLowerCase().includes(url.searchParams.get('query').toLowerCase()));
      else if(path==='/v1/messaging/organizations/org-test/conversations'&&req.method()==='POST'){creations++;assert.equal(body.sms_mode,'group_mms');assert.equal(body.sender.address,'+12065550200');assert.equal(body.participants.length,3);group.participants=body.participants;group.local_number=body.sender.address;result.conversation=group;}
      else if(path.endsWith('/sms/groups')){if(url.searchParams.get('cursor')){groupPages++;result.items=[{...group,id:'group-two',subject:'Older group'}];}else{result.items=[group];result.nextCursor='groups-next';}}
      else if(path.endsWith('/sms/groups/group-one'))result.conversation=group;
      else if(path.endsWith('/sms/groups/group-one/messages')&&req.method()==='GET'){
        if(url.searchParams.get('cursor')){oldPages++;result.items=[{id:'older',direction:'inbound',sender:contacts[0].phone,text:'Older message',created_at:'2026-10-08T19:00:00Z'}];}
        else {result.items=messages;result.nextCursor='older-next';}
      }else if(path.endsWith('/sms/groups/group-one/messages')&&req.method()==='POST'){
        if(failNext){failNext=false;return route.fulfill({status:503,json:{ok:false,message:'Temporary connection error'}});}
        assert.ok(body.idempotency_key);assert.equal(body.business_number,undefined);assert.equal(body.recipients,undefined);assert.equal(body.image,undefined);
        messages=[{id:`new-${requests.length}`,direction:'outbound',sender:group.local_number,text:body.text,status:'captured',image_media_id:body.image_media_id,created_at:'2026-10-09T21:00:00Z'},...messages];
        result={ok:true,created:true,message_id:'new',conversation_id:group.id,status:'captured'};
      }else if(path.endsWith('/conversations/private-one'))result.conversation={id:'private-one',messages:[{id:'private-message',channel:'sms',direction:'inbound',text:'Private hello',created_at:now}]};
      else if(path.endsWith('/conversations/private-one/reply'))result={ok:true};
      return route.fulfill({json:result});
    });
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto('https://group.test');
    await page.evaluate(()=>{
      window.__APP={orgId:'org-test',userId:'user-test'};document.cookie='fm_platform_session_csrf=fixture-token; path=/';
      window.Portal={appFlags:{has:()=>true},modules:{},modals:{register:()=>({unregister(){}})}};
      Portal.CustomerPhone={status:{branch_id:'default',numbers:[{phone_number:'+12065550199',label:'Company main',status:'active'},{phone_number:'+12065550200',label:'Assigned line',status:'active'}],sms_numbers:[{phone_number:'+12065550199'},{phone_number:'+12065550200'}],default_number:'+12065550199'},state:{},open:async()=>true};
      window.PlatformAPI={media:{fileUrl:(_org,id)=>`https://group.test/media/${id}`,upload:async()=>{window.uploadCount=(window.uploadCount||0)+1;return {media:{id:'image-two'}};}}};
    });
    for(const file of ['window-manager/window-manager.js','window-manager/window-shell.js','comms-api/comms-api.js','apps/comms/communications-ui.js','channels-ui/channels-ui.js','apps/comms/phone-tray.js','apps/comms/phone-modal.js'])await page.addScriptTag({content:await readFile(new URL(file,libraries),'utf8')});
    await page.addStyleTag({content:await readFile(new URL('apps/comms/communications.css',libraries),'utf8')});
    await page.evaluate(()=>{const panel=document.createElement('div');panel.className='fmcp';document.body.append(panel);const win=Portal.PhoneTray.attach(panel,{panel:()=>panel,minimized(){},action(){}});win.setVisible(true);});
    if(surface==='modal')await page.evaluate(()=>Portal.PhoneModal.open('text'));else await page.evaluate(()=>Portal.PhoneTray.selectTab('text'));
    const root=page.locator(surface==='modal'?'.fmpm-window':'.fm-phone-tray');
    const chooseGroup=async()=>{if(surface==='tray')await root.locator('[data-thread]').filter({hasText:'Avery Demo'}).first().click();await root.locator('.fm-text-body').filter({hasText:'Photo from Avery'}).waitFor();};
    await chooseGroup();
    assert.match(await root.locator('.fm-text-group-line').textContent(),/Company main \(206-555-0199\)/);
    assert.equal(await root.locator('.fm-text-author').textContent(),'Avery Demo');
    assert.equal(await root.locator('img[src="https://group.test/photo.png"]').count(),1);
    assert.equal(await root.locator('img[src^="javascript:"]').count(),0);
    await root.locator('.fm-text-members summary').click();assert.match(await root.locator('.fm-text-members').textContent(),/Erik Sample/);
    await root.getByText('Delivery (3)',{exact:true}).click();assert.match(await root.locator('.fm-text-deliveries').textContent(),/Jane Test: Captured/);
    await root.getByRole('button',{name:'Load older messages'}).click();await root.getByText('Older message',{exact:true}).waitFor();assert.equal(oldPages,1);
    await root.getByRole('textbox',{name:'Text message'}).fill('Group reply');
    failNext=true;await root.getByRole('button',{name:'Send text'}).click();await root.getByRole('alert').filter({hasText:'Temporary connection error'}).waitFor();
    const failed=requests.filter(r=>r.method==='POST'&&r.path.endsWith('/group-one/messages')).at(-1);
    await root.getByRole('button',{name:'Send text'}).click();await root.locator('.fm-text-body').filter({hasText:'Group reply'}).waitFor();
    assert.equal(requests.filter(r=>r.method==='POST'&&r.path.endsWith('/group-one/messages')).at(-1).body.idempotency_key,failed.body.idempotency_key);
    if(surface==='tray')await root.getByRole('button',{name:'Back to conversations'}).click();
    await root.locator(surface==='tray'?'[data-thread]':'[data-thread=private-one]').filter({hasText:'Private Jane'}).click();
    await root.getByRole('textbox',{name:'Text message'}).fill('Private reply');await root.getByRole('button',{name:'Send text'}).click();
    await page.waitForFunction(()=>document.querySelector('.fm-text-body')?.textContent==='Private hello');
    assert.equal(requests.filter(r=>r.path.endsWith('/private-one/reply')).at(-1).body.text,'Private reply');
    if(surface==='tray')await root.getByRole('button',{name:'Back to conversations'}).click();
    await root.getByRole('button',{name:'Load more conversations'}).click();assert.equal(groupPages,1);
    await root.getByRole('button',{name:'New text',exact:true}).click();
    for(const name of ['Jane Test','Avery Demo','Erik Sample'])await root.locator('[data-text-contact]').filter({hasText:name}).click();
    await root.getByRole('searchbox',{name:'Find a contact to text'}).fill('Jane');
    await root.locator('[data-text-contact]').filter({hasText:'Jane duplicate'}).waitFor();assert.equal(await root.locator('[data-text-contact]').filter({hasText:'Jane duplicate'}).getAttribute('aria-pressed'),'true');
    assert.equal(await root.locator('[data-recipient-count]').textContent(),'3/8 selected');
    await root.getByRole('searchbox',{name:'Find a contact to text'}).fill('');
    await root.locator('[data-text-contact]').filter({hasText:'Extra 6'}).waitFor();
    for(let i=0;i<6;i++)await root.locator('[data-text-contact]').filter({hasText:`Extra ${i}`}).click();
    assert.match(await root.locator('[data-recipient-error]').textContent(),/up to 8/);
    for(let i=0;i<5;i++)await root.getByRole('button',{name:`Remove Extra ${i}`,exact:true}).click();
    await root.getByRole('button',{name:'Continue',exact:true}).click();
    await root.getByRole('textbox',{name:'Text message'}).waitFor();
    if(surface==='modal')await root.getByRole('combobox',{name:'Text using',exact:true}).selectOption('+12065550200');
    else{await root.locator('.fm-phone-line-toggle').click();await root.locator('[data-line-choice="+12065550200"]').click();}
    await root.locator('.fm-phone-compose input[type=file]').setInputFiles({name:'photo.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDVkAAAAASUVORK5CYII=','base64')});
    await root.locator('.fm-phone-image-preview:not([hidden])').waitFor();
    failNext=true;await root.getByRole('button',{name:'Send text'}).click();await root.getByRole('alert').filter({hasText:'Temporary connection error'}).waitFor();
    await root.getByRole('button',{name:'Send text'}).click();await root.locator('img[src="https://group.test/media/image-two"]').waitFor();
    assert.equal(creations,1);assert.equal(await page.evaluate(()=>uploadCount),1);
    assert.match(await root.locator('.fm-text-group-line').textContent(),/Assigned line \(206-555-0200\)/);
    const photoRequests=requests.filter(r=>r.body?.image_media_id==='image-two');assert.equal(photoRequests.length,2);assert.equal(photoRequests[0].body.idempotency_key,photoRequests[1].body.idempotency_key);assert.equal(photoRequests[1].body.text,'');
    assert.ok(requests.filter(r=>r.method==='POST').every(r=>r.csrf==='fixture-token'));
    await root.getByRole('button',{name:'Insert emoji',exact:true}).click();await page.getByRole('button',{name:'Insert 👍'}).click();assert.equal(await root.getByRole('textbox',{name:'Text message'}).inputValue(),'👍');
    if(process.env.PHONE_GROUP_SCREENSHOTS){await mkdir(process.env.PHONE_GROUP_SCREENSHOTS,{recursive:true});await page.screenshot({path:`${process.env.PHONE_GROUP_SCREENSHOTS}/${surface}-desktop.png`});}
    await page.setViewportSize({width:390,height:844});
    await page.waitForFunction(selector=>{const rect=document.querySelector(selector).getBoundingClientRect();return rect.x>=0&&rect.right<=391;},surface==='modal'?'.fmpm-window':'.fm-phone-tray');
    await root.locator('.fm-phone-compose').waitFor();
    const bounds=await root.boundingBox();assert.ok(bounds.x>=0&&bounds.x+bounds.width<=391,JSON.stringify(bounds));
    assert.equal(await root.locator('.fm-phone-compose').evaluate(el=>el.scrollWidth<=el.clientWidth+1),true);
    if(process.env.PHONE_GROUP_SCREENSHOTS)await page.screenshot({path:`${process.env.PHONE_GROUP_SCREENSHOTS}/${surface}-mobile.png`});
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
