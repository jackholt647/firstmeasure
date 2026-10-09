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
    await page.evaluate(()=>{
      window.project={id:'project',custom_field_values:{},photos:[{id:'a',content_type:'image/jpeg',file_name:'Front.jpg'},{id:'b',content_type:'image/png',file_name:'Back.png'},{id:'video',content_type:'video/mp4'}]};
      window.writes=[];window.revision=3;window.writable=true;window.failWrite=false;
      window.Portal={cfg:{orgId:'org'},PhotoFeed:{mountProjectGallery:(_el,options)=>{window.gallery=options;}}};
      window.projectOrgId=()=> 'org';
      window.PlatformAPI={branchModules:{get:async()=>({data:{fields:[{entity:'project',key:'detail_photo',type:'photo',label:'Detail photo'}]}})},media:{list:async()=>({media:window.project.photos})},publication:{
        read:async()=>({status:'ready',value:{recordRevision:window.revision,fields:[{path:'cover_photo',writable:window.writable}]}}),
        invoke:async(...args)=>{if(window.failWrite)throw Error('revision_conflict');window.writes.push(args);return {value:{revision:++window.revision},receipt:{status:'succeeded'}};}
      }};
    });
    await page.addScriptTag({path:path.resolve('../libraries/custom-fields/firstmate-custom-fields.js')});
    await page.addScriptTag({path:path.resolve('../libraries/apps/photos/project.js')});
    await page.evaluate(async()=>{
      await window.FirstMateCustomFields.renderEditor(document.querySelector('#fields'),window.project,'project',{orgId:'org',flat:true});
      window.Portal.ProjectPhotosTab.mount({panelRoot:document.querySelector('#rPhotoGallery'),host:{getProject:()=>window.project,getPhotos:()=>window.project.photos}});
      window.Portal.ProjectPhotosTab.render();
    });
    assert.equal(await page.locator('[data-fm-cf-input="cover_photo"] option').count(),3);
    assert.equal(await page.locator('[data-fm-cf-input="detail_photo"] option').count(),3);
    const choose=async index=>page.evaluate(async index=>{const photo=window.project.photos[index];const action=window.gallery.viewerActions.find(a=>a.id==='set_project_cover');await action.onClick({photo,viewer:{refreshActions(){},refreshIndicators(){}}});},index);
    await choose(0);
    assert.equal(await page.locator('[data-fm-cf-input="cover_photo"]').inputValue(),'{"media_id":"a"}');
    assert.deepEqual(await page.evaluate(()=>window.project.custom_fields.cover_photo),{media_id:'a'});
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
    assert.equal(await page.evaluate(()=>window.writes[0][1]),'custom-fields.project.write');
    await choose(0);
    await page.evaluate(()=>window.gallery.onProjectPhotosChanged([{...window.project.photos[0],in_trash:true},window.project.photos[1]]));
    assert.equal(await page.locator('[data-fm-cf-input="cover_photo"]').inputValue(),'');
    assert.equal(await page.evaluate(()=>window.project.custom_fields.cover_photo),null);
  }finally{await browser.close();}
});
