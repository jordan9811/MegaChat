import { spawn } from 'child_process';
import puppeteer from 'puppeteer-core';
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const PORT=3271, APP=`http://localhost:${PORT}`;
const app=spawn(process.execPath,['server.js','--prod'],{env:{...process.env,PORT:String(PORT),
 LIVEKIT_URL:'ws://localhost:7880',LIVEKIT_API_KEY:'devkey',LIVEKIT_API_SECRET:'secret',
 DATA_DIR:`${process.env.TEMP}/two-${Date.now()}`},stdio:'ignore',cwd:process.cwd()});
await sleep(14000);
const b=await puppeteer.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:'new',protocolTimeout:120000});
try{
 const room=await fetch(`${APP}/api/dashboard/create`,{method:'POST',headers:{'Content-Type':'application/json'},
   body:JSON.stringify({name:'Two',password:'pass1234',config:{transport:'livekit',passkeyTickPrice:'0'}})}).then(r=>r.json()).then(d=>{if(!d.room)console.log("create failed:",JSON.stringify(d).slice(0,200));return d.room;});
 const mk=async(label)=>{const p=await b.newPage();
   await p.goto(`${APP}/overlay?room=${room.id}`,{waitUntil:'networkidle2',timeout:60000});return p;};
 const o1=await mk('A');
 await fetch(`${APP}/api/livekit/prewarm`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({room:room.id})});
 await sleep(7000);
 const o2=await mk('B');            // SECOND overlay — the OBS-goes-black scenario
 await sleep(9000);
 const st=async(p)=>p.evaluate(()=>{
   const r=(typeof lkOverlayRoom!=='undefined'&&lkOverlayRoom)||null;
   return {state:r?r.state:'none',identity:r?r.localParticipant?.identity:null,
           pin:document.getElementById('lk-status')?.dataset.state};});
 const a=await st(o1), c=await st(o2);
 console.log('overlay #1 (the OBS source):',JSON.stringify(a));
 console.log('overlay #2 (a second tab)  :',JSON.stringify(c));
 console.log();
 console.log('distinct identities :', a.identity!==c.identity);
 console.log('#1 STILL CONNECTED  :', a.state==='connected', a.state==='connected'?'<- fix works, OBS survives':'<- STILL BROKEN');
 console.log('#2 connected        :', c.state==='connected');
}finally{await b.close();app.kill();}
