"use client";
import { ReinPricing } from "./rein-pricing";
import { useCallback, useEffect, useRef, useState } from 'react';

async function request(token, params={}, body) {
 const response=await fetch(`/api/support-chat?${new URLSearchParams(params)}`,{method:body?'POST':'GET',headers:{...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(20000)});
 const data=await response.json();
 if (!response.ok||!data.ok) throw Error(data.error||'通信できませんでした。再試行してください。');
 return data;
}
async function prepareImage(file) {
 if (!/^image\/(jpeg|png|webp)$/.test(file.type)||file.size>20000000) throw Error('20MB以内のJPEG・PNG・WebP画像を選んでください。');
 const bitmap=await createImageBitmap(file);
 try {
  const scale=Math.min(1,1600/Math.max(bitmap.width,bitmap.height));
  const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));
  const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);
  const data=canvas.toDataURL('image/jpeg',0.78);
  if(data.length>1400000) throw Error('画像が大きすぎます。小さい画像を選んでください。');
  return data;
 } finally {bitmap.close();}
}
function ChatImage({id,token,email}) {
 const [image,setImage]=useState('');const [error,setError]=useState('');const [busy,setBusy]=useState(false);
 return image?<a href={image} target="_blank" rel="noreferrer"><img src={image} alt="添付画像" style={{maxWidth:'100%',maxHeight:320,borderRadius:8}} /></a>:<><button type="button" disabled={busy} onClick={async()=>{setBusy(true);try{const data=await request(token,{email,image:id});setImage(data.image);}catch(e){setError(e.message);}finally{setBusy(false);}}}>{busy?'読込中…':'📷 添付画像を表示'}</button>{error&&<span role="alert">{error}</span>}</>;
}
export default function ReinSupportChatBox(props) {return <ReinChatBox key={props.email||'signed-out'} {...props}/>;}
function ReinChatBox({token,email,theme}) {
 const [open,setOpen]=useState(false),[admin,setAdmin]=useState(false),[threads,setThreads]=useState([]),[unread,setUnread]=useState(0);
 const [selected,setSelected]=useState(''),[recipient,setRecipient]=useState(''),[conversation,setConversation]=useState({messages:[],read:{},hasMore:false,email:''});
 const [message,setMessage]=useState(''),[image,setImage]=useState(null),[sending,setSending]=useState(false),[processing,setProcessing]=useState(false),[loading,setLoading]=useState(false),[error,setError]=useState('');
 const section=useRef(null),end=useRef(null),submission=useRef(null),busy=useRef(false),generation=useRef(0),reading=useRef('');
 const target=admin?selected:email;
 const light=theme==='light';
 const c=light?{bg:'#fff',field:'#f1f5f9',text:'#18332d',muted:'#526475',border:'#c6d7df',bubble:'#e6f4ef'}:{bg:'#13243a',field:'#0d1b2c',text:'#eff7ff',muted:'#aec1d5',border:'#315371',bubble:'#214b5c'};
 const field={width:'100%',boxSizing:'border-box',background:c.field,color:c.text,border:`1px solid ${c.border}`,borderRadius:8,padding:10,fontSize:16,fontFamily:'inherit'};
 const refreshInbox=useCallback(async()=>{
  const data=await request(token,{mode:'inbox'});setAdmin(data.admin);setThreads(data.threads);setUnread(data.unread);
 },[token]);
 useEffect(()=>{
  if(!token)return undefined;
  let active=true,timer;
  const poll=async()=>{if(document.visibilityState==='visible'){try{const d=await request(token,{mode:'inbox'});if(active){setAdmin(d.admin);setThreads(d.threads);setUnread(d.unread);}}catch(e){if(active)setError(e.message);}}if(active)timer=setTimeout(poll,60000);};
  const focus=()=>{clearTimeout(timer);void poll();};void poll();window.addEventListener('focus',focus);
  return()=>{active=false;clearTimeout(timer);window.removeEventListener('focus',focus);};
 },[token]);
 useEffect(()=>{
  const gen=++generation.current;setConversation({messages:[],read:{},email:target,hasMore:false});reading.current='';
  if(!open||!token||!target)return undefined;
  let active=true,timer;setLoading(true);
  const poll=async()=>{
   if(document.visibilityState==='visible')try{const d=await request(token,{email:target});if(active&&generation.current===gen){setConversation(v=>({...d,messages:[...v.messages.filter(m=>m.id<d.messages[0]?.id),...d.messages],hasMore:v.messages.length>d.messages.length?v.hasMore:d.hasMore}));setError('');}}catch(e){if(active)setError(e.message);}finally{if(active)setLoading(false);}
   if(active)timer=setTimeout(poll,15000);
  };
  const focus=()=>{clearTimeout(timer);void poll();};void poll();window.addEventListener('focus',focus);
  return()=>{active=false;clearTimeout(timer);window.removeEventListener('focus',focus);};
 },[open,target,token]);
 const latest=conversation.messages.at(-1)?.id;
 useEffect(()=>{
  if(!open||!latest||conversation.email!==target||document.visibilityState!=='visible')return;
  end.current?.scrollIntoView({block:'nearest'});
  const key=`${target}:${latest}`;if(reading.current===key)return;reading.current=key;
  let active=true;
  request(token,{}, {action:'read',email:target,id:latest}).then(()=>{if(active)void refreshInbox().catch(()=>{});}).catch(e=>{if(active){reading.current='';setError(e.message);}});
  return()=>{active=false;};
 },[open,latest,target,token,conversation.email,refreshInbox]);
 const reveal=()=>{setOpen(true);if(admin&&!selected&&threads[0])setSelected(threads[0].email);setTimeout(()=>section.current?.scrollIntoView({block:'start',behavior:'smooth'}),50);};
 const edit=()=>{submission.current=null;};
 const send=async event=>{
  event.preventDefault();if(busy.current||processing||!target||(!message.trim()&&!image))return;
  busy.current=true;setSending(true);setError('');const gen=generation.current;
  try{
   if(!submission.current)submission.current={requestId:crypto.randomUUID(),message:message.trim(),image,email:target};
   await request(token,{},submission.current);
   if(gen===generation.current){setMessage('');setImage(null);submission.current=null;const d=await request(token,{email:target});if(gen===generation.current)setConversation(d);}
   await refreshInbox();
  }catch(e){setError(e.message);}finally{busy.current=false;setSending(false);}
 };
 const older=async()=>{setLoading(true);const gen=generation.current;try{const d=await request(token,{email:target,before:conversation.messages[0].id});if(gen===generation.current)setConversation(v=>({...v,messages:[...d.messages,...v.messages],hasMore:d.hasMore}));}catch(e){setError(e.message);}finally{setLoading(false);}};
 return <section ref={section} aria-label="運営との個別チャット" style={{marginBottom:14,border:`1px solid ${c.border}`,borderRadius:12,background:c.bg,color:c.text,overflow:'hidden',scrollMarginTop:80}}>
  {unread>0&&!open&&<button type="button" onClick={reveal} style={{position:'fixed',top:12,left:'50%',transform:'translateX(-50%)',width:'min(92vw,480px)',zIndex:9999,padding:14,border:0,borderRadius:12,background:'#b42335',color:'#fff',fontWeight:800,boxShadow:'0 4px 18px #0005'}}>{admin?'利用者から新しいメッセージがあります':'運営から返信があります'}（{unread}件） タップして確認</button>}
  <button type="button" aria-expanded={open} aria-controls="rein-support-chat-form" onClick={()=>open?setOpen(false):reveal()} style={{width:'100%',padding:15,background:'transparent',color:c.text,border:0,textAlign:'left',fontSize:14,fontWeight:800,cursor:'pointer'}}>💬 {admin?'運営チャット・管理画面':'ご意見・お問い合わせ（運営チャット）'} {unread>0&&<span style={{background:'#b42335',color:'#fff',borderRadius:14,padding:'2px 8px'}}>{unread}</span>} <span style={{float:'right'}}>{open?'−':'＋'}</span></button>
  {open&&<div id="rein-support-chat-form" style={{padding:14,paddingTop:0}}>
   <p style={{fontSize:12,color:c.muted,lineHeight:1.8}}>本人と運営だけが見られる個別チャットです。文章や画像を送れます。返信はこの画面でご確認ください。</p>
   {admin&&<div style={{display:'grid',gap:8,marginBottom:12}}>
    <label>会話を選択<select style={field} value={selected} disabled={sending||processing} onChange={e=>{setSelected(e.target.value);setMessage('');setImage(null);edit();}}><option value="">選択してください</option>{threads.map(t=><option key={t.email} value={t.email}>{Number(t.admin_unread)>0?`🔴 ${t.admin_unread}件 `:''}{t.email} — {t.preview||'画像'}</option>)}</select></label>
    <div style={{display:'flex',gap:6}}><input aria-label="新規送信先メールアドレス" type="email" placeholder="新規送信先の会員メールアドレス" style={field} value={recipient} disabled={sending||processing} onChange={e=>setRecipient(e.target.value)}/><button type="button" disabled={sending||processing||!recipient.includes('@')} onClick={()=>{const next=recipient.trim().toLowerCase();setThreads(v=>v.some(t=>t.email===next)?v:[{email:next,preview:'新しい会話'},...v]);setSelected(next);setMessage('');setImage(null);edit();setRecipient('');}}>開く</button></div>
   </div>}
   <ReinPricing />
   {target&&<>
    <div role="log" aria-label="会話履歴" aria-live="polite" style={{maxHeight:'55vh',minHeight:130,overflowY:'auto',padding:10,background:c.field,borderRadius:10}}>
     {conversation.hasMore&&<button type="button" disabled={loading} onClick={older}>以前のメッセージを表示</button>}
     {loading&&conversation.messages.length===0?<p role="status">読み込み中…</p>:conversation.messages.length===0?<p style={{fontSize:13,color:c.muted}}>ご質問やご要望を下の欄からお送りください。</p>:null}
     {conversation.messages.map(m=>{const mine=m.sender===(admin?'admin':'user');const seen=Number(admin?conversation.read.user_read_id:conversation.read.admin_read_id)>=Number(m.id);return <article key={m.id} style={{margin:'10px 0',marginLeft:mine?'10%':0,marginRight:mine?0:'10%',padding:12,background:mine?c.bubble:c.bg,borderRadius:12,overflowWrap:'anywhere'}}>
      <div style={{fontSize:11,fontWeight:800,color:c.muted}}>{m.sender==='admin'?'REIN運営':admin?target:'あなた'}</div>
      {m.body&&<p style={{whiteSpace:'pre-wrap',fontSize:14,lineHeight:1.8,margin:'5px 0'}}>{m.body}</p>}
      {m.has_image&&<ChatImage key={`${target}:${m.id}`} id={m.id} email={target} token={token}/>}
      <div style={{fontSize:10,color:c.muted,marginTop:6}}>{new Date(m.created_at).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'})} {mine?(seen?'既読':'未読'):''}</div>
     </article>;})}<div ref={end}/>
    </div>
    <form onSubmit={send} aria-busy={sending||processing} style={{marginTop:12}}>
     <label htmlFor="rein-support-chat-message" style={{fontSize:12}}>メッセージ</label>
     <textarea id="rein-support-chat-message" rows={4} maxLength={2000} style={{...field,resize:'vertical',lineHeight:1.7}} placeholder="お問い合わせ内容を入力してください" disabled={sending} value={message} onChange={e=>{setMessage(e.target.value);edit();}}/>
     <div style={{fontSize:11,color:c.muted,textAlign:'right'}}>{message.length} / 2,000文字</div>
     <label style={{display:'block',fontSize:12,margin:'8px 0'}}>📷 画像を添付（1枚・自動で縮小）<input type="file" accept="image/jpeg,image/png,image/webp" disabled={sending||processing} onChange={async e=>{const f=e.target.files?.[0];e.target.value='';if(!f)return;setProcessing(true);setError('');try{setImage(await prepareImage(f));edit();}catch(err){setError(err.message);}finally{setProcessing(false);}}}/></label>
     {image&&<div><img src={image} alt="送信前の添付画像" style={{maxWidth:'100%',maxHeight:180}}/><button type="button" disabled={sending} onClick={()=>{setImage(null);edit();}}>画像を外す</button></div>}
     <button type="submit" disabled={sending||processing||(!message.trim()&&!image)} style={{width:'100%',border:0,borderRadius:9,padding:12,background:'#286fa4',color:'#fff',fontWeight:800,cursor:'pointer'}}>{processing?'画像を準備中…':sending?'送信中…':admin?'運営から返信する':'運営に送信する'}</button>
    </form>
   </>}
   {error&&<p role="alert" style={{color:light?'#b42318':'#ffb5ab',fontSize:12}}>{error}</p>}
  </div>}
 </section>;
}
