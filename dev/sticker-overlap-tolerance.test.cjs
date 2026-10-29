// A paste refused with "overlaps another feature" over a blank wall: the overlap
// test subtracted a window 3.7 m away and read the clip's rounding on the arch's
// curve samples (3e-7 m²) as an overlap. Shapes captured from the editor.
const test=require('node:test'),assert=require('node:assert/strict');
const F=require('../public/measure/internal/editor_scripts/wall_features.js');
const pasted=[[3.1327367162439566,-2.402807362722811],[3.1327367162439566,-1.2598073627228246],[3.0565367162439565,-1.2318276752228314],[2.980336716243956,-1.2074198627228299],[2.9422367162439556,-1.1976716205353313],[2.904136716243957,-1.1901558002228256],[2.866036716243956,-1.1853188861603314],[2.8279367162439564,-1.1836073627228245],[2.7898367162439555,-1.1853188861603314],[2.751736716243956,-1.1901558002228256],[2.7136367162439554,-1.1976716205353313],[2.6755367162439563,-1.2074198627228299],[2.5993367162439562,-1.2318276752228314],[2.5231367162439557,-1.2598073627228246],[2.5231367162439557,-2.402807362722811]].map(([x,y])=>({x,y,z:0}));
const shift=(ps,dx,dy)=>ps.map(p=>({x:p.x+dx,y:p.y+dy,z:0})),outline=[[{x:-1,y:-3,z:0},{x:9,y:-3,z:0},{x:9,y:1,z:0},{x:-1,y:1,z:0}]];
test('an arched sticker far from another is never refused as an overlap',()=>{
 const window={points:shift(pasted,3.6653263492973744,.2793999999999243)};
 assert.doesNotThrow(()=>F.validate(pasted,outline,[window]));
 for(let i=0;i<40;i++)assert.doesNotThrow(()=>F.validate(shift(pasted,i*.0137,i*.0011),outline,[window]),'position '+i);
});
test('a real overlap and a shared edge are still told apart',()=>{
 assert.throws(()=>F.validate(pasted,outline,[{points:shift(pasted,.05,0)}]),/overlaps another feature/);
 assert.doesNotThrow(()=>F.validate(pasted,outline,[{points:shift(pasted,.6100000000000009,0)}]),'touching side by side');
});
