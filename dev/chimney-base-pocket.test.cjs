const test=require('node:test'),assert=require('node:assert/strict'),{build}=require('./roof-generation-fixture.cjs');
const P='../public/measure/internal/editor_scripts/',B=require(P+'base_geometry'),C=require(P+'wall_chimneys'),G=require(P+'wall_geometry'),K=require(P+'exterior_geometry');
const fixture=require('./fixtures/chimney-three-foot-pocket.json');
test('captured three-foot inset joins the chimney base without the enclosed sliver',()=>{
 const original=JSON.stringify(fixture),r=build(fixture,36),c=r.state.chimneys.items[1],mid={x:2.346412,y:9.235337};
 assert.equal(r.state.base.faces.length,2,'house and detached wing, no separate chimney base');
 assert.ok(!r.state.base.faces.some(f=>f.chimneyFoundation));
 assert.ok(C.buildingBase(r.state).some(f=>G.contains(f,mid)),'the former pocket belongs to the house');
 assert.ok(r.state.base.chimneyFoundationParts.some(f=>f.chimneyFoundation===c.id));
 assert.ok(K.union(r.state.base.faces).every(f=>!f.holes.length));
 const before=JSON.stringify(r.state.base);C.syncFoundation(r.state);assert.equal(JSON.stringify(r.state.base),before,'redraw does not recreate the seam');
 assert.equal(JSON.stringify(fixture),original);
});
function synthetic({width=.1,open=false,roofHole=false}={}){
 const p=(x,y,z=0)=>({x,y,z}),points=[p(0,0),p(4,0),p(4,1),p(4-width,1),p(4-width,2),p(4,2),p(4,3),p(0,3)],walls=points.map((a,i)=>({id:'w'+i,kind:'perimeter',bottom:[a,points[(i+1)%points.length]],top:[a,points[(i+1)%points.length]].map(p=>({...p,z:4}))}));
 const roof={faces:[{points:[p(-1,-1,5),p(6,-1,5),p(6,4,5),p(-1,4,5)],holes:roofHole?[[p(4-width,1,5),p(4,1,5),p(4,2,5),p(4-width,2,5)]]:[]}]},grade={points:[p(-10,-10),p(10,-10),p(10,10),p(-10,10)],faces:[[0,1,2,3]]},chimneys={items:[{id:'c',points:[p(4,open?1.2:.5,5),p(5,open?1.2:.5,5),p(5,open?1.8:2.5,5),p(4,open?1.8:2.5,5)]}]};
 return {base:B.fromRoof(roof,grade,walls,.9144,chimneys),mid:p(4-width/2,1.5)};
}
for(const [name,options,filled]of [['small enclosed pocket',{},true],['wide courtyard',{width:.3},false],['open gap',{open:true},false],['roof opening',{roofHole:true},false]])test(name,()=>{const {base,mid}=synthetic(options);assert.equal(base.faces.some(f=>G.contains(f,mid)),filled);});
