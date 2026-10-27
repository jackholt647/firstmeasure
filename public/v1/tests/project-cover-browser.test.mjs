import test from 'node:test';
import assert from 'node:assert/strict';
import {access} from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright-core';

test('photo fields are pinned photos: the field editor, viewer actions and pinned row share one value',async()=>{
  let executablePath;
  for(const file of ['C:/Program Files/Google/Chrome/Application/chrome.exe','/usr/bin/chromium',chromium.executablePath()]){try{await access(file);executablePath=file;break;}catch{}}
  const browser=await chromium.launch({executablePath,headless:true});
  try{
    const page=await browser.newPage();
    await page.route('http://localhost/**',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html><body></body></html>'}));
    await page.goto('http://localhost/');
    await page.setContent('<div id="fields"></div><div id="rPhotoGallery"></div>');
    await page.addScriptTag({path:path.resolve('../libraries/platform-api/platform-api.js')});
    await page.evaluate(()=>{
      window.project={id:'project',measurement_project_id:'roof',custom_field_values:{},photos:[{id:'a',content_type:'image/jpeg',file_name:'Front.jpg'},{id:'b',content_type:'image/png',file_name:'Back.png'},{id:'video',content_type:'video/mp4'}]};
      window.writes=[];window.toasts=[];window.revision=3;window.writable=true;window.failWrite=false;window.serverValues={};
      window.Portal={cfg:{orgId:'org'},ui:{showToast:(...args)=>window.toasts.push(args)},PhotoFeed:{mountProjectGallery:(_el,options)=>{window.gallery=options;}}};
      window.projectOrgId=()=> 'org';
      window.PlatformAPI={projectMedia:window.PlatformAPI.projectMedia,branchModules:{get:async()=>({data:{fields:[{entity:'project',key:'detail_photo',type:'photo',label:'Detail photo'}]}})},media:{list:async()=>({media:window.project.photos})},publication:{
        read:async(_org,source)=>source.export==='values'?{status:'ready',value:window.serverValues}:({status:'ready',value:{recordRevision:window.revision,fields:[{path:'cover_photo',writable:window.writable},{path:'detail_photo',writable:window.writable}]}}),
        invoke:async(...args)=>{if(window.failWrite)throw Error('revision_conflict');window.writes.push(args);return {value:{revision:++window.revision},receipt:{status:'succeeded'}};}
      }};
    });
    await page.addScriptTag({path:path.resolve('../libraries/custom-fields/firstmate-custom-fields.js')});
    await page.addScriptTag({path:path.resolve('../libraries/apps/photos/project.js')});
    await page.evaluate(async()=>{
      await window.FirstMateCustomFields.renderEditor(document.querySelector('#fields'),window.project,'project',{orgId:'org',flat:true,defaultMedia:{cover_photo:{src:'/satellite.jpg',label:'Top-down satellite'}}});
      window.Portal.ProjectPhotosTab.mount({panelRoot:document.querySelector('#rPhotoGallery'),host:{getProject:()=>window.project,getPhotos:()=>window.project.photos}});
      window.Portal.ProjectPhotosTab.render();
    });
    // Photo fields are thumbnail tiles; the choices are the project's images only.
    const choices=key=>page.evaluate(key=>JSON.parse(document.querySelector(`[data-fm-cf-input="${key}"]`).closest('[data-fm-cf-media]').dataset.choices).map(choice=>choice.media_id),key);
    assert.deepEqual(await choices('cover_photo'),['a','b']);
    assert.deepEqual(await choices('detail_photo'),['a','b']);
    assert.equal(await page.locator('#fields select').count(),0);
    // With nothing chosen, the cover shows the project's default photo as its value: no placeholder, no remove.
    const coverTile=page.locator('[data-custom-field-path="cover_photo"] .fm-cf-media-tile');
    assert.equal(await coverTile.count(),1);
    assert.equal(await coverTile.locator('img').getAttribute('src'),'/satellite.jpg');
    assert.equal(await coverTile.locator('i,[data-fm-cf-media-remove]').count(),0);
    assert.doesNotMatch(await page.locator('[data-custom-field-path="cover_photo"]').textContent(),/satellite image|default|Choose a photo/i);
    // Its picker offers the default photo first, selected; choosing it keeps the cover empty.
    await page.evaluate(()=>{window.Portal.PhotoFeed.openProjectMediaPicker=options=>{window.coverPicker=options;return {close(){}};};});
    await coverTile.locator('[data-fm-cf-media-open]').click();
    assert.deepEqual(await page.evaluate(()=>[window.coverPicker.photos.map(photo=>photo.id),window.coverPicker.selectedIds,window.coverPicker.subtitle]),[['__default__','a','b'],['__default__'],'Choose from this project\u2019s media.']);
    await page.evaluate(()=>window.coverPicker.onConfirm([window.coverPicker.photos[0]]));
    assert.equal(await page.locator('[data-fm-cf-input="cover_photo"]').inputValue(),'');
    // A click opens the project media picker; confirming sets the value and reports a change.
    await page.evaluate(()=>{window.changes=0;document.querySelector('#fields').addEventListener('change',()=>window.changes++);window.Portal.PhotoFeed.openProjectMediaPicker=options=>{window.pickerOptions=options;return {close(){}};};});
    await page.locator('[data-custom-field-path="detail_photo"] [data-fm-cf-media-open]').click();
    assert.deepEqual(await page.evaluate(()=>[window.pickerOptions.multiple,window.pickerOptions.imageOnly,window.pickerOptions.photos.map(photo=>photo.media_id)]),[false,true,['a','b']]);
    assert.equal(await page.evaluate(()=>window.pickerOptions.onConfirm([{media_id:'',id:'local'}])),false,'an upload without a library id keeps the picker open');
    await page.evaluate(()=>window.pickerOptions.onConfirm([{...window.pickerOptions.photos[1]}]));
    assert.equal(await page.locator('[data-fm-cf-input="detail_photo"]').inputValue(),'{"media_id":"b"}');
    assert.equal(await page.evaluate(()=>window.changes),1);
    assert.match(await page.locator('[data-custom-field-path="detail_photo"] .fm-cf-media-tile').textContent(),/Back\.png/);
    assert.deepEqual(await page.evaluate(()=>window.FirstMateCustomFields.editorValues(document.querySelector('#fields'),window.project,'project').detail_photo),{media_id:'b'});
    await page.locator('[data-custom-field-path="detail_photo"] [data-fm-cf-media-remove]').click();
    assert.equal(await page.locator('[data-fm-cf-input="detail_photo"]').inputValue(),'');
    assert.equal(await page.evaluate(()=>window.changes),2);
    // Photos: every photo field is a pinned photo, the cover included. One generic action pair per field in the
    // viewer; nothing names the cover.
    const run=async(id,index)=>page.evaluate(async([id,index])=>{const photo=window.project.photos[index];await window.gallery.viewerActions.find(a=>a.id===id).onClick({photo,viewer:{refreshActions(){},refreshIndicators(){}}});},[id,index]);
    const visible=(id,index)=>page.evaluate(([id,index])=>window.gallery.viewerActions.find(a=>a.id===id).visible({photo:window.project.photos[index]}),[id,index]);
    assert.deepEqual(await page.evaluate(()=>window.gallery.viewerActions.filter(a=>a.pinField).map(a=>[a.id,a.label])),[
      ['pin_field:cover_photo','Pin as Cover photo'],['unpin_field:cover_photo','Unpin from Cover photo'],
      ['pin_field:detail_photo','Pin as Detail photo'],['unpin_field:detail_photo','Unpin from Detail photo']
    ]);
    assert.equal(await page.evaluate(()=>window.gallery.viewerActions.some(a=>/cover/i.test(a.id)&&!a.pinField)),false,'no cover-only action');
    await run('pin_field:cover_photo',0);
    assert.equal(await page.locator('[data-fm-cf-input="cover_photo"]').inputValue(),'{"media_id":"a"}','a mounted field editor follows');
    assert.deepEqual(await page.evaluate(()=>window.project.custom_fields.cover_photo),{media_id:'a'});
    assert.equal(await page.evaluate(()=>window.project.thumbnail_photo_id),'a','project tiles read the same value');
    assert.deepEqual(await page.evaluate(()=>window.writes.at(-1).slice(1,3)),['custom-fields.project.write',{scope:'project',organizationId:'org',projectId:'project'}]);
    assert.equal(await visible('pin_field:cover_photo',0),false);
    assert.equal(await visible('unpin_field:cover_photo',0),true);
    assert.equal(await visible('pin_field:cover_photo',2),false,'a video is never pinned to a photo field');
    await run('pin_field:detail_photo',0);
    const indicator=()=>page.evaluate(()=>{const i=window.gallery.viewerIndicators.find(i=>i.id==='pinned_fields');const photo=window.project.photos[0];return i.visible({photo})?i.label({photo}):'';});
    assert.equal(await indicator(),'Cover photo, Detail photo');
    await run('pin_field:cover_photo',1);
    assert.deepEqual(await page.evaluate(()=>window.project.custom_fields.cover_photo),{media_id:'b'});
    assert.equal(await indicator(),'Detail photo');
    // A refused write changes nothing and says so.
    await page.evaluate(()=>{window.failWrite=true;});
    await run('pin_field:cover_photo',0);
    assert.deepEqual(await page.evaluate(()=>window.project.custom_fields.cover_photo),{media_id:'b'});
    await page.evaluate(()=>{window.failWrite=false;window.writable=false;});
    await run('pin_field:cover_photo',0);
    assert.deepEqual(await page.evaluate(()=>window.project.custom_fields.cover_photo),{media_id:'b'},'the field\'s write permission applies');
    assert.match(await page.evaluate(()=>window.toasts.at(-1).join(' ')),/not changed/i);
    await page.evaluate(()=>{window.writable=true;});
    await run('unpin_field:cover_photo',1);
    assert.equal(await page.locator('[data-fm-cf-input="cover_photo"]').inputValue(),'');
    assert.equal(await page.evaluate(()=>window.project.custom_fields.cover_photo),null);
    assert.equal(await page.evaluate(()=>window.project.thumbnail_photo_id),'top_down_thumbnail');
    // A trashed pinned photo: the server decides what each field keeps (it clears the cover, keeps other references).
    await run('pin_field:cover_photo',0);
    await page.evaluate(()=>{window.serverValues={cover_photo:null,detail_photo:{media_id:'a'}};window.gallery.onProjectPhotosChanged([{...window.project.photos[0],in_trash:true},window.project.photos[1],window.project.photos[2]]);});
    await page.waitForFunction(()=>window.project.custom_fields.cover_photo===null);
    assert.equal(await page.locator('[data-fm-cf-input="cover_photo"]').inputValue(),'');
    assert.deepEqual(await page.evaluate(()=>window.project.custom_fields.detail_photo),{media_id:'a'});
    await page.evaluate(()=>{window.project.photos=window.project.photos.map(photo=>({...photo,in_trash:false}));});
    await run('unpin_field:detail_photo',0);

    // The pinned row sits above the gallery groups: one tile per photo field, labelled with the field's name.
    await page.evaluate(()=>{
      document.querySelector('#rPhotoFeedMount').innerHTML=window.gallery.introHtml()+window.project.photos.map(photo=>`<button class="pf-thumb" data-photo-feed-id="project::${photo.id}">${window.gallery.renderTileBadge({photo})}</button>`).join('');
      window.writes=[];
    });
    assert.deepEqual(await page.locator('[data-pinned-field] .r-pinned-label').allTextContents(),['Cover photo','Detail photo']);
    assert.equal(await page.locator('[data-project-cover-set],.r-photo-cover-chip').count(),0,'no "Set as cover" chip');
    const coverPin=page.locator('[data-pinned-field="cover_photo"]');
    assert.equal((await coverPin.locator('[data-pinned-choose]').textContent()).trim(),'Choose photo');
    assert.equal(await coverPin.locator('[data-pinned-menu]').count(),0,'an empty field has nothing to change or remove');
    // Choose photo picks from the project's images (or uploads) and saves through the field's writer.
    await page.evaluate(()=>{window.Portal.PhotoFeed.openProjectMediaPicker=options=>{window.pinPicker=options;return {close(){}};};});
    await coverPin.locator('[data-pinned-choose]').click();
    assert.deepEqual(await page.evaluate(()=>[window.pinPicker.title,window.pinPicker.multiple,window.pinPicker.imageOnly,window.pinPicker.photos.map(photo=>photo.id),typeof window.pinPicker.onUpload]),['Cover photo',false,true,['a','b'],'function']);
    assert.equal(await page.evaluate(()=>window.pinPicker.onConfirm([{id:'local_1',uploading:true,content_type:'image/png'}])),false,'an upload without a library id keeps the picker open');
    await page.evaluate(()=>window.pinPicker.onConfirm([window.pinPicker.photos[1]]));
    await page.waitForFunction(()=>window.project.custom_fields.cover_photo?.media_id==='b');
    assert.deepEqual(await page.evaluate(()=>window.writes.at(-1)[3].values),{cover_photo:{media_id:'b'}});
    assert.equal(await coverPin.locator('[data-pinned-open]').count(),1,'a filled field shows its photo');
    assert.equal(await page.locator('[data-pinned-chip="b"]').textContent(),'Cover photo');
    assert.equal(await page.locator('[data-pinned-chip="a"]').isHidden(),true);
    assert.equal(await page.evaluate(()=>window.gallery.renderTileBadge({photo:window.project.photos[2]})),'');
    // Clicking a filled tile opens its photo in the gallery's viewer.
    await page.evaluate(()=>{window.opened=[];document.querySelectorAll('[data-photo-feed-id]').forEach(tile=>tile.addEventListener('click',()=>window.opened.push(tile.dataset.photoFeedId)));});
    await coverPin.locator('[data-pinned-open]').click();
    assert.deepEqual(await page.evaluate(()=>window.opened),['project::b']);
    // Change or remove from the tile's menu.
    await coverPin.locator('[data-pinned-menu]').click();
    assert.deepEqual(await page.locator('.r-pinned-menu button').allTextContents(),['Change photo','Remove']);
    assert.equal(await page.locator('.r-pinned-menu select').count(),0);
    await page.locator('.r-pinned-menu [data-pinned-menu-remove]').click();
    await page.waitForFunction(()=>window.project.custom_fields.cover_photo===null);
    assert.equal(await page.locator('.r-pinned-menu').count(),0);
    assert.equal(await coverPin.locator('[data-pinned-choose]').count(),1);
    assert.equal(await page.locator('[data-pinned-chip="b"]').isHidden(),true);
    // The Overview's default cover tile tries its backup URLs when the first image fails to load.
    await page.evaluate(async()=>{
      document.body.insertAdjacentHTML('beforeend','<div id="fallbackFields"></div>');
      await window.FirstMateCustomFields.renderEditor(document.querySelector('#fallbackFields'),{...window.project,custom_field_values:{}},'project',{orgId:'org',flat:true,defaultMedia:{cover_photo:{src:'/missing-satellite.png',fallbacks:['/static-satellite.png'],label:'Top-down satellite'}}});
    });
    await page.waitForFunction(()=>document.querySelector('#fallbackFields [data-custom-field-path="cover_photo"] img')?.getAttribute('src')==='/static-satellite.png');
  }finally{await browser.close();}
});

test('the saved satellite photo pinned as the cover is an ordinary photo field value',async()=>{
  let executablePath;
  for(const file of ['C:/Program Files/Google/Chrome/Application/chrome.exe','/usr/bin/chromium',chromium.executablePath()]){try{await access(file);executablePath=file;break;}catch{}}
  const browser=await chromium.launch({executablePath,headless:true});
  try{
    const page=await browser.newPage();
    await page.route('http://localhost/**',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html><body></body></html>'}));
    await page.goto('http://localhost/');
    await page.setContent('<style>.pf-thumb{position:relative;display:inline-block;width:160px;height:120px;margin:4px}</style><div id="rPhotoGallery"></div>');
    await page.addScriptTag({path:path.resolve('../libraries/platform-api/platform-api.js')});
    await page.evaluate(()=>{
      const satellite={id:'sat',media_id:'sat',kind:'media_reference',content_type:'image/jpeg',label:'Top-down satellite',source:'satellite_top_down',metadata:{source:'satellite_top_down',satellite_source:'firstmeasure'}};
      window.satellite=satellite;
      window.project={id:'project',measurement_project_id:'roof',custom_field_values:{},photos:[{id:'a',media_id:'a',content_type:'image/jpeg',file_name:'Front.jpg'}]};
      window.ensureCalls=0;window.writes=[];window.revision=1;window.contractReads=0;
      window.Portal={cfg:{orgId:'org'},PhotoFeed:{mountProjectGallery:(_el,options)=>{window.gallery=options;window.galleryPhotos=options.photos;}}};
      window.projectOrgId=()=> 'org';
      const projectMedia=window.PlatformAPI.projectMedia;
      // The server saves the photo and names it the cover (projects/satellite-media.ts).
      projectMedia.ensureSatelliteMedia=async(orgId,projectId)=>{window.ensureCalls++;return {status:'saved',media_id:'sat',cover_set:true,photos:[...window.project.photos,satellite],custom_field_values:{cover_photo:{media_id:'sat'}},satellite_media:{firstmeasure:{media_id:'sat'}}};};
      // The server's contract names the project's photo fields; a field it leaves out is not shown.
      window.PlatformAPI={projectMedia,media:{list:async()=>({media:[]})},publication:{
        read:async()=>{window.contractReads++;return {status:'ready',value:{recordRevision:window.revision,fields:[
          {path:'cover_photo',type:'photo',label:'Cover photo',cardinality:'one',enabled:true,writable:true},
          {path:'site_photos',type:'photo',label:'Site photos',cardinality:'many',enabled:true,writable:true},
          {path:'hidden_photo',type:'photo',label:'Hidden',background_only:true,writable:true},
          {path:'notes',type:'text',label:'Notes',writable:true}
        ]}};},
        invoke:async(...args)=>{window.writes.push(args);return {value:{revision:++window.revision},receipt:{status:'succeeded'}};}
      }};
    });
    await page.addScriptTag({path:path.resolve('../libraries/apps/photos/project.js')});
    await page.evaluate(()=>{
      const host={getProject:()=>window.project,getPhotos:()=>window.project.photos,setPhotos:photos=>{window.project.photos=photos;}};
      window.Portal.ProjectPhotosTab.mount({panelRoot:document.querySelector('#rPhotoGallery'),host});
      window.Portal.ProjectPhotosTab.setActive(true,{panelRoot:document.querySelector('#rPhotoGallery'),host});
    });
    await page.waitForFunction(()=>window.project.photos.some(photo=>photo.media_id==='sat'));
    assert.equal(await page.evaluate(()=>window.ensureCalls),1,'a saved project without the photo asks the server once');
    assert.deepEqual(await page.evaluate(()=>window.project.photos.map(photo=>photo.media_id||photo.id)),['a','sat'],'the satellite photo is in the library like any other');
    assert.equal(await page.evaluate(()=>window.project.photos.some(photo=>photo.id==='top_down_thumbnail')),false,'no generated stand-in beside it');
    assert.deepEqual(await page.evaluate(()=>window.project.custom_fields.cover_photo),{media_id:'sat'});
    await page.waitForFunction(()=>(window.galleryPhotos||[]).some(photo=>photo.media_id==='sat') && window.gallery.viewerActions.some(a=>a.id==='pin_field:site_photos'));
    const paint=()=>page.evaluate(()=>{document.querySelector('#rPhotoFeedMount').innerHTML=window.gallery.introHtml()+window.project.photos.map(photo=>`<button class="pf-thumb" data-photo-feed-id="project::${photo.id}">${window.gallery.renderTileBadge({photo})}</button>`).join('');});
    await paint();
    // Only the contract's enabled, shown photo fields are pinned.
    assert.deepEqual(await page.locator('[data-pinned-field] .r-pinned-label').allTextContents(),['Cover photo','Site photos']);
    assert.equal(await page.locator('[data-pinned-field="cover_photo"] [data-pinned-open]').count(),1);
    assert.equal(await page.locator('[data-pinned-chip="sat"]').textContent(),'Cover photo');
    const visible=(id,photoId)=>page.evaluate(([id,photoId])=>window.gallery.viewerActions.find(a=>a.id===id).visible({photo:window.project.photos.find(photo=>(photo.media_id||photo.id)===photoId)}),[id,photoId]);
    assert.equal(await visible('pin_field:cover_photo','sat'),false);
    assert.equal(await visible('unpin_field:cover_photo','sat'),true,'the cover is unpinned like any field');
    assert.equal(await visible('pin_field:cover_photo','a'),true);
    assert.equal(await page.evaluate(()=>window.gallery.viewerActions.some(a=>/satellite/i.test(a.label))),false,'no "Use satellite image"');
    // A field that holds several photos adds to its list and shows how many.
    const run=(id,photoId)=>page.evaluate(async([id,photoId])=>{await window.gallery.viewerActions.find(a=>a.id===id).onClick({photo:window.project.photos.find(photo=>(photo.media_id||photo.id)===photoId),viewer:null});},[id,photoId]);
    await run('pin_field:site_photos','a');
    await run('pin_field:site_photos','sat');
    assert.deepEqual(await page.evaluate(()=>window.project.custom_fields.site_photos),[{media_id:'a'},{media_id:'sat'}]);
    assert.equal(await page.locator('[data-pinned-field="site_photos"] .r-pinned-count').textContent(),'2');
    assert.equal(await page.locator('[data-pinned-chip="sat"]').textContent(),'Cover photo +1');
    await run('unpin_field:site_photos','a');
    assert.deepEqual(await page.evaluate(()=>window.project.custom_fields.site_photos),[{media_id:'sat'}]);
    // Unpinning the cover stores no cover; other places still show the saved satellite photo as before.
    await run('unpin_field:cover_photo','sat');
    assert.equal(await page.evaluate(()=>window.project.custom_fields.cover_photo),null);
    assert.equal(await page.locator('[data-pinned-field="cover_photo"] [data-pinned-choose]').count(),1);
    assert.equal(await page.evaluate(()=>window.PlatformAPI.projectMedia.primaryPhoto(window.project,{orgId:'org'}).media_id),'sat','project tiles and Overview still fall back to it');
    // Opening Photos again does not ask for the satellite photo again; it reads the fields again.
    const reads=await page.evaluate(()=>window.contractReads);
    await page.evaluate(()=>window.Portal.ProjectPhotosTab.setActive(true,{}));
    await page.waitForTimeout(50);
    assert.equal(await page.evaluate(()=>window.ensureCalls),1);
    assert.equal(await page.evaluate(()=>window.contractReads),reads+1);
  }finally{await browser.close();}
});
