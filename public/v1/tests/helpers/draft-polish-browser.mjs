import assert from 'node:assert/strict';

export async function installPolishFixture(page){
  await page.evaluate(()=>{
    window.polishCalls=[];window.polishSignals=[];window.polishResolvers=[];
    window.fixturePolish=async(input,options)=>{
      polishCalls.push(input);polishSignals.push(options.signal);
      if(window.waitPolish)await new Promise(resolve=>polishResolvers.push(resolve));
      if(window.failPolish)throw Error('Polish failed');
      return {text:input.text.replaceAll('helo','Hello')};
    };
    ChannelsAPI.compose={polish:async(org,channel,input,options)=>fixturePolish({...input,org,channel},options)};
    if(ChannelsAPI.feed)ChannelsAPI.feed.polish=async(org,input,options)=>fixturePolish({...input,org},options);
  });
}

export async function verifyPolishComposer(page,editor,form,{screenshot}={}){
  const button=form.locator('[data-polish-draft]');await button.waitFor();
  assert.equal(await button.evaluate(n=>n.previousElementSibling?.matches('[data-mention-button]')),true,'polish is beside tagging');
  await editor.evaluate(n=>{n.value='**helo** from this draft.';n.dispatchEvent(new Event('input',{bubbles:true}));});
  await page.evaluate(()=>window.waitPolish=true);await button.click();
  assert.equal(await button.isEnabled(),true);assert.equal(await button.getAttribute('aria-label'),'Click to cancel');
  assert.equal(await editor.evaluate(n=>n.inert && n.contentEditable==='false'),true);
  assert.equal(await editor.evaluate(n=>getComputedStyle(n).animationName),'fm-ch-polish-shimmer');
  assert.equal(await form.locator('[type=submit]').isDisabled(),true);
  const r=await editor.boundingBox();await page.mouse.click(r.x+8,r.y+8);await page.keyboard.type('No edits');await editor.dispatchEvent('paste');
  await form.evaluate(n=>n.requestSubmit());assert.equal(await editor.evaluate(n=>n.value),'**helo** from this draft.');
  await page.mouse.move(5,5);await page.waitForTimeout(320);await page.getByRole('tooltip',{name:'Click to cancel'}).waitFor();
  if(screenshot)await form.screenshot({path:screenshot});
  await button.click();assert.equal(await page.evaluate(()=>polishSignals.at(-1).aborted),true);
  assert.equal(await editor.getAttribute('contenteditable'),'true');assert.equal(await page.locator('.fm-ch-polish-cancel-tip').count(),0);
  await editor.evaluate(n=>{n.value='helo newer draft';n.dispatchEvent(new Event('input',{bubbles:true}));});await button.click();
  await page.evaluate(()=>polishResolvers.shift()());await page.waitForTimeout(50);assert.equal(await button.getAttribute('aria-busy'),'true','late response cannot unlock the newer request');
  await page.evaluate(()=>{window.waitPolish=false;polishResolvers.shift()();});await page.waitForFunction(n=>n.value==='Hello newer draft',await editor.elementHandle());
  await editor.press('Control+z');assert.equal(await editor.evaluate(n=>n.value),'helo newer draft');
  await page.evaluate(()=>window.failPolish=true);await button.click();await page.waitForFunction(n=>!n.hasAttribute('aria-busy'),await button.elementHandle());
  assert.equal(await editor.evaluate(n=>n.value),'helo newer draft');assert.equal(await editor.evaluate(n=>n.inert),false);
  await page.evaluate(()=>window.failPolish=false);await editor.evaluate(n=>{n.value='';n.dispatchEvent(new Event('input',{bubbles:true}));});
  await form.locator('[data-mention-button]').click();await page.locator('[data-mention-user]').first().click();
  await editor.evaluate(n=>n.insertText('helo'));
  const mentions=await editor.evaluate(n=>n._mentionApi.confirmedMentions());
  await button.click();await page.waitForFunction(n=>n.value.includes('Hello'),await editor.elementHandle());
  assert.deepEqual(await editor.evaluate(n=>n._mentionApi.confirmedMentions().map(u=>u.id)),mentions.map(u=>u.id));
  assert.deepEqual(await page.evaluate(()=>polishCalls.at(-1).mention_names),mentions.map(u=>u.name));
  assert.equal(await editor.evaluate(n=>[...CSS.highlights.get('fm-channel-mentions')].some(range=>n.contains(range.startContainer))),true);
  await editor.evaluate(n=>{n.value='';n.dispatchEvent(new Event('input',{bubbles:true}));});
}
