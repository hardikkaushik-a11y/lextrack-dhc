const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {webcrypto}=require('node:crypto');
const html=fs.readFileSync(path.join(__dirname,'../LexTrack-IPR-App.html'),'utf8');
function context(){
 const values=new Map();
 const c={crypto:webcrypto,TextEncoder,URL,structuredClone,console,document:{addEventListener(){}},localStorage:{getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v)},escapeCaseChatHtml:s=>String(s).replace(/[<>&]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]))};
 vm.createContext(c);
 for(const name of ['DOCUMENT EVIDENCE','HEARING TEMPLATES']){
  const start=html.indexOf('// BEGIN LEXTRACK '+name),end=html.indexOf('// END LEXTRACK '+name,start);assert.ok(start>=0&&end>start);vm.runInContext(html.slice(start,end),c);
 }
 return c;
}
const plain=x=>JSON.parse(JSON.stringify(x));
test('every inline script remains syntactically valid',()=>{
 for(const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi))new vm.Script(script[1]);
});
test('only an exact quote from a supplied source creates a clickable reference',()=>{
 const c=context(),pack={sources:[{id:'S1',text:'A verified passage in this selected document.'}]};
 const valid=c.validateCaseChatReply(JSON.stringify({answer:'The document contains this statement [1].',citations:[{marker:'1',sourceId:'S1',quote:'verified passage in this selected document'}]}),pack);assert.equal(valid.citations.length,1);
 for(const bad of [{sourceId:'S2',quote:'verified passage in this selected document'},{sourceId:'S1',quote:'This quote was invented by the assistant.'},{sourceId:'S1',quote:'short'}]){
  const result=c.validateCaseChatReply(JSON.stringify({answer:'A claim [1].',citations:[{marker:'1',...bad}]}),pack);assert.equal(result.citations.length,0);assert.ok(result.citationWarnings.length);
 }
 assert.equal(c.validateCaseChatReply('Unstructured old response [1]',pack).citations.length,0);
 assert.equal(c.validateCaseChatReply(JSON.stringify({answer:'A malformed reference [1].',citations:[null]}),pack).citations.length,0);
 assert.throws(()=>c.validateCaseChatReply('null',pack),/returned no answer/);
});
test('cached document text is reused only while its actual file hash matches',async()=>{
 const c=context();c.LEXTRACK_DB_STORE='files';let record={id:'sample',name:'Memo.txt',type:'text/plain',blob:new Blob(['Original document wording.']),evidenceVersion:1,evidencePages:[{page:null,text:'Original document wording.'}]};
 record.contentHash=await c.lexEvidenceHash(await record.blob.arrayBuffer());
 c.lexDocReadRecord=async()=>record;let writes=0;
 c.lexDbOpen=async()=>({close(){},transaction(){const tx={objectStore:()=>({put:r=>{record=r;writes++;queueMicrotask(()=>tx.oncomplete());}})};return tx;}});
 assert.equal(await c.lexDocGetEvidence('sample'),record);assert.equal(writes,0);
 record.blob=new Blob(['Replacement document wording.']);
 const refreshed=await c.lexDocGetEvidence('sample');assert.equal(refreshed.evidencePages[0].text,'Replacement document wording.');assert.equal(writes,1);
 assert.equal(await c.lexDocGetEvidence('sample'),refreshed);assert.equal(writes,1);
});
test('the citation prompt retains existing case metadata while exposing its reading limits',async()=>{
 const c=context();c.analyseOrderCadence=()=>({label:'Regular',avgGap:14});
 const timeline=Array.from({length:21},(_,i)=>({date:`2026-09-${String(i+1).padStart(2,'0')}`,orderText:'Order text',detail:'Dated order summary'}));
 const prompt=await c.buildCaseChatSystemPrompt({title:'Sample matter',caseNo:'SYNTHETIC/1',type:'trademark',client:'Sample client',lastDate:'2026-09-21',docs:[],timeline,causelist:[{date:'2026-10-25',time:'10:30'}]}, {coverage:[],context:''});
 for(const retained of ['Sample client','trademark','2026-09-21','10:30','Dated order summary','full text omitted','Return only JSON'])assert.ok(prompt.includes(retained));
 assert.ok(!prompt.includes('You have read every order'));
});
test('document budgeting preserves page identity and exposes unreadable pages',()=>{
 const c=context(),result=c.lexPackEvidencePages({evidencePages:[{page:1,text:'a'.repeat(2000)},{page:2,text:'b'.repeat(2000)},{page:3,text:''}]},3000);
 assert.equal(result.total,4000);assert.equal(result.included,3000);assert.equal(result.unreadablePages,1);assert.equal(result.chunks[1].page,2);assert.equal(result.chunks[1].text.length,1000);
});
test('reference rendering and original links cannot introduce markup or script URLs',()=>{
 const c=context();const rendered=c.renderCaseChatMd('<script>bad()</script> [1]',[{marker:'1',quote:'Any known source phrase',source:{id:'S1'}}]);
 assert.ok(rendered.includes('&lt;script&gt;'));assert.ok(rendered.includes('data-citation-key'));assert.ok(!rendered.includes('<script>'));
 assert.equal(c.lexSafeSourceUrl('javascript:alert(1)'), '');assert.equal(c.lexSafeSourceUrl('https://example.org/order.pdf'),'https://example.org/order.pdf');
});
test('preparation arithmetic handles month/year/leap boundaries without timezone offsets',()=>{
 const c=context();assert.equal(c.lexPreparationDate('2027-01-01',-1),'2026-12-31');assert.equal(c.lexPreparationDate('2028-03-01',-1),'2028-02-29');assert.equal(c.lexPreparationDate('2026-03-01',-1),'2026-02-28');assert.equal(c.lexPreparationDate('2026-10-25',null),null);assert.equal(c.lexValidIsoDate('2026-02-30'),false);
});
test('applying a template again preserves completed tasks and overridden dates',()=>{
 const c=context(),t=plain(c.loadHearingTemplates()[0]),hearing='2026-10-25';
 const rows=plain(c.hearingChecklistRows(t,hearing,[])).map(x=>({...x,selected:true}));
 rows[0].due='2026-10-20';rows[1].due=null;
 const first=plain(c.createHearingChecklistTasks(t,hearing,rows,[]));assert.equal(first.length,4);assert.equal(first[0].due,'2026-10-20');assert.equal(first[1].due,null);first[0].done=true;
 const before=JSON.stringify(first);assert.equal(c.createHearingChecklistTasks(t,hearing,rows,first).length,0);assert.equal(JSON.stringify(first),before);
 const edited={...t,version:2,steps:[...t.steps,{id:'new-step',title:'Additional preparation',offsetDays:-1,priority:'Low'}]};
 const newer=plain(c.hearingChecklistRows(edited,hearing,first)).map(x=>({...x,selected:true}));const added=plain(c.createHearingChecklistTasks(edited,hearing,newer,first));assert.equal(added.length,1);assert.equal(added[0].prepTemplateVersion,2);assert.equal(first[0].due,'2026-10-20');assert.equal(first[0].done,true);
 assert.equal(c.createHearingChecklistTasks(t,'2026-11-02',rows,first).length,4);
});
test('invalid templates/dates and unavailable storage fail without silently saving',()=>{
 const c=context(),t=plain(c.loadHearingTemplates()[0]);assert.equal(c.validHearingTemplate({...t,steps:[]}),false);assert.equal(c.validHearingTemplate({...t,steps:[{...t.steps[0],offsetDays:-1.5}]}),false);
 assert.throws(()=>c.createHearingChecklistTasks(t,'2026-02-30',[],[]));
 c.localStorage.setItem=()=>{throw new Error('quota')};assert.equal(c.saveHearingTemplateRecord(t),false);
 c.localStorage.getItem=()=>'{broken';assert.equal(c.loadHearingTemplates().length,1);
});
