const fail=(message,status=400)=>Object.assign(new Error(message),{status});
export function chatInput(body) {
 const text = typeof body?.message==='string' ? body.message.trim() : '';
 if (text.length>2000 || text.includes('\0') || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(body?.requestId||''))) throw fail('本文は2,000文字以内で入力してください。');
 const image = body.image || null;
 if (image) {
  if (typeof image!=='string' || image.length>1400000 || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/.test(image)) throw fail('画像は1MB以内のJPEG・PNG・WebPを選択してください。');
  const bytes = Buffer.from(image.split(',')[1],'base64');
  const valid = image.startsWith('data:image/jpeg;') ? bytes[0]===255 && bytes[1]===216 && bytes[2]===255 : image.startsWith('data:image/png;') ? bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : bytes.toString('ascii',0,4)==='RIFF' && bytes.toString('ascii',8,12)==='WEBP';
  if (!valid || bytes.length>1048576) throw fail('画像形式を確認してください。');
 }
 if (!text && !image) throw fail('メッセージか画像を入力してください。');
 return {text,image};
}
export async function chatAction({member,admin,query,rpc},method,params={},body={}) {
 if(!member?.email) throw fail('ログインしてください。',401);
 const requested=method==='POST'?body.email:params.email;
 const email=admin&&requested?String(requested).trim().toLowerCase():member.email;
 if(!/^[^\s@,()]+@[^\s@,()]+\.[^\s@,()]+$/.test(email)||email.length>254) throw fail('送信先を確認してください。');
 if(method==='POST') {
  if(body.action==='read') {
   const id=Number(body.id);if(!Number.isSafeInteger(id)||id<1)throw fail('既読情報を確認できません。');
   await rpc('rein_chat_read',{p_email:email,p_admin:admin,p_id:id});
  } else {
   const {text,image}=chatInput(body);
   if(admin){const rows=await query('rein_memberships',{select:'google_email',normalized_email:`eq.${email}`,limit:'1'});if(!rows.length)throw fail('REIN会員が見つかりません。',404);}
   await rpc('rein_chat_send',{p_email:email,p_sender:admin?'admin':'user',p_request_id:body.requestId,p_body:text,p_image:image});
  }
  return {ok:true};
 }
 if(params.image){if(!/^\d+$/.test(String(params.image)))throw fail('画像が見つかりません。',404);const rows=await query('rein_chat_messages',{select:'image_data',email:`eq.${email}`,id:`eq.${params.image}`,limit:'1'});if(!rows[0]?.image_data)throw fail('画像が見つかりません。',404);return {ok:true,image:rows[0].image_data};}
 if(params.mode==='inbox'){
  const filters={select:'*',order:'last_message_at.desc',limit:'500'};if(!admin)filters.email=`eq.${member.email}`;
  const threads=await query('rein_chat_inbox',filters);
  return {ok:true,admin,email:member.email,threads,unread:threads.reduce((n,t)=>n+Number(admin?t.admin_unread:t.user_unread),0)};
 }
 const filters={select:'id,sender,body,created_at,has_image',email:`eq.${email}`,order:'id.desc',limit:'50'};
 if(params.before&&/^\d+$/.test(String(params.before)))filters.id=`lt.${params.before}`;
 const [messages,threads]=await Promise.all([query('rein_chat_message_list',filters),query('rein_chat_inbox',{select:'user_read_id,admin_read_id',email:`eq.${email}`,limit:'1'})]);
 return {ok:true,admin,email,messages:messages.reverse(),read:threads[0]||{},hasMore:messages.length===50};
}
