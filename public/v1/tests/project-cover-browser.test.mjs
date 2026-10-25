import test from 'node:test';
import assert from 'node:assert/strict';
import {access} from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright-core';

test('project photo references and cover viewer actions share one selection',async()=>{
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
      window.writes=[];window.revision=3;window.writable=true;window.failWrite=false;
      window.Portal={cfg:{orgId:'org'},PhotoFeed:{mountProjectGallery:(_el,options)=>{window.gallery=options;}}};
      window.projectOrgId=()=> 'org';
      window.PlatformAPI={projectMedia:window.PlatformAPI.projectMedia,branchModules:{get:async()=>({data:{fields:[{entity:'project',key:'detail_photo',type:'photo',label:'Detail photo'}]}})},media:{list:async()=>({media:window.project.photos})},publication:{
        read:async()=>({status:'ready',value:{recordRevision:window.revision,fields:[{path:'cover_photo',writable:window.writable}]}}),
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
    const choose=async index=>page.evaluate(async index=>{const photo=window.project.photos[index];const action=window.gallery.viewerActions.find(a=>a.id==='set_project_cover');await action.onClick({photo,viewer:{refreshActions(){},refreshIndicators(){}}});},index);
    await choose(0);
    assert.equal(await page.locator('[data-fm-cf-input="cover_photo"]').inputValue(),'{"media_id":"a"}');
    assert.match(await page.locator('[data-custom-field-path="cover_photo"] .fm-cf-media-tile').textContent(),/Front\.jpg/);
    assert.deepEqual(await page.evaluate(()=>window.project.custom_fields.cover_photo),{media_id:'a'});
    assert.equal(await page.evaluate(()=>window.project.thumbnail_photo_id),'a');
    assert.equal(await page.evaluate(()=>window.gallery.viewerIndicators.find(i=>i.id==='project_cover').visible({photo:window.project.photos[0]})),true);
    await choose(1);
    assert.deepEqual(await page.evaluate(()=>window.project.custom_fields.cover_photo),{media_id:'b'});
    assert.equal(await page.evaluate(()=>window.gallery.viewerActions.find(a=>a.id==='set_project_cover').visible({photo:window.project.photos[2]})),false);
    await page.evaluate(()=>{window.failWrite=true;});
    await assert.rejects(()=>choose(0));
    assert.deepEqual(await page.evaluate(()=>window.project.custom_fields.cover_photo),{media_id:'b'});
    await page.evaluate(()=>{window.failWrite=false;window.writable=false;});
    await assert.rejects(()=>choose(0));
    await page.evaluate(async()=>{window.writable=true;await window.gallery.viewerActions.find(a=>a.id==='remove_project_cover').onClick({});});
    assert.equal(await page.locator('[data-fm-cf-input="cover_photo"]').inputValue(),'');
    assert.equal(await page.evaluate(()=>window.project.custom_fields.cover_photo),null);
    assert.equal(await page.evaluate(()=>window.project.thumbnail_photo_id),'top_down_thumbnail');
    assert.equal(await page.evaluate(()=>window.writes[0][1]),'custom-fields.project.write');
    await choose(0);
    await page.evaluate(()=>window.gallery.onProjectPhotosChanged([{...window.project.photos[0],in_trash:true},window.project.photos[1]]));
    assert.equal(await page.locator('[data-fm-cf-input="cover_photo"]').inputValue(),'');
    assert.equal(await page.evaluate(()=>window.project.custom_fields.cover_photo),null);
    // Photos has no cover card: the cover is an ordinary tile with a "Cover" pill, and every other image tile
    // offers "Set as cover". Videos never offer it.
    assert.equal(await page.evaluate(()=>window.gallery.introHtml),undefined,'no cover row above the gallery');
    assert.equal(await page.evaluate(()=>window.gallery.renderTileBadge({photo:window.project.photos[2]})),'');
    await page.evaluate(()=>{
      document.querySelector('#rPhotoFeedMount').innerHTML=window.project.photos.map(photo=>`<button class="pf-thumb">${window.gallery.renderTileBadge({photo})}</button>`).join('');
      window.writes=[];
    });
    assert.equal(await page.locator('[data-project-cover-card],[data-project-cover-reset]').count(),0);
    await page.locator('[data-project-cover-set="b"]').click();
    await page.waitForFunction(()=>window.project.custom_fields.cover_photo?.media_id==='b');
    assert.equal(await page.evaluate(()=>window.writes.at(-1)[3].values.cover_photo.media_id),'b');
    assert.equal(await page.locator('[data-project-cover-chip="b"].is-cover').count(),1);
    assert.equal(await page.locator('[data-project-cover-chip="b"].is-cover').textContent(),'Cover');
    assert.equal(await page.locator('[data-project-cover-set="a"]').count(),1);
    await page.evaluate(async()=>{await window.gallery.viewerActions.find(a=>a.id==='remove_project_cover').onClick({});});
    assert.equal(await page.evaluate(()=>window.project.custom_fields.cover_photo),null);
    assert.equal(await page.locator('.r-photo-cover-chip.is-cover').count(),0,'without a saved satellite photo no library tile is the cover');
    // The Overview's default cover tile tries its backup URLs when the first image fails to load.
    await page.evaluate(async()=>{
      document.body.insertAdjacentHTML('beforeend','<div id="fallbackFields"></div>');
      await window.FirstMateCustomFields.renderEditor(document.querySelector('#fallbackFields'),{...window.project,custom_field_values:{}},'project',{orgId:'org',flat:true,defaultMedia:{cover_photo:{src:'/missing-satellite.png',fallbacks:['/static-satellite.png'],label:'Top-down satellite'}}});
    });
    await page.waitForFunction(()=>document.querySelector('#fallbackFields [data-custom-field-path="cover_photo"] img')?.getAttribute('src')==='/static-satellite.png');
  }finally{await browser.close();}
});

test('the saved satellite photo is an ordinary tile with the Cover pill, and a cleared cover falls back to it',async()=>{
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
      window.ensureCalls=0;window.writes=[];window.revision=1;
      window.Portal={cfg:{orgId:'org'},PhotoFeed:{mountProjectGallery:(_el,options)=>{window.gallery=options;window.galleryPhotos=options.photos;}}};
      window.projectOrgId=()=> 'org';
      const projectMedia=window.PlatformAPI.projectMedia;
      // The server saves the photo and names it the cover (projects/satellite-media.ts).
      projectMedia.ensureSatelliteMedia=async(orgId,projectId)=>{window.ensureCalls++;return {status:'saved',media_id:'sat',cover_set:true,photos:[...window.project.photos,satellite],custom_field_values:{cover_photo:{media_id:'sat'}},satellite_media:{firstmeasure:{media_id:'sat'}}};};
      window.PlatformAPI={projectMedia,media:{list:async()=>({media:[]})},publication:{
        read:async()=>({status:'ready',value:{recordRevision:window.revision,fields:[{path:'cover_photo',writable:true}]}}),
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
    assert.equal(await page.evaluate(()=>window.gallery.introHtml),undefined,'no cover row');
    await page.waitForFunction(()=>(window.galleryPhotos||[]).some(photo=>photo.media_id==='sat'));
    await page.evaluate(()=>{document.querySelector('#rPhotoFeedMount').innerHTML=window.project.photos.map(photo=>`<button class="pf-thumb" data-tile="${photo.id}">${window.gallery.renderTileBadge({photo})}</button>`).join('');});
    assert.equal(await page.locator('[data-tile="sat"] .r-photo-cover-chip.is-cover').textContent(),'Cover');
    assert.equal(await page.locator('[data-tile="a"] [data-project-cover-set="a"]').count(),1);
    const visible=(id,photoId)=>page.evaluate(([id,photoId])=>window.gallery.viewerActions.find(a=>a.id===id).visible({photo:window.project.photos.find(photo=>(photo.media_id||photo.id)===photoId)}),[id,photoId]);
    assert.equal(await visible('set_project_cover','sat'),false);
    assert.equal(await visible('remove_project_cover','sat'),false,'the satellite photo has nothing to fall back from');
    assert.equal(await visible('set_project_cover','a'),true);
    assert.equal(await page.evaluate(()=>window.gallery.viewerActions.some(a=>/satellite/i.test(a.label))),false,'no "Use satellite image"');
    // Choose another cover, then clear it: the saved satellite photo is the cover again.
    await page.locator('[data-project-cover-set="a"]').click();
    await page.waitForFunction(()=>window.project.custom_fields.cover_photo?.media_id==='a');
    assert.equal(await page.locator('[data-project-cover-chip="a"].is-cover').count(),1);
    assert.equal(await visible('remove_project_cover','a'),true);
    await page.evaluate(async()=>{await window.gallery.viewerActions.find(a=>a.id==='remove_project_cover').onClick({});});
    assert.equal(await page.evaluate(()=>window.project.custom_fields.cover_photo),null);
    assert.equal(await page.locator('[data-project-cover-chip="sat"].is-cover').count(),1,'a cleared cover falls back to the saved satellite photo');
    assert.equal(await page.evaluate(()=>window.PlatformAPI.projectMedia.primaryPhoto(window.project,{orgId:'org'}).media_id),'sat','the tile and Overview show it');
    assert.equal(await page.evaluate(()=>window.gallery.viewerIndicators.find(i=>i.id==='project_cover').visible({photo:window.satellite})),true);
    // Opening Photos again does not ask again.
    await page.evaluate(()=>window.Portal.ProjectPhotosTab.setActive(true,{}));
    await page.waitForTimeout(50);
    assert.equal(await page.evaluate(()=>window.ensureCalls),1);
  }finally{await browser.close();}
});
