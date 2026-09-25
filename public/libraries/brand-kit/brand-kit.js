/* Shared Company Information and Doc Studio Brand Kit controls. */
(function(root){
  'use strict';
  const DEFAULT_FONTS = ['Montserrat','Inter','Roboto','Open Sans','Lato','Poppins','Source Sans 3','Arial'];
  const SCRIPT_URL = document.currentScript?.src || '';
  const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const hex = (value, fallback = '#FFFFFF') => /^#[0-9a-f]{6}$/i.test(String(value || '')) ? String(value).toUpperCase() : fallback;
  const displayValue = (value) => ({
    background_color: hex(value?.background_color || value?.backgroundColor, '#FFFFFF'),
    shape: value?.shape === 'circle' ? 'circle' : 'square',
    rounded_corners: value?.rounded_corners !== false && value?.roundedCorners !== false
  });
  function ensureStyles(){
    if (document.getElementById('fm-brand-kit-css')) return;
    const link = document.createElement('link');
    link.id = 'fm-brand-kit-css'; link.rel = 'stylesheet';
    const url = new URL('brand-kit.css', SCRIPT_URL || window.location.href);
    if (SCRIPT_URL.includes('?')) url.search = SCRIPT_URL.slice(SCRIPT_URL.indexOf('?'));
    link.href = url.toString(); document.head.appendChild(link);
  }
  function markup(options = {}){
    ensureStyles();
    const prefix = /^[a-z][a-z0-9]*$/i.test(options.prefix || '') ? options.prefix : 'brand';
    const id = (name) => `${prefix}${name}`;
    const extendedPalette = options.extendedPalette !== false;
    const advancedLogos = options.advancedLogos === true;
    const fonts = Array.from(new Set([...(options.fonts || []), ...DEFAULT_FONTS])).filter(Boolean);
    return `<div class="fm-brand-kit" data-brandkit-root="${prefix}">
      <div class="company-brand-row">
        <section class="company-settings-card">
          <div class="company-settings-card-head"><strong>Color palette</strong><i class="fas fa-circle-info company-settings-card-help" title="Primary and secondary style the interface. Supporting colors are available in visual editors." aria-label="About the company color palette"></i></div>
          <div class="company-settings-card-body">
            <div class="brand-color-main">
              <div class="brand-color-control"><input type="color" class="cs-color" id="${id('Primary')}"><div class="brand-color-copy"><label for="${id('PrimaryHex')}">Primary · UI</label><span class="cs-chip" id="${id('PrimaryChip')}"><span class="hash">#</span><input id="${id('PrimaryHex')}" maxlength="6" autocomplete="off" spellcheck="false"></span></div></div>
              <div class="brand-color-control"><input type="color" class="cs-color" id="${id('Secondary')}"><div class="brand-color-copy"><label for="${id('SecondaryHex')}">Secondary · UI</label><span class="cs-chip" id="${id('SecondaryChip')}"><span class="hash">#</span><input id="${id('SecondaryHex')}" maxlength="6" autocomplete="off" spellcheck="false"></span></div></div>
            </div>
            ${extendedPalette ? `<div class="brand-palette-strip" id="${id('PaletteStrip')}" aria-label="Six-color company palette"></div><div class="palette-inline-footer"><button type="button" class="palette-regenerate" id="${id('GeneratePalette')}"><i class="fas fa-rotate"></i> Regenerate palette from logo</button></div>` : ''}
          </div>
        </section>
        <section class="company-settings-card">
          <div class="company-settings-card-head"><strong>Logo</strong><i class="fas fa-circle-info company-settings-card-help" title="Manage the company logo and its appearance on branded surfaces." aria-label="About company logos"></i></div>
          <div class="company-settings-card-body">
            <div class="logo-editor"><div class="logo-stage" id="${id('LogoStage')}"><img id="${id('LogoPreviewImg')}" data-company-logo-preview alt="Current company logo"></div><div class="logo-main-controls"><strong>Current logo</strong><div class="cs-note">Transparent PNG or SVG works best.</div><div class="cs-file"><label class="cs-btn ghost" for="${id('LogoFile')}"><i class="fas fa-upload"></i> Replace logo</label><input type="file" id="${id('LogoFile')}" accept="image/*"></div></div></div>
            ${advancedLogos ? `<div class="alternate-logos"><div class="alternate-logos-head"><span class="alternate-logos-title">Alternate logos <i class="fas fa-circle-info company-settings-card-help" title="Reusable logo variations for proposals, web pages, and other branded media."></i></span><label class="alternate-logo-add" for="${id('AlternateLogoFiles')}"><i class="fas fa-plus"></i> Add<input type="file" id="${id('AlternateLogoFiles')}" accept="image/*" multiple></label></div><div class="alternate-logo-list" id="${id('AlternateLogoList')}"><span class="alternate-logo-empty">No alternate logos yet.</span></div></div>
              <details class="company-advanced" id="${id('LogoAdvanced')}"><summary>Advanced logo appearance</summary><div class="company-advanced-body"><div class="logo-advanced-grid"><label class="cs-field"><span>Background</span><div class="logo-background"><input type="color" id="${id('LogoBackground')}"><input type="text" id="${id('LogoBackgroundHex')}" maxlength="7" spellcheck="false" autocomplete="off"></div></label><div class="cs-field"><span>Container shape</span><div class="logo-options"><label class="logo-choice"><input type="radio" name="${id('LogoShape')}" value="square"><span><i class="far fa-square"></i> Square</span></label><label class="logo-choice"><input type="radio" name="${id('LogoShape')}" value="circle"><span><i class="far fa-circle"></i> Circle</span></label><button type="button" class="logo-corners" id="${id('LogoCorners')}" aria-pressed="true"><i class="fas fa-border-all"></i> Rounded corners</button></div></div></div></div></details>` : ''}
          </div>
        </section>
      </div>
      <section class="company-settings-card company-font-card"><div class="company-settings-card-head"><strong>Company font</strong><span>Default for new documents and templates</span></div><div class="company-settings-card-body"><label class="cs-field"><span>Font family</span><select id="${id('BrandFont')}">${fonts.map((font) => `<option value="${escape(font)}">${escape(font)}</option>`).join('')}</select></label></div></section>
    </div>`;
  }
  function paletteTextColor(color){
    const value = hex(color, '#000000').slice(1);
    const r = parseInt(value.slice(0,2),16), g = parseInt(value.slice(2,4),16), b = parseInt(value.slice(4,6),16);
    return (r*299 + g*587 + b*114)/1000 > 160 ? '#172033' : '#FFFFFF';
  }
  function renderPalette(container, prefix, palette){
    const strip = container.querySelector(`#${prefix}PaletteStrip`);
    if (!strip) return;
    strip.innerHTML = (palette || []).slice(0,6).map((color,index) => `<label class="brand-palette-swatch ${index < 2 ? 'blessed' : ''}" style="--swatch:${escape(color)};--swatch-text:${paletteTextColor(color)}" title="${index === 0 ? 'Primary' : index === 1 ? 'Secondary' : `Support ${index-1}`}: ${escape(color)}"><input type="color" data-palette-direct="${index}" value="${escape(color)}" aria-label="Edit ${index === 0 ? 'primary' : index === 1 ? 'secondary' : `support ${index-1}`} color"><span>${escape(color)}</span></label>`).join('');
  }
  function renderLogoAppearance(container, prefix, value){
    const display = displayValue(value);
    const stage = container.querySelector(`#${prefix}LogoStage`);
    if (stage) { stage.style.setProperty('--logo-bg',display.background_color); stage.style.setProperty('--logo-radius',display.rounded_corners ? '14px' : '0px'); stage.classList.toggle('circle',display.shape === 'circle'); }
    const background = container.querySelector(`#${prefix}LogoBackground`);
    const backgroundHex = container.querySelector(`#${prefix}LogoBackgroundHex`);
    if (background) background.value = display.background_color;
    if (backgroundHex) backgroundHex.value = display.background_color;
    container.querySelectorAll(`input[name="${prefix}LogoShape"]`).forEach((input) => { input.checked = input.value === display.shape; });
    const corners = container.querySelector(`#${prefix}LogoCorners`);
    if (corners) { corners.disabled = display.shape === 'circle'; corners.classList.toggle('active',display.rounded_corners && display.shape !== 'circle'); corners.setAttribute('aria-pressed',String(display.rounded_corners)); corners.innerHTML = `<i class="fas fa-border-all"></i> ${display.rounded_corners ? 'Rounded corners' : 'Square corners'}`; }
  }
  function fill(container, prefix, value){
    const root = container.querySelector(`[data-brandkit-root="${prefix}"]`) || container;
    const palette = Array.isArray(value.palette) ? value.palette : [];
    for (const [name,index] of [['Primary',0],['Secondary',1]]) {
      const color = hex(palette[index] || value[name.toLowerCase()],index ? '#202124' : '#D93025');
      const picker = root.querySelector(`#${prefix}${name}`), text = root.querySelector(`#${prefix}${name}Hex`);
      if (picker) picker.value = color;
      if (text) text.value = color.slice(1);
    }
    renderPalette(root,prefix,palette);
    const font = root.querySelector(`#${prefix}BrandFont`);
    if (font) { if (value.font && !Array.from(font.options).some((option) => option.value === value.font)) font.add(new Option(value.font,value.font)); font.value = value.font || 'Montserrat'; }
    const img = root.querySelector(`#${prefix}LogoPreviewImg`);
    if (img) { if (value.logo) { img.src = value.logo; img.style.display = ''; } else { img.removeAttribute('src'); img.style.display = 'none'; } }
    renderLogoAppearance(root,prefix,value.logo_display);
  }
  function bind(container, options){
    const prefix = options.prefix;
    const root = container.querySelector(`[data-brandkit-root="${prefix}"]`) || container;
    const model = options.value;
    const emit = () => options.onChange?.({ palette:[...model.palette], font:model.font, logo_display:{...displayValue(model.logo_display)} });
    const update = (index,color) => { model.palette[index] = hex(color,model.palette[index]); model.primary=model.palette[0]; model.secondary=model.palette[1]; fill(root,prefix,model); emit(); };
    fill(root,prefix,model);
    for (const [name,index] of [['Primary',0],['Secondary',1]]) {
      root.querySelector(`#${prefix}${name}`)?.addEventListener('input',(event)=>update(index,event.target.value));
      root.querySelector(`#${prefix}${name}Hex`)?.addEventListener('change',(event)=>update(index,`#${event.target.value.replace(/[^0-9a-f]/gi,'').slice(0,6)}`));
    }
    root.querySelector(`#${prefix}PaletteStrip`)?.addEventListener('change',(event)=>{ const input=event.target.closest('[data-palette-direct]'); if(input) update(Number(input.dataset.paletteDirect),input.value); });
    root.querySelector(`#${prefix}BrandFont`)?.addEventListener('change',(event)=>{ model.font=event.target.value; emit(); });
    const background = root.querySelector(`#${prefix}LogoBackground`);
    const backgroundHex = root.querySelector(`#${prefix}LogoBackgroundHex`);
    background?.addEventListener('input',()=>{ model.logo_display={...displayValue(model.logo_display),background_color:background.value}; renderLogoAppearance(root,prefix,model.logo_display); emit(); });
    backgroundHex?.addEventListener('change',()=>{ model.logo_display={...displayValue(model.logo_display),background_color:hex(backgroundHex.value, '#FFFFFF')}; renderLogoAppearance(root,prefix,model.logo_display); emit(); });
    root.querySelectorAll(`input[name="${prefix}LogoShape"]`).forEach((input)=>input.addEventListener('change',()=>{ if(!input.checked)return; model.logo_display={...displayValue(model.logo_display),shape:input.value}; renderLogoAppearance(root,prefix,model.logo_display); emit(); }));
    root.querySelector(`#${prefix}LogoCorners`)?.addEventListener('click',()=>{ model.logo_display={...displayValue(model.logo_display),rounded_corners:!displayValue(model.logo_display).rounded_corners}; renderLogoAppearance(root,prefix,model.logo_display); emit(); });
    root.querySelector(`#${prefix}LogoFile`)?.addEventListener('change',async(event)=>{ const file=event.target.files?.[0]; if(file) await options.onLogoUpload?.(file); event.target.value=''; });
    root.querySelector(`#${prefix}GeneratePalette`)?.addEventListener('click',async()=>{
      try {
        const colors=await options.onGeneratePalette?.(model.logo);
        if(Array.isArray(colors) && colors.length){
          const chosen=new Set(model.palette.slice(0,2).map((color)=>color.toUpperCase()));
          const supporting=colors.map((color)=>hex(color)).filter((color)=>!chosen.has(color)).slice(0,4);
          supporting.forEach((color,index)=>{model.palette[index+2]=color;}); fill(root,prefix,model); emit();
        }
      } catch (error) { options.onError?.(error); }
    });
    root.querySelector(`#${prefix}AlternateLogoFiles`)?.addEventListener('change',async(event)=>{ const files=Array.from(event.target.files || []); if(files.length) await options.onAlternateUpload?.(files); event.target.value=''; });
    return { refresh:() => fill(root,prefix,model) };
  }
  function renderAlternates(container, prefix, items){
    const list = container.querySelector(`#${prefix}AlternateLogoList`);
    if (!list) return;
    const logos = (items || []).filter((item) => {
      const purpose = String(item?.metadata?.purpose || item?.metadata?.branding_purpose || '').toLowerCase();
      const slot = String(item?.owner?.slot || item?.slot || '').toLowerCase();
      return purpose === 'alternate_logo' || slot === 'alternate_logo';
    }).map((item,index) => root.PlatformAPI?.brandingMedia?.imageRef?.(root.Portal?.cfg?.userOrgId || root.__APP?.orgId, item, { label:item?.metadata?.label || item?.file_name || `Alternate logo ${index+1}` }) || {
      src:item?.src || item?.url || '', thumb:item?.thumb || item?.src || item?.url || '', label:item?.metadata?.label || item?.file_name || `Alternate logo ${index+1}`
    });
    list.innerHTML = logos.length ? logos.map((logo) => `<div class="alternate-logo-item" title="${escape(logo.label || 'Alternate logo')}"><img src="${escape(logo.thumb || logo.src)}" alt="${escape(logo.label || 'Alternate logo')}"></div>`).join('') : '<span class="alternate-logo-empty">No alternate logos yet.</span>';
  }
  async function extractPalette(source){
    if (!source) throw new Error('Upload a logo first.');
    const image = new Image(); image.crossOrigin = 'anonymous';
    await new Promise((resolve,reject) => { image.onload=resolve; image.onerror=()=>reject(new Error('Could not read colors from this logo.')); image.src=source; });
    const scale = Math.min(1,180/Math.max(image.naturalWidth || 1,image.naturalHeight || 1));
    const width=Math.max(1,Math.round((image.naturalWidth || 1)*scale)), height=Math.max(1,Math.round((image.naturalHeight || 1)*scale));
    const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
    const context=canvas.getContext('2d',{willReadFrequently:true});
    if (!context) throw new Error('Color extraction is unavailable in this browser.');
    context.drawImage(image,0,0,width,height);
    const pixels=context.getImageData(0,0,width,height).data;
    const buckets=new Map();
    for(let i=0;i<pixels.length;i+=4){
      if(pixels[i+3]<120)continue;
      const r=pixels[i],g=pixels[i+1],b=pixels[i+2],high=Math.max(r,g,b),low=Math.min(r,g,b);
      if((r>244&&g>244&&b>244)||(high>226&&high&&(high-low)/high<.16))continue;
      const entry={r:Math.min(255,Math.round(r/20)*20),g:Math.min(255,Math.round(g/20)*20),b:Math.min(255,Math.round(b/20)*20)};
      const key=`${entry.r},${entry.g},${entry.b}`;
      const current=buckets.get(key)||{...entry,count:0};current.count+=1;buckets.set(key,current);
    }
    const ranked=Array.from(buckets.values()).sort((a,b)=>b.count-a.count),distinct=[];
    for(const entry of ranked){ if(distinct.length>=6)break; if(distinct.every((chosen)=>Math.sqrt((entry.r-chosen.r)**2+(entry.g-chosen.g)**2+(entry.b-chosen.b)**2)>=42))distinct.push(entry); }
    return distinct.map(({r,g,b})=>`#${[r,g,b].map((value)=>value.toString(16).padStart(2,'0')).join('')}`.toUpperCase());
  }
  root.PlatformBrandKit = { markup, fill, bind, renderPalette, renderLogoAppearance, renderAlternates, extractPalette, displayValue, fonts:DEFAULT_FONTS };
})(window);
