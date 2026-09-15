function renderExteriorReportConfig(container,state){
 const m=state.exteriorReport,s=state.exteriorSettings||={};container.style.padding='24px';
 const heading=document.createElement('h2');heading.textContent='Exterior report';container.appendChild(heading);
 const summary=document.createElement('p');summary.textContent=`${m.walls.length} wall regions / ${m.openings.length} openings / ${m.totals.net.toFixed(1)} sq ft net. The PDF includes 3D views, elevations, dimensions, schedules and quantities.`;container.appendChild(summary);
 const toggle=document.createElement('label'),input=document.createElement('input');input.type='checkbox';input.checked=s.include!==false;input.onchange=()=>{s.include=input.checked;};toggle.append(input,document.createTextNode(' Include exterior pages in full PDF'));container.appendChild(toggle);
 const hint=document.createElement('p');hint.textContent='Materials come from the 3D material paint tool. Split faces and paint each section there, then reopen Config to refresh the report.';container.appendChild(hint);
 const table=document.createElement('table');table.style.cssText='width:100%;font-size:12px;border-collapse:collapse';const head=table.insertRow();['Wall','Elevation','Net sq ft','Material'].forEach(t=>{const th=document.createElement('th');th.textContent=t;th.style.textAlign='left';head.appendChild(th);});
 m.walls.forEach(w=>{const row=table.insertRow();[w.id+(w.chimney?' (chimney)':''),w.elevation,w.net.toFixed(1)].forEach(t=>row.insertCell().textContent=t);row.insertCell().textContent=w.material||'Unassigned';});container.appendChild(table);
 const notes=document.createElement('textarea');notes.placeholder='Exterior report notes';notes.maxLength=600;notes.value=s.notes||'';notes.style.cssText='width:100%;min-height:80px;margin-top:16px';notes.oninput=()=>{s.notes=notes.value;};container.appendChild(notes);
}
